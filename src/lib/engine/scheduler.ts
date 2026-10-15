/**
 * Scheduling: claim due searches atomically and run them, plus the per-process polling loop.
 *
 * Claiming is a compare-and-set UPDATE on next_run_at, so any number of pollers (inline scheduler,
 * external worker, replicas, /api/cron/tick) can run concurrently without double-running a search.
 * A claim leases the search for max(interval, 5 min); when the run finishes the lease is replaced
 * by finish + interval. A crashed worker's claim simply expires.
 */
import { and, asc, count, eq, isNull, lte, ne, or, sql } from "drizzle-orm";
import { config } from "../config";
import type { Db } from "../db";
import { searches, type Search } from "../db/schema";
import { aiQueueIdle } from "./ai-queue";
import { CancelledError, mapWithConcurrency, raceSignal } from "./async";
import { ebayQuotaFloorSec } from "./ebay-quota";
import { resolveAdapter, uniqueMarketplaces } from "./fetch";
import { writeHeartbeat } from "./heartbeat";
import { errorMessage, log } from "./log";
import { runRetentionIfDue } from "./retention";
import { runSearch } from "./runner";
import type { AdapterOverrides, FetchOptions, Scheduler, TickOptions, TickResult } from "./types";

export const DEFAULT_TICK_CONCURRENCY = 3;
export const DEFAULT_CLAIM_LIMIT = 10;
/** A claimed search can't be claimed again for at least this long, even if its interval is shorter. */
export const CLAIM_LEASE_SEC = 300;

const usesEbay = sql`${searches.marketplaces} @> '["ebay"]'::jsonb`;

/** Enabled searches that poll eBay (sharing its daily quota), optionally leaving one search out. */
export async function countEnabledEbaySearches(db: Db, excludeSearchId?: number): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(searches)
    .where(and(eq(searches.enabled, true), usesEbay, excludeSearchId === undefined ? undefined : ne(searches.id, excludeSearchId)));
  return Number(row?.n ?? 0);
}

/** The eBay quota floor for the searches currently enabled. */
export async function loadEbayQuotaFloorSec(db: Db): Promise<number> {
  return ebayQuotaFloorSec(await countEnabledEbaySearches(db));
}

/** The quota only binds when eBay is actually queried (credentials set). */
export function ebayConfigured(adapters?: AdapterOverrides): boolean {
  try {
    return resolveAdapter("ebay", adapters)?.status().ok === true;
  } catch {
    return false;
  }
}

export interface IntervalFloors {
  /** From ebayQuotaFloorSec(); applies to searches that include eBay. */
  ebayQuotaSec?: number;
}

/**
 * Effective poll interval: the search's own, the global floor, every adapter's politeness floor and,
 * for searches that include eBay, the eBay daily-quota floor.
 */
export function effectiveIntervalSec(
  search: Pick<Search, "pollIntervalSec" | "marketplaces">,
  adapters?: AdapterOverrides,
  floors: IntervalFloors = {},
): number {
  const marketplaces = uniqueMarketplaces(search.marketplaces);
  const adapterFloors = marketplaces.map((mp) => resolveAdapter(mp, adapters)?.minIntervalSec ?? 0);
  const quotaFloor = marketplaces.includes("ebay") ? (floors.ebayQuotaSec ?? 0) : 0;
  return Math.max(search.pollIntervalSec, config.minPollIntervalSec, ...adapterFloors, quotaFloor, 1);
}

/** ±10 % so searches created together drift apart instead of hitting marketplaces in bursts. */
export function withJitter(seconds: number, random: () => number = Math.random): number {
  return seconds * (0.9 + random() * 0.2);
}

export interface Claim {
  searchId: number;
  intervalSec: number;
  leaseUntil: Date;
}

const isDue = (now: Date) => and(eq(searches.enabled, true), or(isNull(searches.nextRunAt), lte(searches.nextRunAt, now)));

/** Atomically claim up to `limit` due searches. Each claim is won by exactly one caller. */
export async function claimDueSearches(
  db: Db,
  now: Date,
  opts: { limit?: number; adapters?: AdapterOverrides } = {},
): Promise<Claim[]> {
  const due = await db
    .select({ id: searches.id, pollIntervalSec: searches.pollIntervalSec, marketplaces: searches.marketplaces })
    .from(searches)
    .where(isDue(now))
    .orderBy(sql`${searches.nextRunAt} asc nulls first`, asc(searches.id))
    .limit(opts.limit ?? DEFAULT_CLAIM_LIMIT);

  const claims: Claim[] = [];
  if (due.length === 0) return claims;
  const floors: IntervalFloors =
    due.some((s) => uniqueMarketplaces(s.marketplaces).includes("ebay")) && ebayConfigured(opts.adapters)
      ? { ebayQuotaSec: await loadEbayQuotaFloorSec(db) }
      : {};
  for (const search of due) {
    const intervalSec = withJitter(effectiveIntervalSec(search, opts.adapters, floors));
    const leaseUntil = new Date(now.getTime() + Math.max(intervalSec, CLAIM_LEASE_SEC) * 1000);
    const [won] = await db
      .update(searches)
      .set({ nextRunAt: leaseUntil })
      .where(and(eq(searches.id, search.id), isDue(now)))
      .returning({ id: searches.id });
    if (won) claims.push({ searchId: search.id, intervalSec, leaseUntil });
  }
  return claims;
}

/** Replace our lease with the real next run time, unless someone changed next_run_at meanwhile. */
async function settleClaim(db: Db, claim: Claim, nextRunAt: Date | null): Promise<void> {
  await db
    .update(searches)
    .set({ nextRunAt })
    .where(and(eq(searches.id, claim.searchId), eq(searches.nextRunAt, claim.leaseUntil)));
}

/** Claim every due search and run them (concurrency 3). Never throws for individual search failures. */
export async function tick(db: Db, opts: TickOptions = {}): Promise<TickResult> {
  const clockStart = Date.now();
  const base = opts.now ?? new Date();
  const clock = () => new Date(base.getTime() + (Date.now() - clockStart));
  const fetchOpts: FetchOptions = {
    adapterContext: opts.adapterContext,
    adapters: opts.adapters,
    gate: opts.gate,
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
  };

  if (opts.signal?.aborted) return { ranSearchIds: [], errors: [] };
  const claims = await claimDueSearches(db, base, { limit: opts.limit, adapters: opts.adapters });

  const outcomes = await mapWithConcurrency(claims, opts.concurrency ?? DEFAULT_TICK_CONCURRENCY, async (claim) => {
    if (opts.signal?.aborted) {
      // Not started: hand the search back so the next poller picks it up right away.
      await settleClaim(db, claim, null).catch(() => undefined);
      return { ran: false as const };
    }
    try {
      await runSearch(db, claim.searchId, { ...fetchOpts, now: clock() });
      return { ran: true as const };
    } catch (err) {
      log.error(`Search ${claim.searchId} failed: ${errorMessage(err)}`);
      return { ran: false as const, error: errorMessage(err) };
    } finally {
      const next = new Date(clock().getTime() + claim.intervalSec * 1000);
      await settleClaim(db, claim, next).catch((err) =>
        log.error(`Could not reschedule search ${claim.searchId}: ${errorMessage(err)}`),
      );
    }
  });

  const result: TickResult = { ranSearchIds: [], errors: [] };
  outcomes.forEach((outcome, i) => {
    const searchId = claims[i].searchId;
    if (outcome.status === "rejected") result.errors.push({ searchId, error: errorMessage(outcome.reason) });
    else if (outcome.value.ran) result.ranSearchIds.push(searchId);
    else if (outcome.value.error) result.errors.push({ searchId, error: outcome.value.error });
  });
  return result;
}

// --- polling loop --------------------------------------------------------------------------------

export interface SchedulerOptions {
  /** Reported in the heartbeat: "inline" | "external". Defaults to WORKER_MODE. */
  mode?: string;
  /** Pause between ticks (default SCHEDULER_TICK_MS). */
  tickMs?: number;
  /** Delay before the first tick (default 2 s, lets the web server finish booting). */
  initialDelayMs?: number;
  /** Passed to every tick (tests inject adapters/gate here). */
  tickOptions?: Omit<TickOptions, "now" | "signal">;
}

/** Heartbeat cadence while a long tick is running (ticks themselves beat at every loop). */
const HEARTBEAT_EVERY_MS = 30_000;
/** Don't rewrite the heartbeat more often than this (ticks run every few seconds). */
const HEARTBEAT_MIN_GAP_MS = 15_000;
/** How long stop() waits for background AI evaluations before giving up on them. */
const AI_DRAIN_MS = 10_000;

const globalForScheduler = globalThis as unknown as { __flipwatchScheduler?: Scheduler };

/**
 * Start the polling loop. One per process (kept on globalThis so Next dev HMR doesn't start a second
 * one); later calls return the running instance. stop() cancels pending marketplace requests,
 * waits for the in-flight tick and resolves when the loop is fully stopped.
 */
export function startScheduler(getDb: () => Promise<Db>, options: SchedulerOptions = {}): Scheduler {
  const running = globalForScheduler.__flipwatchScheduler;
  if (running) return running;

  const mode = options.mode ?? config.workerMode;
  const tickMs = Math.max(100, options.tickMs ?? config.schedulerTickMs);
  const controller = new AbortController();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;

  let lastBeatAt = 0;
  const beat = async (db: Db) => {
    if (Date.now() - lastBeatAt < HEARTBEAT_MIN_GAP_MS) return;
    try {
      await writeHeartbeat(db, { mode });
      lastBeatAt = Date.now();
    } catch (err) {
      log.warn(`Heartbeat failed: ${errorMessage(err)}`);
    }
  };
  const heartbeatTimer = setInterval(() => {
    if (inFlight) void getDb().then(beat, () => undefined);
  }, HEARTBEAT_EVERY_MS);
  heartbeatTimer.unref?.();

  const loop = async () => {
    const db = await getDb();
    await beat(db);
    const retention = await runRetentionIfDue(db).catch((err) => {
      log.error(`Retention failed: ${errorMessage(err)}`);
      return null;
    });
    if (retention) log.info(`Retention: deleted ${JSON.stringify(retention)}`);
    const result = await tick(db, { ...options.tickOptions, signal: controller.signal });
    for (const { searchId, error } of result.errors) log.warn(`Search ${searchId}: ${error}`);
  };

  const schedule = (delayMs: number) => {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = null;
      if (stopped || inFlight) return; // re-entrancy guard
      inFlight = loop()
        .catch((err) => log.error(`Scheduler tick failed: ${errorMessage(err)}`))
        .finally(() => {
          inFlight = null;
          schedule(tickMs);
        });
    }, delayMs);
  };

  const scheduler: Scheduler = {
    async stop() {
      if (!stopped) {
        stopped = true;
        if (timer) clearTimeout(timer);
        clearInterval(heartbeatTimer);
        controller.abort(new CancelledError("Scheduler stopped"));
        log.info("Scheduler stopping…");
      }
      await inFlight;
      await raceSignal(aiQueueIdle(), AbortSignal.timeout(AI_DRAIN_MS)).catch(() =>
        log.warn("Gave up waiting for background AI evaluations"),
      );
      if (globalForScheduler.__flipwatchScheduler === scheduler) globalForScheduler.__flipwatchScheduler = undefined;
    },
  };

  globalForScheduler.__flipwatchScheduler = scheduler;
  schedule(options.initialDelayMs ?? 2_000);
  log.info(`Scheduler started (mode ${mode}, tick every ${tickMs} ms)`);
  return scheduler;
}
