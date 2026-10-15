/** Daily cleanup so the database doesn't grow without bound. */
import { and, eq, lt, notExists, sql } from "drizzle-orm";
import type { Db } from "../db";
import { appSettings, deals, listings, notificationLog, scrapeRuns, searchMatches } from "../db/schema";

const DAY_MS = 86_400_000;

export const RETENTION = {
  scrapeRunsDays: 7,
  notificationLogDays: 30,
  /** Unmatched listings not seen for this long are deleted (with their price history). */
  unmatchedListingDays: 21,
} as const;

export const RETENTION_KEY = "worker.retention";
const RETENTION_EVERY_MS = DAY_MS;

export interface RetentionResult {
  scrapeRuns: number;
  notificationLog: number;
  listings: number;
}

export async function runRetention(db: Db, now = new Date()): Promise<RetentionResult> {
  const daysAgo = (days: number) => new Date(now.getTime() - days * DAY_MS);

  const runs = await db
    .delete(scrapeRuns)
    .where(lt(scrapeRuns.startedAt, daysAgo(RETENTION.scrapeRunsDays)))
    .returning({ id: scrapeRuns.id });
  const logs = await db
    .delete(notificationLog)
    .where(lt(notificationLog.createdAt, daysAgo(RETENTION.notificationLogDays)))
    .returning({ id: notificationLog.id });
  const orphans = await db
    .delete(listings)
    .where(
      and(
        lt(listings.lastSeenAt, daysAgo(RETENTION.unmatchedListingDays)),
        notExists(db.select({ one: sql`1` }).from(searchMatches).where(eq(searchMatches.listingId, listings.id))),
        notExists(db.select({ one: sql`1` }).from(deals).where(eq(deals.listingId, listings.id))),
      ),
    )
    .returning({ id: listings.id });

  return { scrapeRuns: runs.length, notificationLog: logs.length, listings: orphans.length };
}

/**
 * Run retention if it hasn't run in the last 24 h (tracked in app_settings, so restarts and multiple
 * workers don't repeat it). Returns null when it was not due.
 */
export async function runRetentionIfDue(db: Db, now = new Date()): Promise<RetentionResult | null> {
  const [row] = await db.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, RETENTION_KEY));
  const lastAt = Date.parse((row?.value as { at?: unknown } | undefined)?.at as string);
  if (Number.isFinite(lastAt) && now.getTime() - lastAt < RETENTION_EVERY_MS) return null;

  // Mark first: if two workers race, both runs are harmless deletes of the same rows.
  const value = { at: now.toISOString() };
  await db
    .insert(appSettings)
    .values({ key: RETENTION_KEY, value, updatedAt: now })
    .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: now } });
  return runRetention(db, now);
}
