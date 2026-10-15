import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type Db } from "../../db";
import { aiEvaluations, listings, notificationChannels, notificationLog, priceChecks, searchMatches } from "../../db/schema";
import type { MatchEvent } from "../../events";
import { notifyMatchEvents, type NotifyOptions } from "../dispatcher";
import { APP_URL, NOW, seedChannel, seedMatches, stubFetch } from "./fixtures";

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(async () => {
  vi.restoreAllMocks();
  await close();
});

const opts: NotifyOptions = { now: NOW, appUrl: APP_URL, log: () => {} };

/** Webhook channels make the wire payload easy to inspect. */
const webhook = (name: string, overrides: Parameters<typeof seedChannel>[3] = {}) =>
  seedChannel(db, "webhook", { url: `https://hooks.example.com/${name}` }, { name, ...overrides });

const sentTo = (calls: ReturnType<typeof stubFetch>["calls"], name: string) => calls.filter((c) => c.url.endsWith(`/${name}`));

async function matchRow(id: number) {
  const [row] = await db.select().from(searchMatches).where(eq(searchMatches.id, id));
  return row;
}

describe("notifyMatchEvents", () => {
  it("ignores silent events", async () => {
    await webhook("a");
    const { events, matches } = await seedMatches(db, 2);
    const { calls } = stubFetch();
    await notifyMatchEvents(db, events.map((e) => ({ ...e, silent: true })), opts);
    expect(calls).toHaveLength(0);
    expect(await db.select().from(notificationLog)).toHaveLength(0);
    expect((await matchRow(matches[0].id)).notifiedAt).toBeNull();
  });

  it("sends each match to every enabled channel and records the delivery", async () => {
    const a = await webhook("a");
    const b = await webhook("b");
    await webhook("off", { enabled: false });
    const { events, matches, search } = await seedMatches(db, 1);
    const { calls } = stubFetch();

    await notifyMatchEvents(db, events, opts);

    expect(sentTo(calls, "a")).toHaveLength(1);
    expect(sentTo(calls, "b")).toHaveLength(1);
    expect(sentTo(calls, "off")).toHaveLength(0);
    const payload = sentTo(calls, "a")[0].json;
    expect(payload).toMatchObject({
      event: "new",
      title: expect.stringMatching(/^\$120 · PS5 Digital Edition #\d+$/),
      search: { id: search.id, name: "PS5" },
      match: { id: matches[0].id, dealScore: 70 },
      links: { app: `${APP_URL}/listings/${matches[0].listingId}` },
    });

    const logs = await db.select().from(notificationLog);
    expect(logs.map((l) => [l.channelId, l.matchId, l.status])).toEqual(
      expect.arrayContaining([
        [a.id, matches[0].id, "sent"],
        [b.id, matches[0].id, "sent"],
      ]),
    );
    expect((await matchRow(matches[0].id)).notifiedAt?.getTime()).toBeGreaterThanOrEqual(NOW.getTime());
    const [channelA] = await db.select().from(notificationChannels).where(eq(notificationChannels.id, a.id));
    expect(channelA.lastSuccessAt).not.toBeNull();
    expect(channelA.lastError).toBeNull();
  });

  it("respects the search's channel selection", async () => {
    const a = await webhook("a");
    await webhook("b");
    const { calls } = stubFetch();

    const selected = await seedMatches(db, 1, { notifyChannelIds: [a.id] });
    await notifyMatchEvents(db, selected.events, opts);
    expect(calls.map((c) => c.url)).toEqual(["https://hooks.example.com/a"]);

    const none = await seedMatches(db, 1, { name: "Nothing", notifyChannelIds: [] });
    await notifyMatchEvents(db, none.events, opts);
    expect(calls).toHaveLength(1);
    expect((await matchRow(none.matches[0].id)).notifiedAt).toBeNull();
  });

  it("is idempotent when the engine retries, but alerts again on a newer event", async () => {
    await webhook("a");
    const { events, matches } = await seedMatches(db, 1);
    const { calls } = stubFetch();

    await notifyMatchEvents(db, events, opts);
    await notifyMatchEvents(db, events, opts);
    expect(calls).toHaveLength(1);

    // Engine records a price drop after the first alert.
    const later = new Date(NOW.getTime() + 60_000);
    await db.update(searchMatches).set({ lastEvent: "price_drop", lastEventAt: later }).where(eq(searchMatches.id, matches[0].id));
    const drop: MatchEvent = { ...events[0], type: "price_drop", previousPriceCents: 15_000 };
    await notifyMatchEvents(db, [drop], { ...opts, now: new Date(later.getTime() + 1_000) });
    expect(calls).toHaveLength(2);
    expect(calls[1].json).toMatchObject({ event: "price_drop", title: expect.stringMatching(/^Price drop \$150 → \$120 · /) });
  });

  it("stays idempotent with database-generated (microsecond) event times", async () => {
    await webhook("a");
    const { events, matches } = await seedMatches(db, 1);
    await db.update(searchMatches).set({ lastEventAt: sql`now()` }).where(eq(searchMatches.id, matches[0].id));
    const { calls } = stubFetch();
    await notifyMatchEvents(db, events, opts);
    await notifyMatchEvents(db, events, opts);
    expect(calls).toHaveLength(1);
  });

  it("does not swallow a newer event recorded while the alert was being sent", async () => {
    await webhook("a");
    const { events, matches } = await seedMatches(db, 1);
    const racingSender = async () => {
      // A concurrent engine run records a price drop mid-delivery.
      await db.update(searchMatches).set({ lastEventAt: new Date(NOW.getTime() + 5_000) }).where(eq(searchMatches.id, matches[0].id));
    };
    await notifyMatchEvents(db, events, { ...opts, senders: { webhook: racingSender } });
    expect((await matchRow(matches[0].id)).notifiedAt).toBeNull();
  });

  it("isolates a failing channel, logs the error and leaves others unaffected", async () => {
    const good = await webhook("good");
    const bad = await webhook("bad");
    const { events, matches } = await seedMatches(db, 1);
    stubFetch((url) => (url.endsWith("/bad") ? new Response("boom", { status: 500 }) : new Response("ok")));

    await notifyMatchEvents(db, events, opts);

    const logs = await db.select().from(notificationLog);
    expect(logs.find((l) => l.channelId === good.id)).toMatchObject({ status: "sent", error: null });
    expect(logs.find((l) => l.channelId === bad.id)).toMatchObject({ status: "failed", error: "Webhook returned HTTP 500: boom" });
    const [badRow] = await db.select().from(notificationChannels).where(eq(notificationChannels.id, bad.id));
    expect(badRow.lastError).toBe("Webhook returned HTTP 500: boom");
    expect(badRow.lastSuccessAt).toBeNull();
    // Delivered to at least one channel → notified.
    expect((await matchRow(matches[0].id)).notifiedAt).not.toBeNull();
  });

  it("does not mark matches notified when every channel failed", async () => {
    await webhook("bad");
    const { events, matches } = await seedMatches(db, 1);
    stubFetch(() => new Response("nope", { status: 502 }));
    await notifyMatchEvents(db, events, opts);
    expect((await matchRow(matches[0].id)).notifiedAt).toBeNull();
  });

  it("times out a hung channel without blocking the others", async () => {
    const hung = await seedChannel(db, "ntfy", { topic: "t" }, { name: "hung" });
    const fine = await webhook("fine");
    const { events } = await seedMatches(db, 1);
    stubFetch();

    await notifyMatchEvents(db, events, { ...opts, timeoutMs: 50, senders: { ntfy: () => new Promise(() => {}) } });

    const logs = await db.select().from(notificationLog);
    expect(logs.find((l) => l.channelId === hung.id)).toMatchObject({ status: "failed", error: "Timed out after 50ms" });
    expect(logs.find((l) => l.channelId === fine.id)).toMatchObject({ status: "sent" });
  });

  it("sends 5 alerts individually and bundles the rest into one digest per search", async () => {
    const a = await webhook("a");
    const { events, matches, search } = await seedMatches(db, 12);
    const { calls } = stubFetch();

    await notifyMatchEvents(db, events, opts);

    expect(calls).toHaveLength(6);
    expect(calls.slice(0, 5).map((c) => c.json.event)).toEqual(["new", "new", "new", "new", "new"]);
    const digest = calls[5].json;
    expect(digest).toMatchObject({ event: "digest", title: "+7 more matches for PS5", links: { app: `${APP_URL}/?search=${search.id}` } });
    expect((digest.matches as unknown[]).length).toBe(7);

    const logs = await db.select().from(notificationLog).where(eq(notificationLog.channelId, a.id));
    expect(logs).toHaveLength(12);
    const notified = await Promise.all(matches.map((m) => matchRow(m.id)));
    expect(notified.every((m) => m.notifiedAt !== null)).toBe(true);
  });

  it("stops hammering a channel after a permanent failure", async () => {
    const gone = await webhook("gone");
    const { events } = await seedMatches(db, 3);
    const { calls } = stubFetch(() => new Response('{"message":"Unknown Webhook"}', { status: 404 }));

    await notifyMatchEvents(db, events, opts);

    expect(calls).toHaveLength(1);
    const logs = await db.select().from(notificationLog).where(eq(notificationLog.channelId, gone.id));
    expect(logs).toHaveLength(3);
    expect(logs.every((l) => l.status === "failed")).toBe(true);
    expect(logs.filter((l) => l.error?.startsWith("Not sent: channel failed earlier"))).toHaveLength(2);
    const [row] = await db.select().from(notificationChannels).where(eq(notificationChannels.id, gone.id));
    expect(row.lastError).toBe("Webhook returned HTTP 404: Unknown Webhook");
  });

  it("honours notifyPriceDrops and notifyMinDealScore", async () => {
    await webhook("a");
    const { calls } = stubFetch();
    const noDrops = await seedMatches(db, 1, { notifyPriceDrops: false });
    await notifyMatchEvents(db, [{ ...noDrops.events[0], type: "price_drop", previousPriceCents: 20_000 }], opts);
    expect(calls).toHaveLength(0);

    const picky = await seedMatches(db, 2, { name: "Picky", notifyMinDealScore: 80 });
    await db.update(searchMatches).set({ dealScore: 95 }).where(eq(searchMatches.id, picky.matches[1].id));
    await notifyMatchEvents(db, picky.events, opts);
    expect(calls.map((c) => (c.json.match as { id: number }).id)).toEqual([picky.matches[1].id]);
  });

  it("with a minimum AI score, only alerts on listings Claude scored at least that high", async () => {
    await webhook("a");
    const { calls } = stubFetch();
    const gated = await seedMatches(db, 3, { name: "Part-outs", notifyMinAiScore: 70 });
    const evaluate = (listingId: number, dealScore: number) =>
      db.insert(aiEvaluations).values({ listingId, model: "m", verdict: dealScore >= 60 ? "good" : "pass", dealScore, summary: "s" });
    await evaluate(gated.matches[0].listingId, 55);
    await evaluate(gated.matches[1].listingId, 82);
    // matches[2] has no evaluation yet: held back rather than alerting unfiltered.

    await notifyMatchEvents(db, gated.events, opts);
    expect(calls.map((c) => (c.json.match as { id: number }).id)).toEqual([gated.matches[1].id]);
    expect((await matchRow(gated.matches[2].id)).notifiedAt).toBeNull();

    // Once its evaluation lands, a retry of the same event alerts.
    await evaluate(gated.matches[2].listingId, 90);
    await notifyMatchEvents(db, [gated.events[2]], opts);
    expect(calls.map((c) => (c.json.match as { id: number }).id)).toEqual([gated.matches[1].id, gated.matches[2].id]);
  });

  it("with a minimum checked profit, alerts only once a price check shows that much", async () => {
    await webhook("a");
    const { calls } = stubFetch();
    const gated = await seedMatches(db, 3, { name: "Part-outs", notifyMinProfitPct: 20 });
    const [l0, l1, l2] = gated.matches.map((m) => m.listingId);
    const [listing0] = await db.select().from(listings).where(eq(listings.id, l0));
    const price = listing0.priceCents!;
    const check = (listingId: number, typicalCents: number, partOutTotalCents: number | null = null) =>
      db.insert(priceChecks).values({ listingId, model: "m", result: { item: { typicalCents }, partOutTotalCents } });
    await check(l0, Math.round(price * 1.1)); // +10 %: not enough
    await check(l1, Math.round(price * 0.9), Math.round(price * 1.3)); // parts +30 %
    // l2 has no price check yet: held back.

    await notifyMatchEvents(db, gated.events, opts);
    expect(calls.map((c) => (c.json.match as { id: number }).id)).toEqual([gated.matches[1].id]);
    expect((await matchRow(gated.matches[2].id)).notifiedAt).toBeNull();

    await check(l2, price * 2);
    await notifyMatchEvents(db, [gated.events[2]], opts);
    expect(calls.map((c) => (c.json.match as { id: number }).id)).toEqual([gated.matches[1].id, gated.matches[2].id]);
  });

  it("includes the latest AI evaluation", async () => {
    await webhook("a");
    const { events, matches } = await seedMatches(db, 1);
    const base = { listingId: matches[0].listingId, model: "m", dealScore: 90, summary: "old" };
    await db.insert(aiEvaluations).values({ ...base, verdict: "fair", summary: "Older take", createdAt: new Date(NOW.getTime() - 60_000) });
    await db.insert(aiEvaluations).values({ ...base, verdict: "great", summary: "Newest take", createdAt: NOW });
    const { calls } = stubFetch();

    await notifyMatchEvents(db, events, opts);
    expect(calls[0].json.ai).toMatchObject({ verdict: "great", summary: "Newest take" });
  });

  it("uses the last event per match in a batch and skips unknown matches", async () => {
    await webhook("a");
    const { events } = await seedMatches(db, 1);
    const { calls } = stubFetch();
    await notifyMatchEvents(
      db,
      [events[0], { ...events[0], type: "price_drop", previousPriceCents: 13_000 }, { ...events[0], matchId: 999_999 }],
      opts,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].json.event).toBe("price_drop");
  });

  it("never throws, even when the database fails", async () => {
    const log = vi.fn();
    const broken = { select: () => { throw new Error("db down"); } } as unknown as Db;
    await expect(notifyMatchEvents(broken, [{ type: "new", matchId: 1, searchId: 1, listingId: 1, silent: false }], { log })).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith("notifyMatchEvents failed: db down");
    await expect(notifyMatchEvents(db, [])).resolves.toBeUndefined();
  });
});
