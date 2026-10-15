import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendNotification = vi.fn();
vi.mock("web-push", () => ({ default: { sendNotification } }));

const { createTestDb } = await import("../../db");
const { pushSubscriptions } = await import("../../db/schema");
const { buildWebPushPayload, sendWebPush } = await import("../channels/webpush");
const { ChannelNotConfiguredError } = await import("../errors");
const { makeAlert, makeCtx } = await import("./fixtures");

type TestDb = Awaited<ReturnType<typeof createTestDb>>;
let t: TestDb;

beforeEach(async () => {
  t = await createTestDb();
  sendNotification.mockReset();
  vi.stubEnv("VAPID_PUBLIC_KEY", "BPublicKey");
  vi.stubEnv("VAPID_PRIVATE_KEY", "privateKey");
  vi.stubEnv("VAPID_SUBJECT", "mailto:me@example.com");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await t.close();
});

async function addSubscription(endpoint: string) {
  await t.db.insert(pushSubscriptions).values({ endpoint, p256dh: "p256", auth: "auth" });
}

function webPushError(statusCode: number) {
  return Object.assign(new Error(`Received unexpected response code ${statusCode}`), { statusCode });
}

describe("web push", () => {
  it("builds the service-worker payload with an app-relative URL", () => {
    expect(buildWebPushPayload(makeAlert())).toEqual({
      title: "$120 · <b>x</b> & *y* @everyone",
      body: expect.stringContaining("Deal score: 86/100"),
      url: "/listings/42",
      image: "https://images.craigslist.org/00a0a_abc_600x450.jpg",
      icon: "/icons/icon-192.png",
      tag: "match-7",
      timestamp: Date.parse("2026-09-28T12:00:00Z"),
    });
  });

  it("keeps payloads under the push size limit", () => {
    const payload = buildWebPushPayload(makeAlert({ lines: ["€".repeat(5_000)], imageUrl: `https://x.test/${"a".repeat(900)}` }));
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThanOrEqual(3_000);
  });

  it("sends to every subscription with VAPID details and deletes 404/410 subscriptions", async () => {
    await addSubscription("https://push.example.com/alive");
    await addSubscription("https://push.example.com/gone");
    await addSubscription("https://push.example.com/missing");
    sendNotification.mockImplementation(async (sub: { endpoint: string }) => {
      if (sub.endpoint.endsWith("/gone")) throw webPushError(410);
      if (sub.endpoint.endsWith("/missing")) throw webPushError(404);
      return { statusCode: 201 };
    });

    await sendWebPush(makeAlert(), {}, makeCtx({ db: t.db }));

    expect(sendNotification).toHaveBeenCalledTimes(3);
    const [sub, payload, options] = sendNotification.mock.calls[0];
    expect(sub).toEqual({ endpoint: "https://push.example.com/alive", keys: { p256dh: "p256", auth: "auth" } });
    expect(JSON.parse(payload)).toMatchObject({ tag: "match-7", url: "/listings/42", icon: "/icons/icon-192.png" });
    expect(options).toMatchObject({
      vapidDetails: { subject: "mailto:me@example.com", publicKey: "BPublicKey", privateKey: "privateKey" },
      urgency: "high",
    });
    const remaining = await t.db.select().from(pushSubscriptions);
    expect(remaining.map((s) => s.endpoint)).toEqual(["https://push.example.com/alive"]);
  });

  it("fails (and cleans up) when every subscription has expired", async () => {
    await addSubscription("https://push.example.com/gone");
    sendNotification.mockRejectedValue(webPushError(410));
    await expect(sendWebPush(makeAlert(), {}, makeCtx({ db: t.db }))).rejects.toThrow(/expired and were removed/);
    expect(await t.db.select().from(pushSubscriptions)).toHaveLength(0);
  });

  it("keeps subscriptions on other errors and reports failure", async () => {
    await addSubscription("https://push.example.com/a");
    sendNotification.mockRejectedValue(webPushError(500));
    await expect(sendWebPush(makeAlert(), {}, makeCtx({ db: t.db }))).rejects.toThrow("Browser push failed for 1 of 1 browser(s): HTTP 500");
    expect(await t.db.select().from(pushSubscriptions)).toHaveLength(1);
  });

  it("errors when VAPID is not configured or nobody subscribed", async () => {
    await expect(sendWebPush(makeAlert(), {}, makeCtx({ db: t.db }))).rejects.toThrow(/No browsers are subscribed/);
    vi.stubEnv("VAPID_PRIVATE_KEY", "");
    await expect(sendWebPush(makeAlert(), {}, makeCtx({ db: t.db }))).rejects.toBeInstanceOf(ChannelNotConfiguredError);
    expect(sendNotification).not.toHaveBeenCalled();
  });
});
