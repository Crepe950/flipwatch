/**
 * Deal-feed queries: the match list (filters, keyset pagination, "since" polling), the header
 * stats and the small match mutations (seen / dismissed).
 */
import { and, count, desc, eq, gte, ilike, inArray, lt, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "../db";
import { aiEvaluations, appSettings, deals, listings, notificationChannels, searches, searchMatches } from "../db/schema";
import type { WorkerMode } from "../config";
import type { AiVerdict, DealStage, MarketplaceId, MatchEventType } from "../types";

export interface FeedFilters {
  searchId?: number;
  marketplace?: MarketplaceId;
  event?: MatchEventType;
  minScore?: number;
  /**
   * Include silent matches (default true): ones recorded without an alert — first run, below the
   * search's minimum deal score, older than its max listing age… They are shown with a "Quiet" badge.
   */
  includeInitial: boolean;
  /** Include dismissed matches (default false). */
  includeDismissed: boolean;
  /** Case-insensitive substring of the listing title. */
  q?: string;
}

export const DEFAULT_FEED_FILTERS: FeedFilters = { includeInitial: true, includeDismissed: false };

/** One card in the feed. Dates are ISO strings so the same shape works for RSC props and JSON. */
export interface FeedItem {
  matchId: number;
  searchId: number;
  searchName: string;
  listingId: number;
  marketplace: MarketplaceId;
  url: string;
  title: string;
  priceCents: number | null;
  originalPriceCents: number | null;
  currency: string;
  imageUrl: string | null;
  locationText: string | null;
  postedAt: string | null;
  firstSeenAt: string;
  /** When the listing last appeared in a marketplace's results. */
  lastSeenAt: string;
  lastEventAt: string;
  lastEvent: MatchEventType;
  dealScore: number | null;
  dealScoreReason: string | null;
  estimatedProfitCents: number | null;
  silent: boolean;
  seen: boolean;
  dismissed: boolean;
  listingStatus: "active" | "gone";
  aiVerdict: AiVerdict | null;
  aiDealScore: number | null;
  dealId: number | null;
  dealStage: DealStage | null;
}

export interface FeedPage {
  items: FeedItem[];
  /** Pass back as `cursor` to get the next (older) page; null on the last page. */
  nextCursor: string | null;
}

/** JSON body of GET /api/feed. */
export interface FeedApiResponse {
  items: FeedItem[];
  nextCursor: string | null;
  /** Unseen alert-worthy matches for the same filters (drives the tab-title badge). */
  unseenCount: number;
  serverTime: string;
}

export interface FeedCursor {
  /** lastEventAt of the last row on the page. */
  at: Date;
  matchId: number;
}

export const FEED_PAGE_SIZE = 30;
export const FEED_MAX_LIMIT = 100;

// last_event_at is stored with millisecond precision (timestamptz(3)), exactly what a JS Date holds,
// so cursors and "since" values built from JS Dates compare exactly and the column's index serves
// the ordering.
const eventAt = searchMatches.lastEventAt;

export function encodeFeedCursor(cursor: FeedCursor): string {
  return `${cursor.at.getTime()}_${cursor.matchId}`;
}

export function decodeFeedCursor(value: string): FeedCursor | null {
  const m = /^(\d{1,15})_(\d{1,10})$/.exec(value);
  if (!m) return null;
  const at = new Date(Number(m[1]));
  const matchId = Number(m[2]);
  if (Number.isNaN(at.getTime()) || !Number.isSafeInteger(matchId)) return null;
  return { at, matchId };
}

/** Escape LIKE wildcards so user text is matched literally. */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function filterConditions(filters: FeedFilters): SQL[] {
  const conds: SQL[] = [];
  if (filters.searchId !== undefined) conds.push(eq(searchMatches.searchId, filters.searchId));
  if (filters.marketplace) conds.push(eq(listings.marketplace, filters.marketplace));
  if (filters.event) conds.push(eq(searchMatches.lastEvent, filters.event));
  if (filters.minScore !== undefined) conds.push(gte(searchMatches.dealScore, filters.minScore));
  if (!filters.includeInitial) conds.push(eq(searchMatches.silent, false));
  if (!filters.includeDismissed) conds.push(eq(searchMatches.dismissed, false));
  const q = filters.q?.trim();
  if (q) conds.push(ilike(listings.title, `%${escapeLike(q)}%`));
  return conds;
}

async function selectFeedRows(db: Db, where: SQL | undefined, limit: number) {
  return db
    .select({
      matchId: searchMatches.id,
      searchId: searchMatches.searchId,
      searchName: searches.name,
      listingId: listings.id,
      marketplace: listings.marketplace,
      url: listings.url,
      title: listings.title,
      priceCents: listings.priceCents,
      originalPriceCents: listings.originalPriceCents,
      currency: listings.currency,
      imageUrls: listings.imageUrls,
      locationText: listings.locationText,
      postedAt: listings.postedAt,
      firstSeenAt: listings.firstSeenAt,
      lastSeenAt: listings.lastSeenAt,
      lastEventAt: searchMatches.lastEventAt,
      lastEvent: searchMatches.lastEvent,
      dealScore: searchMatches.dealScore,
      dealScoreReason: searchMatches.dealScoreReason,
      estimatedProfitCents: searchMatches.estimatedProfitCents,
      silent: searchMatches.silent,
      seen: searchMatches.seen,
      dismissed: searchMatches.dismissed,
      listingStatus: listings.status,
      dealId: deals.id,
      dealStage: deals.stage,
    })
    .from(searchMatches)
    .innerJoin(listings, eq(listings.id, searchMatches.listingId))
    .innerJoin(searches, eq(searches.id, searchMatches.searchId))
    .leftJoin(deals, eq(deals.listingId, listings.id))
    .where(where)
    .orderBy(desc(eventAt), desc(searchMatches.id))
    .limit(limit);
}

type FeedRow = Awaited<ReturnType<typeof selectFeedRows>>[number];

/** Latest AI evaluation per listing (newest row wins). */
async function latestVerdicts(db: Db, listingIds: number[]) {
  const byListing = new Map<number, { verdict: AiVerdict; dealScore: number }>();
  if (listingIds.length === 0) return byListing;
  const rows = await db
    .select({ listingId: aiEvaluations.listingId, verdict: aiEvaluations.verdict, dealScore: aiEvaluations.dealScore })
    .from(aiEvaluations)
    .where(inArray(aiEvaluations.listingId, listingIds))
    .orderBy(desc(aiEvaluations.createdAt), desc(aiEvaluations.id));
  for (const row of rows) {
    if (!byListing.has(row.listingId)) byListing.set(row.listingId, { verdict: row.verdict, dealScore: row.dealScore });
  }
  return byListing;
}

function firstImage(urls: unknown): string | null {
  if (!Array.isArray(urls)) return null;
  const first = urls.find((u) => typeof u === "string" && u.length > 0);
  return typeof first === "string" ? first : null;
}

async function toFeedItems(db: Db, rows: FeedRow[]): Promise<FeedItem[]> {
  const verdicts = await latestVerdicts(db, [...new Set(rows.map((r) => r.listingId))]);
  return rows.map(({ imageUrls, postedAt, firstSeenAt, lastSeenAt, lastEventAt, ...row }) => {
    const ai = verdicts.get(row.listingId);
    return {
      ...row,
      imageUrl: firstImage(imageUrls),
      postedAt: postedAt ? postedAt.toISOString() : null,
      firstSeenAt: firstSeenAt.toISOString(),
      lastSeenAt: lastSeenAt.toISOString(),
      lastEventAt: lastEventAt.toISOString(),
      aiVerdict: ai?.verdict ?? null,
      aiDealScore: ai?.dealScore ?? null,
    };
  });
}

function clampLimit(limit: number | undefined, fallback: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return fallback;
  return Math.min(FEED_MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

/**
 * Newest-first page of matches, optionally continuing after `cursor`. With `since` (live polling)
 * only events at or after that time are returned. Inclusive on purpose: events that share the
 * boundary millisecond are returned again and de-duplicated by the client, so a match written in
 * the same millisecond as the last poll is never missed. A burst bigger than one page comes back
 * with a cursor, like any other page, so the poller can read all of it.
 */
export async function getFeedPage(
  db: Db,
  filters: FeedFilters,
  opts: { cursor?: FeedCursor | null; limit?: number; since?: Date } = {},
): Promise<FeedPage> {
  const limit = clampLimit(opts.limit, FEED_PAGE_SIZE);
  const conds = filterConditions(filters);
  if (opts.since) conds.push(gte(eventAt, opts.since));
  if (opts.cursor) {
    const { at, matchId } = opts.cursor;
    conds.push(or(lt(eventAt, at), and(eq(eventAt, at), lt(searchMatches.id, matchId)))!);
  }
  const rows = await selectFeedRows(db, and(...conds), limit + 1);
  const pageRows = rows.slice(0, limit);
  const last = pageRows.at(-1);
  const nextCursor =
    rows.length > limit && last ? encodeFeedCursor({ at: new Date(last.lastEventAt.getTime()), matchId: last.matchId }) : null;
  return { items: await toFeedItems(db, pageRows), nextCursor };
}

/** Unseen, alert-worthy (not silent, not dismissed) matches that pass the filters. */
function unseenConditions(filters: FeedFilters): SQL[] {
  const conds = filterConditions({ ...filters, includeDismissed: false });
  conds.push(eq(searchMatches.seen, false), eq(searchMatches.silent, false));
  return conds;
}

/** How many unseen, alert-worthy matches pass the filters (the "N unseen" count and tab badge). */
export async function countUnseen(db: Db, filters: FeedFilters): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(searchMatches)
    .innerJoin(listings, eq(listings.id, searchMatches.listingId))
    .where(and(...unseenConditions(filters)));
  return Number(row?.n ?? 0);
}

// --- Stats strip ------------------------------------------------------------------------------

export const WORKER_HEARTBEAT_KEY = "worker.heartbeat";
export const WORKER_LIVE_MS = 2 * 60 * 1000;

export type WorkerState = "live" | "stalled" | "off";

export interface WorkerStatus {
  state: WorkerState;
  /** WORKER_MODE of this web process. */
  mode: WorkerMode;
  lastBeatAt: string | null;
  /** Who wrote the last beat ("inline", "external", "cron"…), when the heartbeat says. */
  beatSource: string | null;
}

function toDate(value: unknown): Date | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * The heartbeat value is written by the worker; accept the plausible shapes (ISO string, epoch ms,
 * or an object with a timestamp field) and fall back to the row's updatedAt.
 */
export function parseWorkerHeartbeat(value: unknown, updatedAt: Date | null): Date | null {
  const direct = toDate(value);
  if (direct) return direct;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of ["at", "ts", "timestamp", "lastBeatAt", "lastTickAt", "beatAt", "updatedAt", "time"]) {
      const d = toDate(obj[key]);
      if (d) return d;
    }
  }
  return updatedAt;
}

/** The `mode` field the engine writes into its heartbeat object, if any. */
export function parseHeartbeatSource(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const mode = (value as Record<string, unknown>).mode;
  return typeof mode === "string" && mode.trim() ? mode.trim().slice(0, 20) : null;
}

/**
 * Live when a beat arrived in the last two minutes (whatever wrote it: an external worker or a
 * cron-driven tick can be polling even when this process has WORKER_MODE=off); otherwise Off when
 * polling is disabled or never started, else Stalled.
 */
export function workerStatus(lastBeatAt: Date | null, mode: WorkerMode, now: Date, beatSource: string | null = null): WorkerStatus {
  const fresh = lastBeatAt !== null && now.getTime() - lastBeatAt.getTime() < WORKER_LIVE_MS;
  const state: WorkerState = fresh ? "live" : mode === "off" || lastBeatAt === null ? "off" : "stalled";
  return { state, mode, lastBeatAt: lastBeatAt ? lastBeatAt.toISOString() : null, beatSource };
}

export interface FeedStats {
  newLastHour: number;
  newLast24h: number;
  priceDropsLast24h: number;
  activeSearches: number;
  totalSearches: number;
  enabledChannels: number;
  worker: WorkerStatus;
}

export async function getFeedStats(db: Db, opts: { now: Date; workerMode: WorkerMode }): Promise<FeedStats> {
  const { now } = opts;
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const [matchCounts, searchCounts, channelCounts, heartbeat] = await Promise.all([
    db
      .select({
        newLastHour: sql<number>`count(*) filter (where ${searchMatches.firstMatchedAt} >= ${hourAgo.toISOString()}::timestamptz)`,
        newLast24h: sql<number>`count(*) filter (where ${searchMatches.firstMatchedAt} >= ${dayAgo.toISOString()}::timestamptz)`,
        drops: sql<number>`count(*) filter (where ${searchMatches.lastEvent} = 'price_drop' and ${searchMatches.lastEventAt} >= ${dayAgo.toISOString()}::timestamptz)`,
      })
      .from(searchMatches)
      .where(and(eq(searchMatches.silent, false), gte(searchMatches.lastEventAt, dayAgo))),
    db
      .select({ total: count(), active: sql<number>`count(*) filter (where ${searches.enabled})` })
      .from(searches),
    db.select({ n: count() }).from(notificationChannels).where(eq(notificationChannels.enabled, true)),
    db.select().from(appSettings).where(eq(appSettings.key, WORKER_HEARTBEAT_KEY)).limit(1),
  ]);

  const beat = heartbeat[0];
  return {
    newLastHour: Number(matchCounts[0]?.newLastHour ?? 0),
    newLast24h: Number(matchCounts[0]?.newLast24h ?? 0),
    priceDropsLast24h: Number(matchCounts[0]?.drops ?? 0),
    activeSearches: Number(searchCounts[0]?.active ?? 0),
    totalSearches: Number(searchCounts[0]?.total ?? 0),
    enabledChannels: Number(channelCounts[0]?.n ?? 0),
    worker: workerStatus(
      beat ? parseWorkerHeartbeat(beat.value, beat.updatedAt) : null,
      opts.workerMode,
      now,
      beat ? parseHeartbeatSource(beat.value) : null,
    ),
  };
}

/** Searches for the filter dropdown. */
export async function listSearchOptions(db: Db): Promise<Array<{ id: number; name: string }>> {
  return db.select({ id: searches.id, name: searches.name }).from(searches).orderBy(searches.name);
}

// --- Mutations --------------------------------------------------------------------------------

/** Returns the listing id of the updated match, or null when it does not exist. */
export async function setMatchDismissed(db: Db, matchId: number, dismissed: boolean): Promise<number | null> {
  const [row] = await db
    .update(searchMatches)
    .set({ dismissed })
    .where(eq(searchMatches.id, matchId))
    .returning({ listingId: searchMatches.listingId });
  return row?.listingId ?? null;
}

export async function setMatchSeen(db: Db, matchId: number, seen: boolean): Promise<number | null> {
  const [row] = await db
    .update(searchMatches)
    .set({ seen })
    .where(eq(searchMatches.id, matchId))
    .returning({ listingId: searchMatches.listingId });
  return row?.listingId ?? null;
}

/**
 * Mark the matches countUnseen() counts for these filters as seen ("Mark all seen" on a filtered
 * feed only clears what it shows); returns how many changed.
 */
export async function markAllMatchesSeen(db: Db, filters: FeedFilters): Promise<number> {
  const unseen = db
    .select({ id: searchMatches.id })
    .from(searchMatches)
    .innerJoin(listings, eq(listings.id, searchMatches.listingId))
    .where(and(...unseenConditions(filters)));
  const rows = await db
    .update(searchMatches)
    .set({ seen: true })
    .where(inArray(searchMatches.id, unseen))
    .returning({ id: searchMatches.id });
  return rows.length;
}
