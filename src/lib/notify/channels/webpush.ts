import { inArray } from "drizzle-orm";
import webpush from "web-push";
import { config as env } from "../../config";
import { pushSubscriptions } from "../../db/schema";
import { ChannelNotConfiguredError, NotifyError, errorMessage } from "../errors";
import { truncate } from "../escape";
import type { Alert, ChannelSender } from "../types";

export interface VapidDetails {
  subject: string;
  publicKey: string;
  privateKey: string;
}

/** VAPID credentials from the environment, or null when browser push is not configured. */
export function vapidDetails(): VapidDetails | null {
  const publicKey = env.vapidPublicKey;
  const privateKey = env.vapidPrivateKey;
  if (!publicKey || !privateKey) return null;
  return { subject: env.vapidSubject, publicKey, privateKey };
}

/** Shape consumed by public/sw.js. */
export interface WebPushPayload {
  title: string;
  body: string;
  /** App-relative URL (the service worker resolves it against its own origin). */
  url: string;
  image?: string;
  icon: string;
  tag: string;
  timestamp: number;
}

// Push services cap payloads at ~4 KB after encryption overhead.
const MAX_PAYLOAD_BYTES = 3_000;
const TTL_SECONDS = 12 * 60 * 60;

export function buildWebPushPayload(alert: Alert): WebPushPayload {
  const payload: WebPushPayload = {
    title: truncate(alert.title, 150),
    body: truncate(alert.lines.join("\n"), 600),
    url: alert.appPath,
    icon: "/icons/icon-192.png",
    tag: alert.tag,
    timestamp: alert.timestamp.getTime(),
  };
  if (alert.imageUrl && alert.imageUrl.length <= 1_000) payload.image = alert.imageUrl;
  if (Buffer.byteLength(JSON.stringify(payload)) > MAX_PAYLOAD_BYTES) {
    delete payload.image;
    payload.body = truncate(payload.body, 200);
  }
  return payload;
}

function statusOf(err: unknown): number | undefined {
  const status = (err as { statusCode?: unknown })?.statusCode;
  return typeof status === "number" ? status : undefined;
}

/**
 * Sends to every stored browser subscription. Succeeds when at least one browser accepted the
 * message; subscriptions the push service reports as gone (404/410) are deleted.
 */
export const sendWebPush: ChannelSender = async (alert, _config, ctx) => {
  const vapid = vapidDetails();
  if (!vapid) throw new ChannelNotConfiguredError("Browser push needs VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY");

  const subs = await ctx.db.select().from(pushSubscriptions);
  if (!subs.length) {
    throw new NotifyError("No browsers are subscribed — use “Enable browser push” in Settings", { permanent: true });
  }

  const payload = JSON.stringify(buildWebPushPayload(alert));
  const timeout = Math.max(1_000, ctx.deadline - Date.now());
  const urgency = alert.dealScore != null && alert.dealScore >= 80 && alert.kind !== "digest" ? "high" : "normal";
  const results = await Promise.allSettled(
    subs.map((s) =>
      webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, {
        vapidDetails: vapid,
        TTL: TTL_SECONDS,
        urgency,
        timeout,
      }),
    ),
  );

  const gone: number[] = [];
  const failures: string[] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") return;
    const status = statusOf(r.reason);
    if (status === 404 || status === 410) gone.push(subs[i].id);
    else failures.push(status ? `HTTP ${status}` : errorMessage(r.reason, 160));
  });
  if (gone.length) await ctx.db.delete(pushSubscriptions).where(inArray(pushSubscriptions.id, gone));

  if (results.some((r) => r.status === "fulfilled")) return;
  if (!failures.length) {
    throw new NotifyError(`All ${gone.length} browser subscription(s) had expired and were removed — enable browser push again`, {
      permanent: true,
    });
  }
  throw new NotifyError(`Browser push failed for ${failures.length} of ${subs.length} browser(s): ${failures[0]}`);
};
