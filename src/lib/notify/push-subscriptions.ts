import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db";
import { notificationChannels, pushSubscriptions } from "../db/schema";
import { vapidDetails } from "./channels/webpush";

export interface BrowserPushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

const base64Url = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(/^[A-Za-z0-9_-]+={0,2}$/, "Expected a base64url string");

/** PushSubscription.toJSON() as sent by the browser. */
export const browserPushSubscriptionSchema = z.object({
  endpoint: z
    .string()
    .trim()
    .max(2048)
    .refine((value) => {
      try {
        return new URL(value).protocol === "https:";
      } catch {
        return false;
      }
    }, "Endpoint must be an https URL"),
  expirationTime: z.number().nullish(),
  keys: z.object({ p256dh: base64Url(256), auth: base64Url(64) }),
});

export const DEFAULT_PUSH_CHANNEL_NAME = "Browser push";

/** Public VAPID key for browser push subscription, or null when web push is not configured. */
export function getVapidPublicKey(): string | null {
  return vapidDetails()?.publicKey ?? null;
}

/**
 * Upsert a browser subscription by endpoint. Also makes sure a "webpush" channel exists, since a
 * subscription without one would never receive alerts.
 */
export async function savePushSubscription(db: Db, sub: BrowserPushSubscription, userAgent?: string | null): Promise<void> {
  const values = {
    endpoint: sub.endpoint,
    p256dh: sub.keys.p256dh,
    auth: sub.keys.auth,
    userAgent: userAgent ? userAgent.slice(0, 500) : null,
  };
  await db
    .insert(pushSubscriptions)
    .values(values)
    .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: { p256dh: values.p256dh, auth: values.auth, userAgent: values.userAgent } });

  const [existing] = await db
    .select({ id: notificationChannels.id })
    .from(notificationChannels)
    .where(eq(notificationChannels.type, "webpush"))
    .limit(1);
  if (!existing) {
    await db.insert(notificationChannels).values({ name: DEFAULT_PUSH_CHANNEL_NAME, type: "webpush", config: {} });
  }
}

export async function deletePushSubscription(db: Db, endpoint: string): Promise<void> {
  await db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint));
}
