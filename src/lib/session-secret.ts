/**
 * The key that signs session cookies. SESSION_SECRET wins when set; otherwise a random 256-bit secret
 * is generated on first use and stored in app_settings. Keeping it in the database (rather than in
 * memory or a file) means every process that shares the database — the Next.js server and its proxy,
 * other replicas, a restarted container — signs and verifies with the same key, so sessions survive
 * restarts. Deleting the row (or changing SESSION_SECRET) and restarting logs every browser out.
 */
import { eq } from "drizzle-orm";
import { generateSessionSecret } from "./auth";
import { config } from "./config";
import type { Db } from "./db";
import { appSettings } from "./db/schema";

export const SESSION_SECRET_KEY = "auth.sessionSecret";

const MIN_SECRET_LENGTH = 32;

// Loaded once per database handle; the proxy and every request after the first read it from memory.
const cache = new WeakMap<Db, Promise<string>>();

export function getSessionSecret(db: Db): Promise<string> {
  const fromEnv = config.sessionSecret;
  if (fromEnv) return Promise.resolve(fromEnv);
  let secret = cache.get(db);
  if (!secret) {
    secret = loadOrCreate(db);
    cache.set(db, secret);
    // Don't remember failures (e.g. the database was briefly unreachable).
    secret.catch(() => {
      if (cache.get(db) === secret) cache.delete(db);
    });
  }
  return secret;
}

function usable(value: unknown): value is string {
  return typeof value === "string" && value.length >= MIN_SECRET_LENGTH;
}

async function readStored(db: Db): Promise<unknown> {
  const [row] = await db.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, SESSION_SECRET_KEY)).limit(1);
  return row?.value;
}

async function loadOrCreate(db: Db): Promise<string> {
  const stored = await readStored(db);
  if (usable(stored)) return stored;
  const generated = generateSessionSecret();
  if (stored === undefined) {
    // First writer wins: processes racing here all read back the row that was inserted first.
    await db.insert(appSettings).values({ key: SESSION_SECRET_KEY, value: generated }).onConflictDoNothing({ target: appSettings.key });
    const winner = await readStored(db);
    if (usable(winner)) return winner;
  }
  // Present but unusable (edited by hand): replace it.
  const now = new Date();
  await db
    .insert(appSettings)
    .values({ key: SESSION_SECRET_KEY, value: generated, updatedAt: now })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: generated, updatedAt: now } });
  return generated;
}
