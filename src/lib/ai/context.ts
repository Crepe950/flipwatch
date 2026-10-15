import { and, desc, eq, gt, gte, isNotNull, ne, or } from "drizzle-orm";
import type { Db } from "../db";
import { listings, priceHistory, searchMatches, searches } from "../db/schema";
import type { Listing, PriceHistoryRow, Search } from "../db/schema";
import { computeCompStats, type CompStats } from "./stats";

export const COMP_WINDOW_DAYS = 30;
/** Enough for stable percentiles without loading a huge search's whole history. */
const MAX_COMPS = 500;
const MAX_PRICE_HISTORY = 20;

export interface EvaluationContext {
  listing: Listing;
  /** Oldest first, at most the latest 20 observations. */
  priceHistory: PriceHistoryRow[];
  /** The search the evaluation is for (given, or the most recent one the listing matched). */
  search: Search | null;
  /** Asking prices of other listings matched by the same search, same currency, last 30 days. */
  comps: CompStats | null;
  now: Date;
}

async function loadSearch(db: Db, listingId: number, searchId: number | null): Promise<Search | null> {
  if (searchId !== null && Number.isSafeInteger(searchId)) {
    const [search] = await db.select().from(searches).where(eq(searches.id, searchId)).limit(1);
    // A search deleted since the match was recorded falls through to the listing's other matches.
    if (search) return search;
  }
  const [row] = await db
    .select({ search: searches })
    .from(searchMatches)
    .innerJoin(searches, eq(searchMatches.searchId, searches.id))
    .where(eq(searchMatches.listingId, listingId))
    .orderBy(desc(searchMatches.lastEventAt), desc(searchMatches.id))
    .limit(1);
  return row?.search ?? null;
}

async function loadComps(db: Db, listing: Listing, searchId: number, now: Date): Promise<CompStats | null> {
  const since = new Date(now.getTime() - COMP_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({ priceCents: listings.priceCents })
    .from(searchMatches)
    .innerJoin(listings, eq(searchMatches.listingId, listings.id))
    .where(
      and(
        eq(searchMatches.searchId, searchId),
        ne(listings.id, listing.id),
        eq(listings.currency, listing.currency),
        isNotNull(listings.priceCents),
        // Free and "$1 placeholder" prices are not comparable asking prices.
        gt(listings.priceCents, 100),
        or(gte(searchMatches.firstMatchedAt, since), gte(listings.lastSeenAt, since)),
      ),
    )
    .orderBy(desc(listings.lastSeenAt))
    .limit(MAX_COMPS);
  return computeCompStats(rows.map((r) => r.priceCents).filter((p): p is number => p !== null));
}

/** Load a listing or throw a "not found" error (also for ids that are not positive integers). */
export async function loadListing(db: Db, listingId: number): Promise<Listing> {
  if (Number.isSafeInteger(listingId) && listingId > 0) {
    const [listing] = await db.select().from(listings).where(eq(listings.id, listingId)).limit(1);
    if (listing) return listing;
  }
  throw new Error(`Listing ${listingId} not found`);
}

/** Everything the evaluation prompt needs. Throws when the listing does not exist. */
export async function loadEvaluationContext(
  db: Db,
  listingId: number,
  opts: { searchId?: number | null; now?: Date } = {},
): Promise<EvaluationContext> {
  const now = opts.now ?? new Date();
  const listing = await loadListing(db, listingId);
  const [history, search] = await Promise.all([
    db
      .select()
      .from(priceHistory)
      .where(eq(priceHistory.listingId, listingId))
      .orderBy(desc(priceHistory.observedAt), desc(priceHistory.id))
      .limit(MAX_PRICE_HISTORY),
    loadSearch(db, listingId, opts.searchId ?? null),
  ]);
  const comps = search ? await loadComps(db, listing, search.id, now) : null;

  return { listing, priceHistory: history.reverse(), search, comps, now };
}
