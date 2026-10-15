import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGLITE_LOCK_FILE, PgliteLockedError, lockPgliteDir } from "./pglite-lock";

let dir: string;
let lockFile: string;
/** A running process other than this one, standing in for the app that holds the directory. */
let other: ChildProcess;

beforeAll(async () => {
  other = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120_000)"], { stdio: "ignore" });
  await new Promise((resolve, reject) => other.once("spawn", resolve).once("error", reject));
});
afterAll(() => {
  other.kill();
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-pglite-lock-"));
  lockFile = path.join(dir, PGLITE_LOCK_FILE);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const writeLock = (content: object | string) =>
  fs.writeFileSync(lockFile, typeof content === "string" ? content : JSON.stringify(content));
const readLock = () => JSON.parse(fs.readFileSync(lockFile, "utf8")) as { pid: number; hostname: string; since: string };
const here = { hostname: os.hostname(), since: "2026-09-28T10:00:00.000Z" };

describe("lockPgliteDir", () => {
  it("records this process as the owner and removes the lock on release", () => {
    const release = lockPgliteDir(dir);
    expect(readLock()).toMatchObject({ pid: process.pid, hostname: os.hostname() });
    release();
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it("refuses a directory another running process holds, telling the user what to do", () => {
    writeLock({ pid: other.pid, ...here });
    let error: unknown;
    try {
      lockPgliteDir(dir);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(PgliteLockedError);
    expect((error as Error).message).toContain(`already in use by process ${other.pid}`);
    expect((error as Error).message).toMatch(/stop that process first .*DATABASE_URL/);
    expect(readLock().pid).toBe(other.pid);
  });

  it("takes over a lock left by a process that has exited", () => {
    const exited = spawnSync(process.execPath, ["-e", ""]).pid;
    writeLock({ pid: exited, ...here });
    const release = lockPgliteDir(dir);
    expect(readLock().pid).toBe(process.pid);
    release();
  });

  it("takes over a lock carrying its own pid (left by an earlier process with the same pid, e.g. before a container restart)", () => {
    writeLock({ pid: process.pid, ...here });
    const release = lockPgliteDir(dir);
    expect(readLock().since).not.toBe(here.since);
    release();
  });

  it("respects locks from another host, whose processes it can't check", () => {
    writeLock({ pid: process.pid, hostname: `not-${os.hostname()}`, since: here.since });
    expect(() => lockPgliteDir(dir)).toThrow(/in use by process \d+ on not-/);
  });

  it("never takes over an unreadable lock (it may be being written right now)", () => {
    writeLock("");
    expect(() => lockPgliteDir(dir)).toThrow(/in use by another process/);
  });

  it("does not delete a lock someone else took over in the meantime", () => {
    const release = lockPgliteDir(dir);
    writeLock({ pid: other.pid, ...here });
    release();
    expect(readLock().pid).toBe(other.pid);
  });

  it("releases the lock when the process exits", () => {
    const script = [
      `require(${JSON.stringify(path.join(import.meta.dirname, "pglite-lock.ts"))}).lockPgliteDir(${JSON.stringify(dir)});`,
      `console.log(require("node:fs").existsSync(${JSON.stringify(lockFile)}));`,
      "process.exit(3);",
    ].join("\n");
    const child = spawnSync(process.execPath, ["--import", "tsx", "-e", script], { encoding: "utf8" });
    expect(child.status, child.stderr).toBe(3);
    expect(child.stdout.trim()).toBe("true");
    expect(fs.existsSync(lockFile)).toBe(false);
  });
});
