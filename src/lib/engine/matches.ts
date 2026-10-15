/**
 * Match bookkeeping for one search: new matches, price drops, deal scores and silence rules.
 *
 * Price drops are decided per match, not per scrape: a match drops when the listing's current price is
 * below the price it had at the match's last event (read from price_history). That way a drop is
 * reported to every search matching the listing, even when a different search's run observed it first.
 */
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, lte, notInArray } from "drizzle-orm";
import type { Db } from "../db";
import { listings, priceHistory, searchMatches, type Listing, type Search, type SearchMatch } from "../db/schema";
import type { MatchEvent } from "../events";
import { computeDealScore, isScorablePrice, PLACEHOLDER_MAX_CENTS, type DealScore } from "./scoring";

export interface MatchCandidate {
  listing: Listing;
  /**
   * Posted longer ago than the search's max listing age, and after the search's previous successful
   * run on this marketplace: it went up while the search wasn't polling (app offline, search paused,
   * marketplace failing), and catching up on such listings is recorded without alerting. An older
   * listing that only starts matching now although it was up before (e.g. its price was cut into
   * range) is news, so it is not flagged.
   */
  staleCatchUp: boolean;
}

export interface RecordMatchesOptions {
  now: Date;
  /** First successful run for this (search, marketplace): record everything silently. */
  firstRun: boolean;
}

export const COMPS_WINDOW_DAYS = 30;
const COMPS_LIMIT = 500;

interface Comp {
  listingId: number;
  priceCents: number;
  currency: string;
}

/** Real (non-placeholder) prices of this search's matched listings seen in the last 30 days. */
async function loadComps(db: Db, searchId: number, now: Date): Promise<Comp[]> {
  const cutoff = new Date(now.getTime() - COMPS_WINDOW_DAYS * 86_400_000);
  const rows = await db
    .select({ listingId: listings.id, priceCents: listings.priceCents, currency: listings.currency })
    .from(searchMatches)
    .innerJoin(listings, eq(searchMatches.listingId, listings.id))
    .where(
      and(eq(searchMatches.searchId, searchId), gte(listings.lastSeenAt, cutoff), gt(listings.priceCents, PLACEHOLDER_MAX_CENTS)),
    )
    .orderBy(desc(listings.lastSeenAt))
    .limit(COMPS_LIMIT);
  return rows.filter((r): r is Comp => isScorablePrice(r.priceCents));
}

type PricePoint = { priceCents: number | null; currency: string | null; observedAt: Date };

async function loadPriceHistory(db: Db, listingIds: number[]): Promise<Map<number, PricePoint[]>> {
  const byListing = new Map<number, PricePoint[]>();
  if (listingIds.length === 0) return byListing;
  const rows = await db
    .select({
      listingId: priceHistory.listingId,
      priceCents: priceHistory.priceCents,
      currency: priceHistory.currency,
      observedAt: priceHistory.observedAt,
    })
    .from(priceHistory)
    .where(inArray(priceHistory.listingId, listingIds))
    .orderBy(asc(priceHistory.listingId), asc(priceHistory.observedAt), asc(priceHistory.id));
  for (const row of rows) {
    const list = byListing.get(row.listingId) ?? [];
    list.push(row);
    byListing.set(row.listingId, list);
  }
  return byListing;
}

/**
 * The price a drop is measured against: the listing's price as of `at` (the match's last event, or the
 * first known price when the history starts later). When that price is unknown (the listing had no
 * price yet) or in another currency than `currency`, the first later observation with a price in
 * `currency` is the baseline instead. History rows without a currency (written before it was tracked)
 * count as `currency`. Without any history, `fallback` (the first-seen price) is used.
 */
export function referencePrice(
  history: readonly PricePoint[],
  at: Date,
  currency: string,
  fallback: number | null,
): number | null {
  if (history.length === 0) return fallback;
  let start = 0;
  for (let i = 0; i < history.length && history[i].observedAt.getTime() <= at.getTime(); i++) start = i;
  for (let i = start; i < history.length; i++) {
    const { priceCents, currency: pointCurrency } = history[i];
    if (priceCents != null && (pointCurrency == null || pointCurrency === currency)) return priceCents;
  }
  return null;
}

/** A price drop worth an event: at least 1 % and at least one currency unit (100 cents) below the reference. */
export const MIN_DROP_FRACTION = 0.01;
export const MIN_DROP_CENTS = 100;

export function isPriceDrop(reference: number, priceCents: number): boolean {
  const drop = reference - priceCents;
  return drop >= MIN_DROP_CENTS && drop >= reference * MIN_DROP_FRACTION;
}

interface SilenceInput {
  type: MatchEvent["type"];
  firstRun: boolean;
  staleCatchUp: boolean;
  score: number | null;
  search: Pick<Search, "notifyMinDealScore" | "notifyPriceDrops">;
  dismissed?: boolean;
}

/**
 * Whether an event is recorded without alerting. Staleness only silences "new" events found while
 * catching up (see MatchCandidate): a price drop on an older listing is exactly what a flipper wants to
 * hear about. A minimum deal score only holds back scored matches; a match that can't be scored yet
 * (too few comparable listings, no resale estimate) still alerts, as notify does.
 */
export function isSilent({ type, firstRun, staleCatchUp, score, search, dismissed }: SilenceInput): boolean {
  if (firstRun) return true;
  if (type === "new" && staleCatchUp) return true;
  if (type === "price_drop" && (!search.notifyPriceDrops || dismissed)) return true;
  const min = search.notifyMinDealScore;
  return min != null && score != null && score < min;
}

/** Create/refresh match rows for listings that passed the search's filters and return the resulting events. */
export async function recordMatches(
  db: Db,
  search: Search,
  candidates: readonly MatchCandidate[],
  { now, firstRun }: RecordMatchesOptions,
): Promise<MatchEvent[]> {
  if (candidates.length === 0) return [];
  const listingIds = candidates.map((c) => c.listing.id);

  const [existingRows, storedComps] = await Promise.all([
    db
      .select()
      .from(searchMatches)
      .where(and(eq(searchMatches.searchId, search.id), inArray(searchMatches.listingId, listingIds))),
    loadComps(db, search.id, now),
  ]);
  const existing = new Map<number, SearchMatch>(existingRows.map((m) => [m.listingId, m]));
  const history = await loadPriceHistory(db, [...existing.keys()]);

  // Comps: stored matches plus everything that matched in this batch (so a first run gets scores too).
  const comps = new Map<number, Comp>(storedComps.map((c) => [c.listingId, c]));
  for (const { listing } of candidates) {
    if (isScorablePrice(listing.priceCents)) {
      comps.set(listing.id, { listingId: listing.id, priceCents: listing.priceCents, currency: listing.currency });
    }
  }
  const scoreFor = (listing: Listing): DealScore =>
    computeDealScore({
      priceCents: listing.priceCents,
      compsCents: [...comps.values()]
        .filter((c) => c.listingId !== listing.id && c.currency === listing.currency)
        .map((c) => c.priceCents),
      expectedResaleCents: search.expectedResaleCents,
      currency: listing.currency,
    });

  const eventsByListing = new Map<number, MatchEvent>();

  // New matches: one batch insert. ON CONFLICT DO NOTHING means a concurrent run of the same search
  // (e.g. "Run now" during a scheduled run) can't emit the same "new" event twice.
  // Sorted by listing id so concurrent inserts for the same search take locks in the same order.
  const fresh = candidates.filter((c) => !existing.has(c.listing.id)).sort((a, b) => a.listing.id - b.listing.id);
  if (fresh.length > 0) {
    const values = fresh.map(({ listing, staleCatchUp }) => {
      const score = scoreFor(listing);
      return {
        searchId: search.id,
        listingId: listing.id,
        firstMatchedAt: now,
        lastEventAt: now,
        lastEvent: "new" as const,
        dealScore: score.score,
        dealScoreReason: score.reason,
        estimatedProfitCents: score.estimatedProfitCents,
        silent: isSilent({ type: "new", firstRun, staleCatchUp, score: score.score, search }),
      };
    });
    const inserted = await db
      .insert(searchMatches)
      .values(values)
      .onConflictDoNothing({ target: [searchMatches.searchId, searchMatches.listingId] })
      .returning({ id: searchMatches.id, listingId: searchMatches.listingId, silent: searchMatches.silent });
    for (const row of inserted) {
      eventsByListing.set(row.listingId, {
        type: "new",
        matchId: row.id,
        searchId: search.id,
        listingId: row.listingId,
        previousPriceCents: null,
        silent: row.silent,
      });
    }
  }

  for (const { listing, staleCatchUp } of candidates) {
    const match = existing.get(listing.id);
    if (!match || listing.priceCents == null) continue;
    const reference = referencePrice(history.get(listing.id) ?? [], match.lastEventAt, listing.currency, listing.originalPriceCents);
    if (reference == null || !isPriceDrop(reference, listing.priceCents)) continue;

    const score = scoreFor(listing);
    const silent = isSilent({
      type: "price_drop",
      firstRun,
      staleCatchUp,
      score: score.score,
      search,
      dismissed: match.dismissed,
    });
    // Compare-and-set on lastEventAt (+1 ms absorbs sub-millisecond DB precision) so concurrent runs
    // report each drop once.
    const [updated] = await db
      .update(searchMatches)
      .set({
        lastEvent: "price_drop",
        lastEventAt: now,
        lastEventPreviousPriceCents: reference,
        dealScore: score.score,
        dealScoreReason: score.reason,
        estimatedProfitCents: score.estimatedProfitCents,
        // An alerted drop makes the row an alert-worthy, unseen match again (even if it started out silent).
        ...(silent ? {} : { silent: false, seen: false, notifiedAt: null }),
      })
      .where(and(eq(searchMatches.id, match.id), lt(searchMatches.lastEventAt, new Date(match.lastEventAt.getTime() + 1))))
      .returning({ id: searchMatches.id });
    if (!updated) continue;
    eventsByListing.set(listing.id, {
      type: "price_drop",
      matchId: match.id,
      searchId: search.id,
      listingId: listing.id,
      previousPriceCents: reference,
      silent,
    });
  }

  // Keep the adapter's (newest-first) order.
  return candidates.map((c) => eventsByListing.get(c.listing.id)).filter((e): e is MatchEvent => e !== undefined);
}

/** How far back undelivered alerts are retried, how many per run, and how long a fresh one is left to its own run. */
export const ALERT_RETRY_WINDOW_MS = 6 * 3_600_000;
export const ALERT_RETRY_LIMIT = 20;
export const ALERT_RETRY_AFTER_MS = 5 * 60_000;

/**
 * Recent alert-worthy events of a search whose alert was never delivered (every channel failed), as
 * events to offer notify again. Matches the user has already seen or dismissed are skipped, and so
 * are events from the last few minutes, whose own run may still be delivering them. notify
 * de-duplicates, so offering an event twice never alerts twice. A retried price drop reports the
 * price it dropped from, as the original alert did.
 */
export async function undeliveredEvents(
  db: Db,
  searchId: number,
  now: Date,
  exclude: readonly number[] = [],
): Promise<MatchEvent[]> {
  const rows = await db
    .select({
      id: searchMatches.id,
      listingId: searchMatches.listingId,
      lastEvent: searchMatches.lastEvent,
      previousPriceCents: searchMatches.lastEventPreviousPriceCents,
    })
    .from(searchMatches)
    .where(
      and(
        eq(searchMatches.searchId, searchId),
        eq(searchMatches.silent, false),
        eq(searchMatches.seen, false),
        eq(searchMatches.dismissed, false),
        isNull(searchMatches.notifiedAt),
        gt(searchMatches.lastEventAt, new Date(now.getTime() - ALERT_RETRY_WINDOW_MS)),
        lte(searchMatches.lastEventAt, new Date(now.getTime() - ALERT_RETRY_AFTER_MS)),
        exclude.length > 0 ? notInArray(searchMatches.id, [...exclude]) : undefined,
      ),
    )
    .orderBy(desc(searchMatches.lastEventAt), desc(searchMatches.id))
    .limit(ALERT_RETRY_LIMIT);
  return rows.map((row) => ({
    type: row.lastEvent,
    matchId: row.id,
    searchId,
    listingId: row.listingId,
    previousPriceCents: row.lastEvent === "price_drop" ? row.previousPriceCents : null,
    silent: false,
  }));
}
