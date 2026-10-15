/**
 * Automatic AI evaluation of a run's alert-worthy matches (searches with aiEvaluate). The first few are
 * awaited, within a time budget, before the run notifies, so their alerts carry Claude's verdict; the
 * rest, and any still running when the budget is up, finish in the background. Which events get
 * evaluated (non-silent ones, one call per listing, the 24 h re-evaluation skip) is decided by
 * evaluateMatchEvents; Claude calls are limited process-wide by the AI module.
 */
import { aiStatus, evaluateMatchEvents } from "../ai";
import type { Db } from "../db";
import type { MatchEvent } from "../events";
import { withTimeout } from "./async";
import { errorMessage, log } from "./log";

/** Alerts that wait for their evaluation (notify sends the first 5 matches of a run individually). */
export const AI_BEFORE_ALERT_MAX = 5;
/** How long a run waits for those evaluations before alerting without them. */
export const AI_BEFORE_ALERT_TIMEOUT_MS = 20_000;
/** Beyond this many matches waiting for a background evaluation we drop new ones rather than pile up API spend. */
const MAX_BACKLOG = 50;

interface AiQueueState {
  running: Set<Promise<void>>;
  /** Matches in running batches. */
  backlog: number;
}

const globalForAi = globalThis as unknown as { __flipwatchAutoAi?: AiQueueState };

function state(): AiQueueState {
  globalForAi.__flipwatchAutoAi ??= { running: new Set(), backlog: 0 };
  return globalForAi.__flipwatchAutoAi;
}

function aiConfigured(): boolean {
  try {
    return aiStatus().configured;
  } catch (err) {
    log.warn(`AI status check failed: ${errorMessage(err)}`);
    return false;
  }
}

/** Start evaluating a batch; tracked for aiQueueIdle(). Never rejects. */
function startBatch(db: Db, events: MatchEvent[], now: Date): Promise<void> {
  const q = state();
  q.backlog += events.length;
  const batch: Promise<void> = Promise.resolve()
    .then(() => evaluateMatchEvents(db, events, { now }))
    .then(({ errors }) => {
      for (const { listingId, error } of errors) log.warn(`AI evaluation of listing ${listingId} failed: ${error}`);
    })
    .catch((err) => log.warn(`AI evaluation failed: ${errorMessage(err)}`))
    .finally(() => {
      q.backlog -= events.length;
      q.running.delete(batch);
    });
  q.running.add(batch);
  return batch;
}

/** Searches that only alert on a minimum AI score wait this long for every evaluation of a run. */
export const AI_GATED_TIMEOUT_MS = 5 * 60_000;
/** …for at most this many matches (the rest are evaluated in the background and alert on a later run). */
export const AI_GATED_MAX = 20;

/**
 * Evaluate a run's alert-worthy events: waits (at most `timeoutMs`) for the first `waitFor`, queues the
 * rest in the background. Never throws.
 */
export async function evaluateBeforeAlerting(
  db: Db,
  events: readonly MatchEvent[],
  now = new Date(),
  timeoutMs = AI_BEFORE_ALERT_TIMEOUT_MS,
  waitFor = AI_BEFORE_ALERT_MAX,
): Promise<void> {
  const wanted = events.filter((e) => !e.silent);
  if (wanted.length === 0 || !aiConfigured()) return;

  const first = startBatch(db, wanted.slice(0, waitFor), now);
  const rest = wanted.slice(waitFor);
  const room = Math.max(0, MAX_BACKLOG - state().backlog);
  if (rest.length > room) log.warn(`AI queue full; skipping evaluation of ${rest.length - room} match(es)`);
  if (rest.length > 0 && room > 0) void startBatch(db, rest.slice(0, room), now);

  await withTimeout(() => first, timeoutMs).catch(() =>
    log.warn(`AI evaluation is taking longer than ${Math.round(timeoutMs / 1_000)} s; alerting without it`),
  );
}

/** Resolves once every started AI evaluation has finished (tests, graceful shutdown). */
export async function aiQueueIdle(): Promise<void> {
  const q = state();
  while (q.running.size > 0) await Promise.allSettled([...q.running]);
}
