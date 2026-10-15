/**
 * End to end through the real engine, notify dispatcher (webhook channel, fetch spied), AI evaluation
 * (fake Claude client) and feed queries; only the marketplace is faked.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type Db } from "@/lib/db";
import { aiEvaluations, notificationChannels, searchMatches } from "@/lib/db/schema";
import { setAiClientFactory } from "@/lib/ai";
import { createFakeClient, jsonMessage } from "@/lib/ai/testing/fake-client";
import { countUnseen, DEFAULT_FEED_FILTERS, getFeedPage, getFeedStats } from "@/lib/queries/feed";
import { aiQueueIdle } from "../ai-queue";
import { runSearch } from "../runner";
import { NOW, fakeAdapter, insertSearch, minutesAfter, noWaitGate, resetDb, scraped, type FakeAdapter } from "./helpers";

let db: Db;
let close: () => Promise<void>;
let posted: Array<Record<string, unknown>>;
let channelUp: boolean;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(() => close());

beforeEach(async () => {
  await resetDb(db);
  posted = [];
  channelUp = true;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    posted.push(JSON.parse(String(init?.body)));
    return channelUp ? new Response("ok", { status: 200 }) : new Response("upstream down", { status: 503 });
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await db.insert(notificationChannels).values({ name: "hook", type: "webhook", config: { url: "https://hooks.example.test/x" } });
});

afterEach(async () => {
  await aiQueueIdle();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  setAiClientFactory(null);
});

const run = (searchId: number, cl: FakeAdapter, now: Date) =>
  runSearch(db, searchId, { adapters: { craigslist: cl }, gate: noWaitGate(), now });

describe("alerts end to end", () => {
  it("shows an alerted price drop on a first-run match as an unseen alert in the feed", async () => {
    const cl = fakeAdapter("craigslist", { results: [scraped("craigslist", "A", { priceCents: 40_000 })] });
    const search = await insertSearch(db);
    await run(search.id, cl, NOW); // first run: silent

    cl.setResults([scraped("craigslist", "A", { priceCents: 30_000 })]);
    const later = minutesAfter(NOW, 10);
    await run(search.id, cl, later);

    expect(posted.map((p) => p.event)).toEqual(["price_drop"]);
    const [match] = await db.select().from(searchMatches);
    expect(match).toMatchObject({ lastEvent: "price_drop", silent: false, seen: false });
    expect(match.notifiedAt).not.toBeNull();
    expect(await countUnseen(db, DEFAULT_FEED_FILTERS)).toBe(1);
    expect((await getFeedStats(db, { now: minutesAfter(later, 1), workerMode: "inline" })).priceDropsLast24h).toBe(1);
    expect((await getFeedPage(db, { ...DEFAULT_FEED_FILTERS, includeInitial: false })).items).toHaveLength(1);
  });

  it("alerts on a match that can't be scored yet even with a minimum deal score", async () => {
    const cl = fakeAdapter("craigslist", {
      results: [scraped("craigslist", "1", { priceCents: 90_000 }), scraped("craigslist", "2", { priceCents: 95_000 })],
    });
    const search = await insertSearch(db, { notifyMinDealScore: 60 });
    await run(search.id, cl, NOW);

    cl.setResults([scraped("craigslist", "3", { priceCents: 30_000, postedAt: minutesAfter(NOW, 5) })]);
    const result = await run(search.id, cl, minutesAfter(NOW, 10));
    expect(result.events).toEqual([expect.objectContaining({ type: "new", silent: false })]);
    expect(posted).toHaveLength(1);
  });

  it("retries an alert whose delivery failed on a later run, once", async () => {
    const cl = fakeAdapter("craigslist", { results: [scraped("craigslist", "1")] });
    const search = await insertSearch(db);
    await run(search.id, cl, NOW); // first run, silent

    channelUp = false; // a short outage during the next run
    cl.setResults([scraped("craigslist", "1"), scraped("craigslist", "2", { priceCents: 20_000, postedAt: minutesAfter(NOW, 5) })]);
    await run(search.id, cl, minutesAfter(NOW, 10));
    expect(posted).toHaveLength(1);

    channelUp = true;
    posted = [];
    for (let i = 2; i <= 4; i++) await run(search.id, cl, minutesAfter(NOW, 10 * i));
    expect(posted.map((p) => p.event)).toEqual(["new"]);
    const rows = await db.select().from(searchMatches);
    expect(rows.filter((r) => !r.silent).every((r) => r.notifiedAt !== null)).toBe(true);
  });

  it("includes the automatic AI verdict in the alert", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    const fake = createFakeClient(() =>
      jsonMessage({
        verdict: "great",
        dealScore: 90,
        estimatedResaleLow: 500,
        estimatedResaleHigh: 600,
        suggestedOffer: 250,
        summary: "Great price.",
        reasons: ["cheap"],
        redFlags: [],
        questionsForSeller: [],
      }),
    );
    setAiClientFactory(() => fake);

    // Around real time: evaluations are stamped by the database clock (≈ t0 + 20 min here).
    const t0 = minutesAfter(new Date(), -20);
    const cl = fakeAdapter("craigslist", { results: [scraped("craigslist", "1", { postedAt: t0 })] });
    const search = await insertSearch(db, { aiEvaluate: true });
    const other = await insertSearch(db, { name: "Other", aiEvaluate: true });
    await run(search.id, cl, t0); // first runs: silent
    await run(other.id, cl, t0);

    cl.setResults([scraped("craigslist", "2", { priceCents: 25_000, postedAt: t0 })]);
    await run(search.id, cl, minutesAfter(t0, 10));
    expect(posted).toHaveLength(1);
    expect(posted[0].ai).toMatchObject({ verdict: "great", dealScore: 90 });

    // Another search matching the same listing reuses the fresh evaluation.
    await run(other.id, cl, minutesAfter(t0, 11));
    expect(posted).toHaveLength(2);
    expect(posted[1].ai).toMatchObject({ verdict: "great" });
    expect(fake.calls).toHaveLength(1);

    // A price drop makes the verdict stale: evaluated again.
    cl.setResults([scraped("craigslist", "2", { priceCents: 20_000, postedAt: t0 })]);
    await run(search.id, cl, minutesAfter(t0, 30));
    expect(fake.calls).toHaveLength(2);
    expect(await db.select().from(aiEvaluations)).toHaveLength(2);
  });
});
