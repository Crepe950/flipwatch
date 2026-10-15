import { eq } from "drizzle-orm";
import type { Db } from "../db";
import { notificationChannels, notificationLog, type NotificationChannel } from "../db/schema";
import type { NotificationChannelType } from "../types";
import { CHANNEL_SENDERS } from "./channels";
import { NotifyTimeoutError, errorMessage, isPermanent } from "./errors";
import type { Alert, ChannelSender, SendContext } from "./types";

export const SEND_TIMEOUT_MS = 10_000;

export interface DeliveryOptions {
  /** Per-send timeout (default 10 s). */
  timeoutMs?: number;
  /** Override senders by channel type (tests, custom integrations). */
  senders?: Partial<Record<NotificationChannelType, ChannelSender>>;
  sleep?: SendContext["sleep"];
}

export interface DeliveryResult {
  ok: boolean;
  error?: string;
  permanent: boolean;
}

export interface Attempt extends DeliveryResult {
  alert: Alert;
  at: Date;
  /** Not attempted because the channel already failed in this run. */
  skipped: boolean;
}

/** jsonb config may contain non-string values if edited by hand; senders expect strings. */
function stringConfig(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") out[key] = value;
    else if (typeof value === "number" || typeof value === "boolean") out[key] = String(value);
  }
  return out;
}

/** Send one alert through one channel, bounded by a hard timeout. Never throws. */
export async function deliver(db: Db, channel: NotificationChannel, alert: Alert, opts: DeliveryOptions = {}): Promise<DeliveryResult> {
  const sender = opts.senders?.[channel.type] ?? CHANNEL_SENDERS[channel.type];
  if (!sender) return { ok: false, error: `Unknown channel type "${channel.type}"`, permanent: true };

  const timeoutMs = opts.timeoutMs ?? SEND_TIMEOUT_MS;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Racing (not just aborting) also bounds senders that can't be aborted (SMTP, web-push).
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new NotifyTimeoutError(timeoutMs);
      controller.abort(err);
      reject(err);
    }, timeoutMs);
  });
  try {
    const ctx: SendContext = { db, signal: controller.signal, deadline: Date.now() + timeoutMs, sleep: opts.sleep };
    await Promise.race([sender(alert, stringConfig(channel.config), ctx), timeout]);
    return { ok: true, permanent: false };
  } catch (err) {
    return { ok: false, error: errorMessage(err), permanent: isPermanent(err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Deliver alerts to one channel in order (channels have their own rate limits, so one channel's
 * alerts are sequential). After a permanent failure or two failures in a row the remaining
 * alerts are recorded as not sent instead of hammering a broken channel.
 */
export async function deliverQueue(db: Db, channel: NotificationChannel, alerts: Alert[], opts: DeliveryOptions = {}): Promise<Attempt[]> {
  const attempts: Attempt[] = [];
  let consecutiveFailures = 0;
  let giveUpReason: string | null = null;
  for (const alert of alerts) {
    if (giveUpReason) {
      attempts.push({ alert, ok: false, permanent: false, skipped: true, error: giveUpReason, at: new Date() });
      continue;
    }
    const result = await deliver(db, channel, alert, opts);
    attempts.push({ alert, ...result, skipped: false, at: new Date() });
    if (result.ok) {
      consecutiveFailures = 0;
      continue;
    }
    consecutiveFailures += 1;
    if (result.permanent || consecutiveFailures >= 2) giveUpReason = `Not sent: channel failed earlier in this run (${result.error})`;
  }
  return attempts;
}

/** One notification_log row per (attempt, covered match); matchless test alerts log a single row. */
export async function logAttempts(db: Db, channelId: number, attempts: Attempt[]): Promise<void> {
  const rows = attempts.flatMap((a) => {
    const matchIds: Array<number | null> = a.alert.matchIds.length ? a.alert.matchIds : [null];
    return matchIds.map((matchId) => ({
      channelId,
      matchId,
      status: a.ok ? ("sent" as const) : ("failed" as const),
      error: a.ok ? null : (a.error ?? "Unknown error"),
      createdAt: a.at,
    }));
  });
  if (rows.length) await db.insert(notificationLog).values(rows);
}

/** lastSuccessAt ← latest success; lastError ← the latest real attempt's error, cleared by a success. */
export async function updateChannelStatus(db: Db, channelId: number, attempts: Attempt[]): Promise<void> {
  const real = attempts.filter((a) => !a.skipped);
  if (!real.length) return;
  const lastSuccess = real.findLast((a) => a.ok);
  const last = real[real.length - 1];
  await db
    .update(notificationChannels)
    .set({
      ...(lastSuccess ? { lastSuccessAt: lastSuccess.at } : {}),
      lastError: last.ok ? null : (last.error ?? "Unknown error"),
    })
    .where(eq(notificationChannels.id, channelId));
}
