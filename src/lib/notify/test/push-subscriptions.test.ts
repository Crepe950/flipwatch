import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type Db } from "../../db";
import { notificationChannels, pushSubscriptions } from "../../db/schema";
import { browserPushSubscriptionSchema, deletePushSubscription, getVapidPublicKey, savePushSubscription } from "../push-subscriptions";

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await close();
});

const sub = (endpoint = "https://fcm.googleapis.com/fcm/send/abc", p256dh = "BNcRd_key", auth = "tBHItJI5svbpez7KI4CCXg") => ({
  endpoint,
  keys: { p256dh, auth },
});

describe("push subscriptions", () => {
  it("upserts by endpoint and creates the Browser push channel once", async () => {
    await savePushSubscription(db, sub(), "Mozilla/5.0");
    await savePushSubscription(db, sub(undefined, "BNewKey", "newAuth"), "Firefox");
    await savePushSubscription(db, sub("https://updates.push.services.mozilla.com/wpush/v2/xyz"));

    const rows = await db.select().from(pushSubscriptions).orderBy(pushSubscriptions.id);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ p256dh: "BNewKey", auth: "newAuth", userAgent: "Firefox" });

    const channels = await db.select().from(notificationChannels);
    expect(channels).toEqual([expect.objectContaining({ type: "webpush", name: "Browser push", enabled: true, config: {} })]);
  });

  it("keeps an existing webpush channel (even a disabled, renamed one)", async () => {
    await db.insert(notificationChannels).values({ name: "My phone", type: "webpush", enabled: false });
    await savePushSubscription(db, sub());
    expect(await db.select().from(notificationChannels)).toEqual([expect.objectContaining({ name: "My phone", enabled: false })]);
  });

  it("deletes by endpoint (unknown endpoints are a no-op)", async () => {
    await savePushSubscription(db, sub());
    await deletePushSubscription(db, "https://nope.example.com/x");
    expect(await db.select().from(pushSubscriptions)).toHaveLength(1);
    await deletePushSubscription(db, sub().endpoint);
    expect(await db.select().from(pushSubscriptions)).toHaveLength(0);
  });

  it("exposes the VAPID public key only when fully configured", () => {
    vi.stubEnv("VAPID_PUBLIC_KEY", "BPub");
    vi.stubEnv("VAPID_PRIVATE_KEY", "");
    expect(getVapidPublicKey()).toBeNull();
    vi.stubEnv("VAPID_PRIVATE_KEY", "priv");
    expect(getVapidPublicKey()).toBe("BPub");
  });

  it("validates browser subscriptions", () => {
    expect(browserPushSubscriptionSchema.safeParse({ ...sub(), expirationTime: null }).success).toBe(true);
    expect(browserPushSubscriptionSchema.safeParse(sub("http://insecure.example.com/x")).success).toBe(false);
    expect(browserPushSubscriptionSchema.safeParse(sub(undefined, "not base64!")).success).toBe(false);
    expect(browserPushSubscriptionSchema.safeParse({ endpoint: sub().endpoint }).success).toBe(false);
  });
});
