/** Per-marketplace failure/backoff bookkeeping in marketplace_health (shared by every worker). */
import { eq } from "drizzle-orm";
import type { Db } from "../db";
import { marketplaceHealth, type MarketplaceHealth } from "../db/schema";
import type { MarketplaceId } from "../types";
import { backoffUntil } from "./backoff";
import { errorMessage } from "./log";

const MAX_ERROR_LENGTH = 500;

export async function loadMarketplaceHealth(db: Db): Promise<Map<MarketplaceId, MarketplaceHealth>> {
  const rows = await db.select().from(marketplaceHealth);
  return new Map(rows.map((row) => [row.marketplace, row]));
}

export async function recordMarketplaceSuccess(db: Db, marketplace: MarketplaceId, now: Date): Promise<void> {
  await db
    .insert(marketplaceHealth)
    .values({ marketplace, consecutiveFailures: 0, backoffUntil: null, lastSuccessAt: now })
    .onConflictDoUpdate({
      target: marketplaceHealth.marketplace,
      set: { consecutiveFailures: 0, backoffUntil: null, lastSuccessAt: now },
    });
}

/** Current health of one marketplace (re-read right before a request: another search may just have failed). */
export async function loadMarketplaceHealthOf(db: Db, marketplace: MarketplaceId): Promise<MarketplaceHealth | undefined> {
  const [row] = await db.select().from(marketplaceHealth).where(eq(marketplaceHealth.marketplace, marketplace));
  return row;
}

/**
 * Count the failure and set backoffUntil from backoff.ts. Returns the new state.
 *
 * One outage counts once: a failure while a backoff is already running (other searches that hit the
 * same block in this tick, a forced "Run now") is recorded as lastError but doesn't escalate the
 * backoff; it can only push the end of the current window out to what this failure alone would ask
 * for. The row is locked so concurrent failures see each other's writes.
 */
export async function recordMarketplaceFailure(
  db: Db,
  marketplace: MarketplaceId,
  err: unknown,
  now: Date,
): Promise<{ consecutiveFailures: number; backoffUntil: Date | null }> {
  const lastError = errorMessage(err).slice(0, MAX_ERROR_LENGTH);
  return db.transaction(async (tx) => {
    await tx.insert(marketplaceHealth).values({ marketplace }).onConflictDoNothing({ target: marketplaceHealth.marketplace });
    const [current] = await tx
      .select({ failures: marketplaceHealth.consecutiveFailures, backoffUntil: marketplaceHealth.backoffUntil })
      .from(marketplaceHealth)
      .where(eq(marketplaceHealth.marketplace, marketplace))
      .for("update");
    const running = current.backoffUntil !== null && current.backoffUntil.getTime() > now.getTime() ? current.backoffUntil : null;
    const consecutiveFailures = running ? current.failures : current.failures + 1;
    const next = backoffUntil(err, consecutiveFailures, now);
    const until = running && (!next || next.getTime() < running.getTime()) ? running : next;
    await tx
      .update(marketplaceHealth)
      .set({ consecutiveFailures, backoffUntil: until, lastError, lastErrorAt: now })
      .where(eq(marketplaceHealth.marketplace, marketplace));
    return { consecutiveFailures, backoffUntil: until };
  });
}
