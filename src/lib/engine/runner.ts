/** Running one saved search end to end, and previewing an unsaved one. */
import { and, eq, gte, isNull, max } from "drizzle-orm";
import type { Db } from "../db";
import { scrapeRuns, searches, type MarketplaceHealth, type Search } from "../db/schema";
import type { MatchEvent } from "../events";
import { currencyForCountry } from "../locations";
import type { MarketplaceAdapter } from "../marketplaces/types";
import { notifyMatchEvents } from "../notify";
import type { SearchInput } from "../search-schema";
import type { MarketplaceId, ScrapedListing, SearchQuery } from "../types";
import { AI_GATED_MAX, AI_GATED_TIMEOUT_MS, evaluateBeforeAlerting } from "./ai-queue";
import { isCancellation, mapWithConcurrency, withTimeout } from "./async";
import {
  adapterUnavailableReason,
  buildSearchQuery,
  fetchMarketplace,
  resolveAdapter,
  searchUrlFor,
  uniqueMarketplaces,
} from "./fetch";
import { createListingFilter, parseQuery, type ListingFilter } from "./filters";
import { markGoneListings, upsertListings } from "./listings";
import { errorMessage, log } from "./log";
import {
  loadMarketplaceHealth,
  loadMarketplaceHealthOf,
  recordMarketplaceFailure,
  recordMarketplaceSuccess,
} from "./marketplace-health";
import { isBlockedSeller, loadBlockedSellers } from "../queries/blocked-sellers";
import { recordMatches, undeliveredEvents, type MatchCandidate } from "./matches";
import { queueAutoPriceChecks } from "./price-check-queue";
import { sanitizeResults } from "./sanitize";
import type {
  MarketplaceRunResult,
  PreviewOptions,
  PreviewResult,
  RunSearchOptions,
  RunSearchResult,
} from "./types";

/** Marketplaces of one search are queried in parallel (the gate still serializes per marketplace). */
const MARKETPLACE_CONCURRENCY = 5;
const MAX_LAST_ERROR_LENGTH = 1_000;
/** A hung notification channel must not stall the scheduler; delivery keeps going in the background. */
const NOTIFY_TIMEOUT_MS = 60_000;
const CANCELLED = "Cancelled";

interface RunContext {
  db: Db;
  /** Blocked sellers (see queries/blocked-sellers): their listings are stored but never matched. */
  blocked: ReadonlySet<string>;
  search: Search;
  query: SearchQuery;
  filter: ListingFilter;
  health: Map<MarketplaceId, MarketplaceHealth>;
  /**
   * Start of this search's latest successful run per marketplace (since its definition last changed).
   * A marketplace without one is on its first run.
   */
  lastSuccessAt: Map<MarketplaceId, Date>;
  /** Clock anchored at opts.now so injected times stay consistent through a run. */
  clock: () => Date;
  opts: RunSearchOptions;
}

type RunCounts = Pick<MarketplaceRunResult, "resultCount" | "newCount" | "priceDropCount">;

interface MarketplaceOutcome {
  result: MarketplaceRunResult;
  events: MatchEvent[];
}

function emptyResult(marketplace: MarketplaceId, extra: Partial<MarketplaceRunResult> = {}): MarketplaceRunResult {
  return { marketplace, resultCount: 0, matchedCount: 0, newCount: 0, priceDropCount: 0, durationMs: 0, ...extra };
}

async function quietly(what: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    log.error(`${what}: ${errorMessage(err)}`);
  }
}

/** Latest successful run per marketplace; runs from before the search's definition last changed don't count. */
async function lastSuccessfulRuns(db: Db, search: Search): Promise<Map<MarketplaceId, Date>> {
  const rows = await db
    .select({ marketplace: scrapeRuns.marketplace, startedAt: max(scrapeRuns.startedAt) })
    .from(scrapeRuns)
    .where(
      and(
        eq(scrapeRuns.searchId, search.id),
        isNull(scrapeRuns.error),
        search.definitionChangedAt ? gte(scrapeRuns.startedAt, search.definitionChangedAt) : undefined,
      ),
    )
    .groupBy(scrapeRuns.marketplace);
  return new Map(rows.flatMap((r) => (r.startedAt ? [[r.marketplace, r.startedAt] as const] : [])));
}

/** Persist results, apply filters, record matches. Returns counts and events. */
async function processResults(ctx: RunContext, marketplace: MarketplaceId, scraped: readonly ScrapedListing[]) {
  const { db, search } = ctx;
  const clean = sanitizeResults(scraped, marketplace, currencyForCountry(search.location.countryCode));
  const stored = await upsertListings(db, marketplace, clean, ctx.clock);
  const now = ctx.clock();
  const previousRunAt = ctx.lastSuccessAt.get(marketplace);

  const candidates: MatchCandidate[] = [];
  for (const item of clean) {
    const listing = stored.get(item.externalId)?.listing;
    if (!listing) continue;
    if (isBlockedSeller(ctx.blocked, listing)) continue;
    const verdict = ctx.filter(listing, now);
    if (!verdict.pass) continue;
    // Stale only matters for listings that went up while the search wasn't looking (see MatchCandidate).
    const postedSincePreviousRun = !!previousRunAt && !!listing.postedAt && listing.postedAt.getTime() > previousRunAt.getTime();
    candidates.push({ listing, staleCatchUp: verdict.stale && postedSincePreviousRun });
  }

  const events = await recordMatches(db, search, candidates, { now, firstRun: !previousRunAt });
  const returned = [...stored.values()].map((s) => s.listing);
  await quietly(`Could not mark vanished ${marketplace} listings of search ${search.id} as gone`, () =>
    markGoneListings(db, search.id, marketplace, returned, now),
  );
  return {
    resultCount: clean.length,
    matchedCount: candidates.length,
    newCount: events.filter((e) => e.type === "new").length,
    priceDropCount: events.filter((e) => e.type === "price_drop").length,
    events,
  };
}

/** Why a marketplace is being left alone right now, or null. */
function backoffReason(health: MarketplaceHealth | undefined, now: Date): string | null {
  if (!health?.backoffUntil || health.backoffUntil.getTime() <= now.getTime()) return null;
  return `Backing off until ${health.backoffUntil.toISOString()}${health.lastError ? ` (${health.lastError})` : ""}`;
}

/** Thrown from the gate when another search put the marketplace into backoff while this one waited. */
class BackoffSkip extends Error {}

async function runMarketplace(ctx: RunContext, marketplace: MarketplaceId): Promise<MarketplaceOutcome> {
  const { db, search, opts } = ctx;
  const adapter: MarketplaceAdapter | undefined = resolveAdapter(marketplace, opts.adapters);
  if (!adapter) return { result: emptyResult(marketplace, { skipped: "Unknown marketplace" }), events: [] };

  const unavailable = adapterUnavailableReason(adapter, search.location.countryCode);
  if (unavailable) return { result: emptyResult(marketplace, { skipped: unavailable }), events: [] };

  const backingOff = opts.force ? null : backoffReason(ctx.health.get(marketplace), ctx.clock());
  if (backingOff) return { result: emptyResult(marketplace, { skipped: backingOff }), events: [] };

  let startedAtMs = Date.now();
  let startedAt = ctx.clock();
  const record = (values: { durationMs: number; error: string | null } & Partial<RunCounts>) =>
    quietly(`Could not record ${marketplace} run for search ${search.id}`, () =>
      db.insert(scrapeRuns).values({ searchId: search.id, marketplace, startedAt, ...values }),
    );

  let scraped: ScrapedListing[];
  try {
    scraped = await fetchMarketplace(adapter, ctx.query, opts, async () => {
      // Searches queue at the gate: one that got blocked a moment ago must not be followed by the rest.
      if (!opts.force) {
        const reason = backoffReason(await loadMarketplaceHealthOf(db, marketplace), ctx.clock());
        if (reason) throw new BackoffSkip(reason);
      }
      startedAtMs = Date.now();
      startedAt = ctx.clock();
    });
  } catch (err) {
    const durationMs = Date.now() - startedAtMs;
    if (err instanceof BackoffSkip) return { result: emptyResult(marketplace, { skipped: err.message }), events: [] };
    if (opts.signal?.aborted && isCancellation(err)) {
      return { result: emptyResult(marketplace, { skipped: CANCELLED, durationMs }), events: [] };
    }
    const error = errorMessage(err);
    log.warn(`${adapter.displayName} failed for search ${search.id} ("${search.name}"): ${error}`);
    await quietly(`Could not update ${marketplace} health`, () => recordMarketplaceFailure(db, marketplace, err, ctx.clock()));
    await record({ durationMs, error });
    return { result: emptyResult(marketplace, { durationMs, error }), events: [] };
  }

  await quietly(`Could not update ${marketplace} health`, () => recordMarketplaceSuccess(db, marketplace, ctx.clock()));
  try {
    const { events, matchedCount, ...counts } = await processResults(ctx, marketplace, scraped);
    const durationMs = Date.now() - startedAtMs;
    await record({ ...counts, durationMs, error: null });
    return { result: { marketplace, ...counts, matchedCount, durationMs }, events };
  } catch (err) {
    // Our fault (database), not the marketplace's: no backoff, and the run doesn't count as successful.
    const durationMs = Date.now() - startedAtMs;
    const error = `Processing failed: ${errorMessage(err)}`;
    log.error(`${adapter.displayName} results for search ${search.id} could not be saved`, err);
    await record({ durationMs, error, resultCount: scraped.length });
    return { result: emptyResult(marketplace, { durationMs, error, resultCount: scraped.length }), events: [] };
  }
}

function summarizeErrors(results: readonly MarketplaceRunResult[]): string | null {
  const errors = results.filter((r) => r.error).map((r) => `${r.marketplace}: ${r.error}`);
  const queried = results.some((r) => !r.skipped);
  const skipped = results.filter((r) => r.skipped && r.skipped !== CANCELLED).map((r) => `${r.marketplace}: ${r.skipped}`);
  const parts = errors.length > 0 ? errors : !queried ? skipped : [];
  if (parts.length === 0) return null;
  const text = parts.join("; ");
  return text.length > MAX_LAST_ERROR_LENGTH ? `${text.slice(0, MAX_LAST_ERROR_LENGTH - 1)}…` : text;
}

/**
 * Run a saved search once: query its marketplaces, store listings, record matches/price drops,
 * update health and backoff, then alert on non-silent events. One marketplace failing never
 * affects the others. Throws only when the search does not exist.
 */
export async function runSearch(db: Db, searchId: number, opts: RunSearchOptions = {}): Promise<RunSearchResult> {
  const clockStart = Date.now();
  const startedAt = opts.now ?? new Date();
  const clock = () => new Date(startedAt.getTime() + (Date.now() - clockStart));

  const [search] = await db.select().from(searches).where(eq(searches.id, searchId)).limit(1);
  if (!search) throw new Error(`Search ${searchId} not found`);

  const [health, lastSuccessAt, blocked] = await Promise.all([loadMarketplaceHealth(db), lastSuccessfulRuns(db, search), loadBlockedSellers(db)]);
  const ctx: RunContext = {
    db,
    blocked,
    search,
    query: buildSearchQuery(search, parseQuery(search.query)),
    filter: createListingFilter(search),
    health,
    lastSuccessAt,
    clock,
    opts,
  };

  const marketplaces = uniqueMarketplaces(search.marketplaces);
  const settled = await mapWithConcurrency(marketplaces, MARKETPLACE_CONCURRENCY, (mp) => runMarketplace(ctx, mp));
  const outcomes = settled.map((s, i): MarketplaceOutcome => {
    if (s.status === "fulfilled") return s.value;
    log.error(`Unexpected failure running ${marketplaces[i]} for search ${searchId}`, s.reason);
    return { result: emptyResult(marketplaces[i], { error: errorMessage(s.reason) }), events: [] };
  });
  const results = outcomes.map((o) => o.result);
  const events = outcomes.flatMap((o) => o.events);

  await quietly(`Could not update search ${searchId}`, () =>
    db.update(searches).set({ lastRunAt: startedAt, lastError: summarizeErrors(results) }).where(eq(searches.id, searchId)),
  );

  const alertable = events.filter((e) => !e.silent);
  if (alertable.length > 0) {
    const drops = alertable.filter((e) => e.type === "price_drop").length;
    log.info(`Search ${searchId} ("${search.name}"): ${alertable.length - drops} new, ${drops} price drop(s)`);
  }
  // Before notifying, so the alerts can carry Claude's verdict (bounded; the rest finishes in the background).
  if (search.aiEvaluate && alertable.length > 0) {
    // With a minimum AI score, alerts depend on the evaluation: wait for (almost) all of them.
    if (search.notifyMinAiScore != null) await evaluateBeforeAlerting(db, alertable, clock(), AI_GATED_TIMEOUT_MS, AI_GATED_MAX);
    else await evaluateBeforeAlerting(db, alertable, clock());
  }
  if (opts.notify !== false) {
    // Alerts an earlier run couldn't deliver (every channel down) get another chance.
    const retries: MatchEvent[] = [];
    await quietly(`Could not load undelivered alerts of search ${searchId}`, async () => {
      retries.push(...(await undeliveredEvents(db, searchId, clock(), alertable.map((e) => e.matchId))));
    });
    const toNotify = [...alertable, ...retries];
    // Searches that alert on a checked profit: start price checks; their alerts go out on a later run.
    if (search.notifyMinProfitPct != null) await queueAutoPriceChecks(db, search, toNotify, clock());
    if (toNotify.length > 0) {
      await quietly(`Notifications for search ${searchId} failed`, () =>
        withTimeout(() => notifyMatchEvents(db, toNotify), NOTIFY_TIMEOUT_MS),
      );
    }
  }

  return { searchId, startedAt, finishedAt: clock(), marketplaces: results, events };
}

/** Run a search definition once without saving anything ("Test search" in the editor). */
export async function previewSearch(input: SearchInput, opts: PreviewOptions = {}): Promise<PreviewResult[]> {
  const now = opts.now ?? new Date();
  const query = buildSearchQuery(input, parseQuery(input.query));
  const filter = createListingFilter(input);
  const fallbackCurrency = currencyForCountry(input.location.countryCode);
  const marketplaces = uniqueMarketplaces(input.marketplaces);

  const settled = await mapWithConcurrency(marketplaces, MARKETPLACE_CONCURRENCY, async (marketplace): Promise<PreviewResult> => {
    const adapter = resolveAdapter(marketplace, opts.adapters);
    if (!adapter) return { marketplace, listings: [], error: "Unknown marketplace" };
    const searchUrl = searchUrlFor(adapter, query);
    const unavailable = adapterUnavailableReason(adapter, input.location.countryCode);
    if (unavailable) return { marketplace, listings: [], error: unavailable, searchUrl };

    try {
      const scraped = sanitizeResults(await fetchMarketplace(adapter, query, opts), marketplace, fallbackCurrency);
      const listings = scraped.map((listing) => {
        const verdict = filter(listing, now);
        return { ...listing, passesFilters: verdict.pass, rejectReason: verdict.reason, stale: verdict.stale };
      });
      return { marketplace, listings, searchUrl };
    } catch (err) {
      return { marketplace, listings: [], error: errorMessage(err), searchUrl };
    }
  });

  return settled.map((s, i) =>
    s.status === "fulfilled" ? s.value : { marketplace: marketplaces[i], listings: [], error: errorMessage(s.reason) },
  );
}
