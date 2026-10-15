import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db";

const state = vi.hoisted(() => ({ db: null as Db | null }));
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return { ...actual, getDb: async () => state.db! };
});

const { createTestDb } = await import("@/lib/db");
const { notificationChannels, pushSubscriptions } = await import("@/lib/db/schema");
const { POST: subscribe } = await import("./subscribe/route");
const { POST: unsubscribe } = await import("./unsubscribe/route");

let close: () => Promise<void>;
beforeAll(async () => {
  const t = await createTestDb();
  state.db = t.db;
  close = t.close;
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await close();
});
beforeEach(async () => {
  await state.db!.delete(pushSubscriptions);
  vi.stubEnv("VAPID_PUBLIC_KEY", "BPub");
  vi.stubEnv("VAPID_PRIVATE_KEY", "priv");
});

const SUB = { endpoint: "https://fcm.googleapis.com/fcm/send/abc", expirationTime: null, keys: { p256dh: "BNcRd_key", auth: "tBHItJI5svbpez7KI4CCXg" } };

function post(body: unknown, contentType = "application/json") {
  return new Request("http://localhost/api/push", {
    method: "POST",
    headers: { "Content-Type": contentType, "User-Agent": "TestBrowser/1" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/push/subscribe", () => {
  it("stores the subscription and ensures a webpush channel", async () => {
    const res = await subscribe(post({ subscription: SUB }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await state.db!.select().from(pushSubscriptions)).toEqual([
      expect.objectContaining({ endpoint: SUB.endpoint, p256dh: SUB.keys.p256dh, auth: SUB.keys.auth, userAgent: "TestBrowser/1" }),
    ]);
    expect((await state.db!.select().from(notificationChannels)).map((c) => c.type)).toEqual(["webpush"]);
  });

  it.each([
    ["malformed JSON", "{nope"],
    ["missing subscription", {}],
    ["non-https endpoint", { subscription: { ...SUB, endpoint: "http://evil.example.com/x" } }],
    ["missing keys", { subscription: { endpoint: SUB.endpoint } }],
  ])("rejects %s with 400", async (_label, body) => {
    const res = await subscribe(post(body));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Invalid/);
  });

  it("requires a JSON content type (blocks cross-site form posts)", async () => {
    const res = await subscribe(post({ subscription: SUB }, "text/plain"));
    expect(res.status).toBe(415);
  });

  it("returns 503 when VAPID keys are missing", async () => {
    vi.stubEnv("VAPID_PRIVATE_KEY", "");
    const res = await subscribe(post({ subscription: SUB }));
    expect(res.status).toBe(503);
    expect(await state.db!.select().from(pushSubscriptions)).toHaveLength(0);
  });
});

describe("POST /api/push/unsubscribe", () => {
  it("deletes the subscription", async () => {
    await subscribe(post({ subscription: SUB }));
    const res = await unsubscribe(post({ endpoint: SUB.endpoint }));
    expect(res.status).toBe(200);
    expect(await state.db!.select().from(pushSubscriptions)).toHaveLength(0);
  });

  it("rejects bad input with 400", async () => {
    expect((await unsubscribe(post({}))).status).toBe(400);
    expect((await unsubscribe(post({ endpoint: 42 }))).status).toBe(400);
  });
});
