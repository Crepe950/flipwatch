/** Listing detail page queries. */
import { and, asc, desc, eq } from "drizzle-orm";
import type { Db } from "../db";
import {
  aiEvaluations,
  deals,
  listings,
  priceHistory,
  searches,
  searchMatches,
  type AiEvaluation,
  type Deal,
  type Listing,
} from "../db/schema";
import type { MatchEventType } from "../types";

export interface PricePoint {
  priceCents: number | null;
  observedAt: Date;
}

export interface ListingMatch {
  matchId: number;
  searchId: number;
  searchName: string;
  dealScore: number | null;
  dealScoreReason: string | null;
  estimatedProfitCents: number | null;
  lastEvent: MatchEventType;
  lastEventAt: Date;
  firstMatchedAt: Date;
  silent: boolean;
  seen: boolean;
  dismissed: boolean;
}

export interface ListingDetail {
  listing: Listing;
  priceHistory: PricePoint[];
  /** Best-scoring match first. */
  matches: ListingMatch[];
  evaluation: AiEvaluation | null;
  deal: Deal | null;
}

export async function getListingDetail(db: Db, listingId: number): Promise<ListingDetail | null> {
  const [listing] = await db.select().from(listings).where(eq(listings.id, listingId)).limit(1);
  if (!listing) return null;

  const [history, matches, evaluations, dealRows] = await Promise.all([
    db
      .select({ priceCents: priceHistory.priceCents, observedAt: priceHistory.observedAt })
      .from(priceHistory)
      .where(eq(priceHistory.listingId, listingId))
      .orderBy(asc(priceHistory.observedAt), asc(priceHistory.id)),
    db
      .select({
        matchId: searchMatches.id,
        searchId: searchMatches.searchId,
        searchName: searches.name,
        dealScore: searchMatches.dealScore,
        dealScoreReason: searchMatches.dealScoreReason,
        estimatedProfitCents: searchMatches.estimatedProfitCents,
        lastEvent: searchMatches.lastEvent,
        lastEventAt: searchMatches.lastEventAt,
        firstMatchedAt: searchMatches.firstMatchedAt,
        silent: searchMatches.silent,
        seen: searchMatches.seen,
        dismissed: searchMatches.dismissed,
      })
      .from(searchMatches)
      .innerJoin(searches, eq(searches.id, searchMatches.searchId))
      .where(eq(searchMatches.listingId, listingId))
      .orderBy(desc(searchMatches.lastEventAt)),
    db
      .select()
      .from(aiEvaluations)
      .where(eq(aiEvaluations.listingId, listingId))
      .orderBy(desc(aiEvaluations.createdAt), desc(aiEvaluations.id))
      .limit(1),
    db.select().from(deals).where(eq(deals.listingId, listingId)).limit(1),
  ]);

  matches.sort((a, b) => (b.dealScore ?? -1) - (a.dealScore ?? -1));

  return {
    listing,
    priceHistory: history,
    matches,
    evaluation: evaluations[0] ?? null,
    deal: dealRows[0] ?? null,
  };
}

/** Minimal existence check used by actions before acting on a listing id from the client. */
export async function listingExists(db: Db, listingId: number): Promise<boolean> {
  const rows = await db.select({ id: listings.id }).from(listings).where(eq(listings.id, listingId)).limit(1);
  return rows.length > 0;
}

/** The search a listing scores best for (context for AI analysis); null when it matched none. */
export async function getBestMatchSearchId(db: Db, listingId: number): Promise<number | null> {
  const rows = await db
    .select({ searchId: searchMatches.searchId, dealScore: searchMatches.dealScore })
    .from(searchMatches)
    .where(eq(searchMatches.listingId, listingId))
    .orderBy(desc(searchMatches.lastEventAt));
  if (rows.length === 0) return null;
  return rows.reduce((best, r) => ((r.dealScore ?? -1) > (best.dealScore ?? -1) ? r : best)).searchId;
}

/** Mark every unseen match of a listing as seen (the user opened its detail page). */
export async function markListingMatchesSeen(db: Db, listingId: number): Promise<number> {
  const rows = await db
    .update(searchMatches)
    .set({ seen: true })
    .where(and(eq(searchMatches.listingId, listingId), eq(searchMatches.seen, false)))
    .returning({ id: searchMatches.id });
  return rows.length;
}
