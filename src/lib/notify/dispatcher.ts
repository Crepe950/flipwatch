import { and, asc, desc, eq, inArray, lte } from "drizzle-orm";
import { config } from "../config";
import type { Db } from "../db";
import {
  aiEvaluations,
  listings,
  notificationChannels,
  priceChecks,
  searchMatches,
  searches,
  type AiEvaluation,
  type NotificationChannel,
  type Search,
  type SearchMatch,
} from "../db/schema";
import { checkedValue, meetsProfitTarget, type CheckedValue } from "../ai/checked-value";
import type { MatchEvent } from "../events";
import { deliverQueue, logAttempts, updateChannelStatus, type Attempt, type DeliveryOptions } from "./delivery";
import { errorMessage } from "./errors";
import { buildDigestAlert, buildMatchAlert, normalizeAppUrl, type FormatOptions, type MatchAlertInput } from "./format";
import type { Alert } from "./types";

export const MAX_INDIVIDUAL_ALERTS = 5;

export interface NotifyOptions extends DeliveryOptions {
  now?: Date;
  /** Defaults to config.appUrl. */
  appUrl?: string;
  /** Individual alerts per search per run before the rest are bundled into a digest (default 5). */
  maxIndividualAlerts?: number;
  log?: (message: string) => void;
}

const defaultLog = (message: string) => console.warn(`[notify] ${message}`);

/** Already alerted for the match's latest event (engine retries must not double-notify). */
export function alreadyNotified(match: Pick<SearchMatch, "notifiedAt" | "lastEventAt">): boolean {
  return match.notifiedAt !== null && match.notifiedAt.getTime() >= match.lastEventAt.getTime();
}

/**
 * Per-search alert preferences. The engine is expected to apply these too; enforcing them here
 * keeps them honoured regardless. A missing deal score never blocks an alert, but a minimum AI score
 * does: a listing Claude hasn't scored yet is held back (a later run retries it once it has been). So does a
 * minimum checked profit: held back until a price check (started by the engine) shows enough.
 */
export function suppressedBySearch(
  search: Search,
  match: SearchMatch,
  event: MatchEvent,
  ai: AiEvaluation | null = null,
  checked: CheckedValue | null = null,
  priceCents: number | null = null,
): boolean {
  if (event.type === "price_drop" && !search.notifyPriceDrops) return true;
  if (search.notifyMinAiScore != null && (ai === null || ai.dealScore < search.notifyMinAiScore)) return true;
  if (search.notifyMinProfitPct != null && !meetsProfitTarget(checked, priceCents, search.notifyMinProfitPct)) return true;
  return search.notifyMinDealScore != null && match.dealScore != null && match.dealScore < search.notifyMinDealScore;
}

/** Enabled channels for a search: its selection, or every enabled channel when it has none (null). */
export function channelsForSearch(search: Pick<Search, "notifyChannelIds">, enabled: NotificationChannel[]): NotificationChannel[] {
  if (search.notifyChannelIds == null) return enabled;
  const wanted = new Set(Array.isArray(search.notifyChannelIds) ? search.notifyChannelIds : []);
  return enabled.filter((c) => wanted.has(c.id));
}

/** First `max` matches individually, the remainder as one digest. */
export function buildSearchAlerts(search: Search, inputs: MatchAlertInput[], fmt: FormatOptions, max = MAX_INDIVIDUAL_ALERTS): Alert[] {
  const alerts = inputs.slice(0, max).map((input) => buildMatchAlert(input, fmt));
  const overflow = inputs.slice(max);
  if (overflow.length) alerts.push(buildDigestAlert(search, overflow, fmt));
  return alerts;
}

/** Last event per match wins (e.g. "new" then "price_drop" in one batch), keeping first-seen order. */
function latestPerMatch(events: MatchEvent[]): MatchEvent[] {
  const byMatch = new Map<number, MatchEvent>();
  for (const event of events) byMatch.set(event.matchId, event);
  return [...byMatch.values()];
}

const unique = (values: number[]) => [...new Set(values)];

/** Deliver alerts for engine events. Never throws; problems are logged and recorded per channel. */
export async function notifyMatchEvents(db: Db, events: MatchEvent[], opts: NotifyOptions = {}): Promise<void> {
  const log = opts.log ?? defaultLog;
  try {
    await dispatch(db, events, opts, log);
  } catch (err) {
    log(`notifyMatchEvents failed: ${errorMessage(err)}`);
  }
}

async function dispatch(db: Db, events: MatchEvent[], opts: NotifyOptions, log: (message: string) => void): Promise<void> {
  const pending = latestPerMatch((Array.isArray(events) ? events : []).filter((e) => e && !e.silent));
  if (!pending.length) return;

  const matchRows = await db.select().from(searchMatches).where(inArray(searchMatches.id, unique(pending.map((e) => e.matchId))));
  const matchById = new Map(matchRows.map((m) => [m.id, m]));
  const fresh = pending.filter((e) => {
    const match = matchById.get(e.matchId);
    return match !== undefined && !alreadyNotified(match);
  });
  if (!fresh.length) return;

  const freshMatches = fresh.map((e) => matchById.get(e.matchId)!);
  const searchIds = unique(freshMatches.map((m) => m.searchId));
  const listingIds = unique(freshMatches.map((m) => m.listingId));
  const [searchRows, listingRows, aiRows, checkRows, channelRows] = await Promise.all([
    db.select().from(searches).where(inArray(searches.id, searchIds)),
    db.select().from(listings).where(inArray(listings.id, listingIds)),
    db
      .selectDistinctOn([aiEvaluations.listingId])
      .from(aiEvaluations)
      .where(inArray(aiEvaluations.listingId, listingIds))
      .orderBy(aiEvaluations.listingId, desc(aiEvaluations.createdAt), desc(aiEvaluations.id)),
    db
      .selectDistinctOn([priceChecks.listingId], { listingId: priceChecks.listingId, result: priceChecks.result })
      .from(priceChecks)
      .where(inArray(priceChecks.listingId, listingIds))
      .orderBy(priceChecks.listingId, desc(priceChecks.createdAt), desc(priceChecks.id)),
    db.select().from(notificationChannels).where(eq(notificationChannels.enabled, true)).orderBy(asc(notificationChannels.id)),
  ]);
  if (!channelRows.length) return;

  const searchById = new Map(searchRows.map((s) => [s.id, s]));
  const listingById = new Map(listingRows.map((l) => [l.id, l]));
  const aiByListing = new Map<number, AiEvaluation>(aiRows.map((a) => [a.listingId, a]));
  const checkByListing = new Map(checkRows.map((r) => [r.listingId, r.result]));

  const bySearch = new Map<number, MatchAlertInput[]>();
  for (const event of fresh) {
    const match = matchById.get(event.matchId)!;
    const search = searchById.get(match.searchId);
    const listing = listingById.get(match.listingId);
    const ai = listing ? (aiByListing.get(listing.id) ?? null) : null;
    const checked = listing ? checkedValue(checkByListing.get(listing.id), listing.priceCents) : null;
    if (!search || !listing || suppressedBySearch(search, match, event, ai, checked, listing.priceCents)) continue;
    const group = bySearch.get(search.id) ?? [];
    group.push({ event, search, listing, match, ai, checked });
    bySearch.set(search.id, group);
  }

  const fmt: FormatOptions = { appUrl: normalizeAppUrl(opts.appUrl ?? config.appUrl), now: opts.now ?? new Date() };
  const queues = new Map<number, { channel: NotificationChannel; alerts: Alert[] }>();
  for (const [searchId, inputs] of bySearch) {
    const search = searchById.get(searchId)!;
    const targets = channelsForSearch(search, channelRows);
    if (!targets.length) continue;
    const alerts = buildSearchAlerts(search, inputs, fmt, opts.maxIndividualAlerts ?? MAX_INDIVIDUAL_ALERTS);
    for (const channel of targets) {
      const queue = queues.get(channel.id) ?? { channel, alerts: [] };
      queue.alerts.push(...alerts);
      queues.set(channel.id, queue);
    }
  }
  if (!queues.size) return;

  // Channels run concurrently; deliverQueue never rejects, so one channel can't sink another.
  const results = await Promise.all(
    [...queues.values()].map(async ({ channel, alerts }) => ({ channel, attempts: await deliverQueue(db, channel, alerts, opts) })),
  );

  const delivered = new Set(results.flatMap(({ attempts }) => attempts.filter((a) => a.ok).flatMap((a) => a.alert.matchIds)));
  await markNotified(db, freshMatches.filter((m) => delivered.has(m.id)), opts.now, log);

  for (const { channel, attempts } of results) {
    await record(db, channel, attempts, log);
    for (const failure of attempts.filter((a) => !a.ok && !a.skipped)) {
      log(`${channel.type} channel "${channel.name}" (#${channel.id}) failed: ${failure.error}`);
    }
  }
}

/**
 * Stamp notifiedAt only while the event we alerted on is still the match's latest (a concurrent
 * engine run may have recorded a newer one, which then still deserves its own alert). The +1 ms
 * absorbs Postgres' microsecond precision versus JS milliseconds.
 */
async function markNotified(db: Db, matches: SearchMatch[], now: Date | undefined, log: (message: string) => void): Promise<void> {
  for (const match of matches) {
    const eventAt = new Date(match.lastEventAt.getTime() + 1);
    const stamp = new Date(Math.max((now ?? new Date()).getTime(), eventAt.getTime()));
    try {
      await db
        .update(searchMatches)
        .set({ notifiedAt: stamp })
        .where(and(eq(searchMatches.id, match.id), lte(searchMatches.lastEventAt, eventAt)));
    } catch (err) {
      log(`Could not mark match #${match.id} as notified: ${errorMessage(err)}`);
    }
  }
}

async function record(db: Db, channel: NotificationChannel, attempts: Attempt[], log: (message: string) => void): Promise<void> {
  try {
    await logAttempts(db, channel.id, attempts);
  } catch (err) {
    log(`Could not write notification_log for channel #${channel.id}: ${errorMessage(err)}`);
  }
  try {
    await updateChannelStatus(db, channel.id, attempts);
  } catch (err) {
    log(`Could not update status of channel #${channel.id}: ${errorMessage(err)}`);
  }
}
