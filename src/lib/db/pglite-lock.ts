/**
 * Exclusive ownership of an embedded PGlite data directory. PGlite runs Postgres inside the process
 * that opens it, so a second process on the same directory (the web app plus `npm run worker` or
 * `npm run db:seed`) works on its own copy of the data and silently loses writes. A lock file in the
 * directory makes the second process fail fast instead.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PGLITE_LOCK_FILE = "flipwatch.lock";

export interface PgliteLockOwner {
  pid: number;
  hostname: string;
  /** ISO timestamp of when the lock was taken. */
  since: string;
}

export class PgliteLockedError extends Error {
  constructor(
    readonly dir: string,
    readonly owner: PgliteLockOwner | null,
  ) {
    const holder = owner
      ? `process ${owner.pid}${owner.hostname === os.hostname() ? "" : ` on ${owner.hostname}`} (since ${owner.since})`
      : "another process";
    super(
      `The embedded database in ${dir} is already in use by ${holder}. PGlite can only be opened by one ` +
        "process at a time: stop that process first (usually the running app — stop it before npm run db:seed " +
        "or db:migrate), or set DATABASE_URL to use Postgres. " +
        `If nothing is using it any more, delete ${path.join(dir, PGLITE_LOCK_FILE)}.`,
    );
    this.name = "PgliteLockedError";
  }
}

function readOwner(file: string): PgliteLockOwner | null {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<PgliteLockOwner> | null;
    if (typeof value?.pid !== "number" || typeof value.hostname !== "string") return null;
    return { pid: value.pid, hostname: value.hostname, since: String(value.since) };
  } catch {
    return null;
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to another user.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * A lock left behind by a process that is gone. getDb() never opens the directory twice in one
 * process, so a lock carrying our own pid is from an earlier process that had the same pid (typical
 * after a container restart). Processes on another host or container can't be checked: assume alive.
 */
function isStale(owner: PgliteLockOwner): boolean {
  if (owner.hostname !== os.hostname()) return false;
  return owner.pid === process.pid || !isRunning(owner.pid);
}

function tryCreate(file: string, owner: PgliteLockOwner): boolean {
  try {
    fs.writeFileSync(file, JSON.stringify(owner), { flag: "wx" });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

/**
 * Take the directory's lock or throw PgliteLockedError. Returns a release function, which also runs
 * when the process exits normally; a lock left by a crash is detected as stale and taken over.
 */
export function lockPgliteDir(dir: string): () => void {
  const file = path.join(dir, PGLITE_LOCK_FILE);
  const owner: PgliteLockOwner = { pid: process.pid, hostname: os.hostname(), since: new Date().toISOString() };
  if (!tryCreate(file, owner)) {
    const current = readOwner(file);
    // An unreadable lock may be one being written right now: never take it over automatically.
    // (No file at all means its owner just released it.)
    if (current ? !isStale(current) : fs.existsSync(file)) throw new PgliteLockedError(dir, current);
    fs.rmSync(file, { force: true });
    if (!tryCreate(file, owner)) throw new PgliteLockedError(dir, readOwner(file));
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    process.off("exit", release);
    const current = readOwner(file);
    if (current?.pid === owner.pid && current.since === owner.since) fs.rmSync(file, { force: true });
  };
  process.on("exit", release);
  return release;
}
