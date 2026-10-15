import path from "node:path";
import fs from "node:fs";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { config } from "../config";
import { loadRuntimeSettings, runtimeSettingsLoaded } from "../runtime-settings";
import { lockPgliteDir } from "./pglite-lock";
import * as schema from "./schema";

export { schema };
export { PgliteLockedError } from "./pglite-lock";

/**
 * Driver-agnostic database handle. Works with both the embedded PGlite driver (local/dev/tests)
 * and postgres-js (production / Supabase). Use the query builder; avoid `db.execute()` because
 * its result shape differs between drivers.
 */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

interface DbState {
  db: Db;
  migrated: Promise<void> | null;
  migrate: () => Promise<void>;
  close: () => Promise<void>;
}

// On globalThis, not module scope: the bundler gives the proxy, route handlers and pages their own
// copies of this module, and two of them must never open the same PGlite directory at once.
const globalForDb = globalThis as unknown as { __flipwatchDb?: DbState; __flipwatchDbPending?: Promise<DbState> | null };

export const MIGRATIONS_FOLDER = path.join(process.cwd(), "drizzle");

/** Arbitrary app-wide advisory lock key: processes starting together (web + worker) migrate one at a time. */
const MIGRATION_LOCK_KEY = 727_274;

/** postgres-js prints server NOTICEs ("… already exists, skipping") by default; they are noise here. */
const ignoreNotices = { onnotice: () => {} };

async function migratePostgres(url: string, db: Db): Promise<void> {
  const { default: postgres } = await import("postgres");
  const { migrate } = await import("drizzle-orm/postgres-js/migrator");
  // The lock is transaction-scoped and held on its own connection while the migrator runs, so it is
  // released on commit (or when the connection drops) even behind a transaction-mode pooler.
  const lockClient = postgres(url, { max: 1, prepare: false, ...ignoreNotices });
  try {
    await lockClient.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await migrate(db as any, { migrationsFolder: MIGRATIONS_FOLDER });
    });
  } finally {
    await lockClient.end();
  }
}

async function createState(): Promise<DbState> {
  const url = config.databaseUrl;
  if (url) {
    const { default: postgres } = await import("postgres");
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const client = postgres(url, { max: 10, prepare: false, ...ignoreNotices });
    const db = drizzle(client, { schema }) as unknown as Db;
    return { db, migrated: null, migrate: () => migratePostgres(url, db), close: () => client.end() };
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const dir = path.resolve(/*turbopackIgnore: true*/ process.cwd(), config.pgliteDir);
  fs.mkdirSync(dir, { recursive: true });
  const release = lockPgliteDir(dir);
  try {
    const client = new PGlite(dir);
    const db = drizzle(client, { schema });
    return {
      db: db as unknown as Db,
      migrated: null,
      migrate: () => migrate(db, { migrationsFolder: MIGRATIONS_FOLDER }),
      close: () => client.close().finally(release),
    };
  } catch (err) {
    release();
    throw err;
  }
}

function state(): Promise<DbState> {
  const ready = globalForDb.__flipwatchDb;
  if (ready) return Promise.resolve(ready);
  let pending = globalForDb.__flipwatchDbPending;
  if (!pending) {
    const created = createState().then((s) => {
      globalForDb.__flipwatchDb = s;
      return s;
    });
    // Don't cache a failure (database unreachable, PGlite dir locked…): the next call retries.
    created.catch(() => {
      if (globalForDb.__flipwatchDbPending === created) globalForDb.__flipwatchDbPending = null;
    });
    globalForDb.__flipwatchDbPending = pending = created;
  }
  return pending;
}

/** Apply pending migrations (idempotent; runs once per process, retried after a failure). */
function migrateState(s: DbState): Promise<void> {
  if (!s.migrated) {
    const migrated = s.migrate();
    migrated.catch(() => {
      if (s.migrated === migrated) s.migrated = null;
    });
    s.migrated = migrated;
  }
  return s.migrated;
}

/**
 * Get the process-wide database, migrated and ready. Safe to call from server components,
 * route handlers, server actions and the worker.
 */
export async function getDb(): Promise<Db> {
  const s = await state();
  await migrateState(s);
  // Settings saved in the app (AI engine, Facebook session…) must be in memory before anything reads config.
  if (!runtimeSettingsLoaded()) await loadRuntimeSettings(s.db);
  return s.db;
}

export async function closeDb(): Promise<void> {
  const s = globalForDb.__flipwatchDb;
  if (s) {
    await s.close();
    globalForDb.__flipwatchDb = undefined;
    globalForDb.__flipwatchDbPending = null;
  }
}

/**
 * Fresh database with all migrations applied. For tests only: in-memory PGlite, or a throwaway
 * database on a real Postgres server when FW_TEST_PG is set to its admin URL without a database
 * name (e.g. FW_TEST_PG=postgres://postgres@127.0.0.1:5432).
 */
export async function createTestDb(): Promise<{ db: Db; close: () => Promise<void> }> {
  const server = process.env.FW_TEST_PG;
  if (server) {
    const { default: postgres } = await import("postgres");
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const { migrate } = await import("drizzle-orm/postgres-js/migrator");
    const name = `fwt_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
    const admin = postgres(`${server}/postgres`, { max: 1, ...ignoreNotices });
    await admin.unsafe(`create database ${name}`);
    const client = postgres(`${server}/${name}`, { max: 10, prepare: false, ...ignoreNotices });
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    return {
      db: db as unknown as Db,
      close: async () => {
        await client.end();
        await admin.unsafe(`drop database if exists ${name} with (force)`);
        await admin.end();
      },
    };
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { db: db as unknown as Db, close: () => client.close() };
}
