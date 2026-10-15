/**
 * Automatic market price checks for searches that only alert on a checked profit (notifyMinProfitPct).
 * Matches that pass the search's other filters (its minimum AI score) get a price check in the background;
 * their alert is held back until it is done, and a later run (undelivered alerts are retried for hours)
 * sends it if the profit is there. Each check makes several marketplace searches, Facebook included, so
 * checks are capped per hour and a listing is checked at most once a day.
 */
import { and, desc, gt, inArray } from "drizzle-orm";
import { priceCheckListing } from "../ai";
import { isAiConfigured } from "../ai/client";
import type { Db } from "../db";
import { aiEvaluations, priceChecks, type Search } from "../db/schema";
import type { MatchEvent } from "../events";
import { errorMessage, log } from "./log";

export const AUTO_PRICE_CHECKS_PER_HOUR = 4;
const RECHECK_AFTER_MS = 24 * 3_600_000;
const HOUR_MS = 3_600_000;

const state = globalThis as unknown as { __flipwatchAutoPriceChecks?: { started: number[]; running: Map<number, Promise<void>> } };
function queue() {
  return (state.__flipwatchAutoPriceChecks ??= { started: [], running: new Map() });
}

/** Test hook. */
export function resetAutoPriceChecks(): void {
  queue().started.length = 0;
  queue().running.clear();
}

/** Resolves once every started automatic price check has finished (tests, shutdown). */
export async function autoPriceChecksIdle(): Promise<void> {
  while (queue().running.size > 0) await Promise.allSettled([...queue().running.values()]);
}

/**
 * Start price checks for the listings in `events` that need one before they can alert. Never throws and
 * never waits for the checks. Returns the listing ids it started checks for.
 */
export async function queueAutoPriceChecks(db: Db, search: Search, events: readonly MatchEvent[], now = new Date()): Promise<number[]> {
  if (search.notifyMinProfitPct == null || !isAiConfigured()) return [];
  const listingIds = [...new Set(events.filter((e) => !e.silent).map((e) => e.listingId))];
  if (listingIds.length === 0) return [];
  try {
    const [checked, evaluated] = await Promise.all([
      db
        .selectDistinct({ listingId: priceChecks.listingId })
        .from(priceChecks)
        .where(and(inArray(priceChecks.listingId, listingIds), gt(priceChecks.createdAt, new Date(now.getTime() - RECHECK_AFTER_MS)))),
      search.notifyMinAiScore == null
        ? Promise.resolve([])
        : db
            .selectDistinctOn([aiEvaluations.listingId], { listingId: aiEvaluations.listingId, dealScore: aiEvaluations.dealScore })
            .from(aiEvaluations)
            .where(inArray(aiEvaluations.listingId, listingIds))
            .orderBy(aiEvaluations.listingId, desc(aiEvaluations.createdAt), desc(aiEvaluations.id)),
    ]);
    const recent = new Set(checked.map((r) => r.listingId));
    const aiScore = new Map(evaluated.map((r) => [r.listingId, r.dealScore]));
    const q = queue();
    const wanted = listingIds.filter((id) => {
      if (recent.has(id) || q.running.has(id)) return false;
      // Only spend a price check on listings that already pass the AI-score filter.
      return search.notifyMinAiScore == null || (aiScore.get(id) ?? -1) >= search.notifyMinAiScore;
    });

    q.started = q.started.filter((t) => now.getTime() - t < HOUR_MS);
    const room = Math.max(0, AUTO_PRICE_CHECKS_PER_HOUR - q.started.length);
    if (wanted.length > room) log.info(`Price-check limit reached; ${wanted.length - room} listing(s) wait for a later run`);
    const start = wanted.slice(0, room);
    for (const listingId of start) {
      q.started.push(now.getTime());
      const run = priceCheckListing(db, listingId, { location: search.location })
        .then((pc) => log.info(`Auto price check of listing ${listingId} ("${search.name}"): ${pc.summary.slice(0, 120)}`))
        .catch((err) => log.warn(`Auto price check of listing ${listingId} failed: ${errorMessage(err)}`))
        .finally(() => q.running.delete(listingId));
      q.running.set(listingId, run);
    }
    return start;
  } catch (err) {
    log.warn(`Could not queue price checks for search ${search.id}: ${errorMessage(err)}`);
    return [];
  }
}
