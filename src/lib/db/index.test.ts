/** getDb()'s process-wide state against an embedded PGlite directory: sharing, retries, locking. */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PGLITE_LOCK_FILE } from "./pglite-lock";

const failures = vi.hoisted(() => ({ migrate: 0, migrateCalls: 0 }));
vi.mock("drizzle-orm/pglite/migrator", async (importOriginal) => {
  const real = await importOriginal<typeof import("drizzle-orm/pglite/migrator")>();
  return {
    ...real,
    migrate: vi.fn(async (...args: Parameters<typeof real.migrate>) => {
      failures.migrateCalls++;
      if (failures.migrate > 0) {
        failures.migrate--;
        throw new Error("transient: connection reset");
      }
      return real.migrate(...args);
    }),
  };
});

let dir: string;
let other: ChildProcess;

beforeAll(async () => {
  other = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120_000)"], { stdio: "ignore" });
  await new Promise((resolve, reject) => other.once("spawn", resolve).once("error", reject));
});
afterAll(() => {
  other.kill();
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-getdb-"));
  vi.stubEnv("DATABASE_URL", "");
  vi.stubEnv("PGLITE_DIR", dir);
  failures.migrate = 0;
  failures.migrateCalls = 0;
});
afterEach(async () => {
  const { closeDb } = await import("./index");
  await closeDb();
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("getDb", () => {
  it("retries migrations after a failed attempt instead of caching the failure", async () => {
    const { getDb } = await import("./index");
    failures.migrate = 1;
    await expect(getDb()).rejects.toThrow("transient");
    const db = await getDb();
    expect(db).toBe(await getDb());
    expect(failures.migrateCalls).toBe(2);
  });

  it("retries opening after the directory was locked by another process", async () => {
    const { getDb, PgliteLockedError } = await import("./index");
    const lockFile = path.join(dir, PGLITE_LOCK_FILE);
    fs.writeFileSync(lockFile, JSON.stringify({ pid: other.pid, hostname: os.hostname(), since: new Date().toISOString() }));
    await expect(getDb()).rejects.toBeInstanceOf(PgliteLockedError);
    await expect(getDb()).rejects.toBeInstanceOf(PgliteLockedError);

    fs.rmSync(lockFile); // the other process stopped
    await expect(getDb()).resolves.toBeDefined();
    expect(JSON.parse(fs.readFileSync(lockFile, "utf8")).pid).toBe(process.pid);
  });

  it("shares one client across module copies (Next.js bundles) and releases the lock on close", async () => {
    const first = await import("./index");
    vi.resetModules();
    const second = await import("./index");
    expect(second).not.toBe(first);
    expect(second.getDb).not.toBe(first.getDb);

    const [a, b] = await Promise.all([first.getDb(), second.getDb()]);
    expect(a).toBe(b);
    expect(failures.migrateCalls).toBe(1);

    await second.closeDb();
    expect(fs.existsSync(path.join(dir, PGLITE_LOCK_FILE))).toBe(false);
  });
});
