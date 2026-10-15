import { and, asc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type Db } from "@/lib/db";
import { listings, priceHistory, scrapeRuns, searchMatches } from "@/lib/db/schema";
import { aiStatus, evaluateMatchEvents } from "@/lib/ai";
import { DEFAULT_LOCATION } from "@/lib/locations";
import { notifyMatchEvents } from "@/lib/notify";
import type { MarketplaceAdapter } from "@/lib/marketplaces/types";
import { countUnseen, DEFAULT_FEED_FILTERS } from "@/lib/queries/feed";
import { updateSearch } from "@/lib/queries/searches";
import type { SearchInput } from "@/lib/search-schema";
import type { MarketplaceId } from "@/lib/types";
import { AI_BEFORE_ALERT_MAX, aiQueueIdle, evaluateBeforeAlerting } from "../ai-queue";
import { ALERT_RETRY_AFTER_MS } from "../matches";
import { runSearch } from "../runner";
import type { RunSearchOptions } from "../types";
import { NOW, fakeAdapter, getSearch, insertSearch, isNear, minutesAfter, noWaitGate, resetDb, scraped } from "./helpers";

vi.mock("@/lib/notify", () => ({ notifyMatchEvents: vi.fn(async () => {}) }));
vi.mock("@/lib/ai", () => ({
  aiStatus: vi.fn(() => ({ configured: false, model: "" })),
  evaluateMatchEvents: vi.fn(async () => ({ evaluations: [], errors: [] })),
}));

const notify = vi.mocked(notifyMatchEvents);
const evaluate = vi.mocked(evaluateMatchEvents);

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});

beforeEach(async () => {
  await resetDb(db);
  vi.clearAllMocks();
  vi.mocked(aiStatus).mockReturnValue({ configured: false, model: "" });
});

afterEach(() => aiQueueIdle());

afterAll(() => close());

function run(searchId: number, adapters: Partial<Record<MarketplaceId, MarketplaceAdapter>>, opts: RunSearchOptions = {}) {
  return runSearch(db, searchId, { adapters, gate: noWaitGate(), now: NOW, ...opts });
}

async function matchFor(searchId: number, externalId: string) {
  const [row] = await db
    .select({ match: searchMatches })
    .from(searchMatches)
    .innerJoin(listings, eq(searchMatches.listingId, listings.id))
    .where(and(eq(searchMatches.searchId, searchId), eq(listings.externalId, externalId)));
  return row?.match;
}

async function historyFor(externalId: string) {
  const rows = await db
    .select({ priceCents: priceHistory.priceCents })
    .from(priceHistory)
    .innerJoin(listings, eq(priceHistory.listingId, listings.id))
    .where(eq(listings.externalId, externalId))
    .orderBy(asc(priceHistory.observedAt), asc(priceHistory.id));
  return rows.map((r) => r.priceCents);
}

describe("runSearch", () => {
  it("throws for an unknown search", async () => {
    await expect(run(999, {})).rejects.toThrow("Search 999 not found");
  });

  it("records the first run silently and stores listings, price history and a scrape run", async () => {
    const cl = fakeAdapter("craigslist", { results: [scraped("craigslist", "1"), scraped("craigslist", "2")] });
    const search = await insertSearch(db, { query: 'ps5 -broken -"for parts"', category: "any" });

    const result = await run(search.id, { craigslist: cl });

    expect(result.searchId).toBe(search.id);
    expect(result.startedAt).toEqual(NOW);
    expect(result.finishedAt.getTime()).toBeGreaterThanOrEqual(NOW.getTime());
    expect(result.events).toHaveLength(2);
    expect(result.events.every((e) => e.type === "new" && e.silent)).toBe(true);
    expect(result.marketplaces).toEqual([
      expect.objectContaining({ marketplace: "craigslist", resultCount: 2, matchedCount: 2, newCount: 2, priceDropCount: 0 }),
    ]);
    expect(notify).not.toHaveBeenCalled();

    // Negative terms never reach the marketplace; "any" category is sent as no category.
    expect(cl.calls[0]).toMatchObject({ keywords: "ps5", limit: 60, category: null, location: search.location });

    const matches = await db.select().from(searchMatches);
    expect(matches).toHaveLength(2);
    expect(matches.every((m) => m.silent && m.lastEvent === "new")).toBe(true);
    expect(await db.select().from(priceHistory)).toHaveLength(2);

    const [stored] = await db.select().from(listings).where(eq(listings.externalId, "1"));
    expect(stored).toMatchObject({ priceCents: 40_000, originalPriceCents: 40_000, status: "active", currency: "CAD" });
    expect(isNear(stored.firstSeenAt, NOW)).toBe(true);

    const runs = await db.select().from(scrapeRuns);
    expect(runs).toEqual([expect.objectContaining({ searchId: search.id, marketplace: "craigslist", resultCount: 2, newCount: 2, error: null })]);

    const updated = await getSearch(db, search.id);
    expect(updated.lastRunAt).toEqual(NOW);
    expect(updated.lastError).toBeNull();
  });

  it("alerts only on listings that are new since the previous run", async () => {
    const cl = fakeAdapter("craigslist", { results: [scraped("craigslist", "1"), scraped("craigslist", "2")] });
    const search = await insertSearch(db);
    await run(search.id, { craigslist: cl });

    cl.setResults([scraped("craigslist", "3"), scraped("craigslist", "1"), scraped("craigslist", "2")]);
    const later = minutesAfter(NOW, 5);
    const result = await run(search.id, { craigslist: cl }, { now: later });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({ type: "new", silent: false, searchId: search.id });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(db, result.events);
    expect((await matchFor(search.id, "3"))?.silent).toBe(false);

    const [seenAgain] = await db.select().from(listings).where(eq(listings.externalId, "1"));
    expect(isNear(seenAgain.lastSeenAt, later)).toBe(true);
    expect(isNear(seenAgain.firstSeenAt, NOW)).toBe(true);
    expect(seenAgain.firstSeenAt.getTime()).toBeLessThan(later.getTime());
    expect(await db.select().from(priceHistory)).toHaveLength(3);
  });

  it("does not alert when opts.notify is false", async () => {
    const cl = fakeAdapter("craigslist", { results: [scraped("craigslist", "1")] });
    const search = await insertSearch(db);
    await run(search.id, { craigslist: cl });
    cl.setResults([scraped("craigslist", "2")]);
    const result = await run(search.id, { craigslist: cl }, { now: minutesAfter(NOW, 5), notify: false });
    expect(result.events).toEqual([expect.objectContaining({ type: "new", silent: false })]);
    expect(notify).not.toHaveBeenCalled();
  });

  it("scores matches from comparable listings and the expected resale value", async () => {
    const prices = [45_000, 44_000, 46_000, 45_000, 45_000, 30_000];
    const cl = fakeAdapter("craigslist", {
      results: prices.map((p, i) => scraped("craigslist", String(i + 1), { priceCents: p })),
    });
    const search = await insertSearch(db, { expectedResaleCents: 50_000 });
    await run(search.id, { craigslist: cl });

    const cheap = await matchFor(search.id, "6");
    // Median of the other five is $450 → 33 % below → comp 92; margin 40 % → 90; average 91.
    expect(cheap.dealScore).toBe(91);
    expect(cheap.dealScoreReason).toBe("33% below the median of 5 similar listings ($450) · Est. profit $200 (40% margin)");
    expect(cheap.estimatedProfitCents).toBe(20_000);
  });

  it("detects price drops, records price history and alerts", async () => {
    const cl = fakeAdapter("craigslist", { results: [scraped("craigslist", "1", { priceCents: 40_000 })] });
    const search = await insertSearch(db);
    await run(search.id, { craigslist: cl });

    cl.setResults([scraped("craigslist", "1", { priceCents: 35_000 })]);
    const t1 = minutesAfter(NOW, 5);
    const drop = await run(search.id, { craigslist: cl }, { now: t1 });

    expect(drop.events).toEqual([expect.objectContaining({ type: "price_drop", previousPriceCents: 40_000, silent: false })]);
    expect(drop.marketplaces[0]).toMatchObject({ newCount: 0, priceDropCount: 1 });
    expect(notify).toHaveBeenCalledWith(db, drop.events);
    expect(await historyFor("1")).toEqual([40_000, 35_000]);
    const match = await matchFor(search.id, "1");
    expect(match).toMatchObject({ lastEvent: "price_drop", seen: false });
    expect(isNear(match.lastEventAt, t1)).toBe(true);
    const [listing] = await db.select().from(listings);
    expect(listing).toMatchObject({ priceCents: 35_000, originalPriceCents: 40_000 });
    const [runRow] = await db.select().from(scrapeRuns).where(eq(scrapeRuns.priceDropCount, 1));
    expect(runRow).toBeDefined();

    // Same price again: nothing new.
    const same = await run(search.id, { craigslist: cl }, { now: minutesAfter(NOW, 10) });
    expect(same.events).toEqual([]);

    // A rise is recorded but isn't an event; falling back to a price above the last alert isn't either.
    cl.setResults([scraped("craigslist", "1", { priceCents: 38_000 })]);
    expect((await run(search.id, { craigslist: cl }, { now: minutesAfter(NOW, 15) })).events).toEqual([]);
    cl.setResults([scraped("craigslist", "1", { priceCents: 36_000 })]);
    expect((await run(search.id, { craigslist: cl }, { now: minutesAfter(NOW, 20) })).events).toEqual([]);
    expect(await historyFor("1")).toEqual([40_000, 35_000, 38_000, 36_000]);

    // Below the last alerted price: a new drop, relative to what the user last heard.
    cl.setResults([scraped("craigslist", "1", { priceCents: 30_000 })]);
    const again = await run(search.id, { craigslist: cl }, { now: minutesAfter(NOW, 25) });
    expect(again.events).toEqual([expect.objectContaining({ type: "price_drop", previousPriceCents: 35_000 })]);
  });

  it("reports a drop to every matching search, even when another search saw it first", async () => {
    const cl = fakeAdapter("craigslist", { results: [scraped("craigslist", "1", { priceCents: 40_000 })] });
    const a = await insertSearch(db, { name: "A" });
    const b = await insertSearch(db, { name: "B" });
    await run(a.id, { craigslist: cl });
    await run(b.id, { craigslist: cl });

    cl.setResults([scraped("craigslist", "1", { priceCents: 30_000 })]);
    const first = await run(a.id, { craigslist: cl }, { now: minutesAfter(NOW, 5) });
    const second = await run(b.id, { craigslist: cl }, { now: minutesAfter(NOW, 6) });

    expect(first.events).toEqual([expect.objectContaining({ type: "price_drop", searchId: a.id, previousPriceCents: 40_000 })]);
    expect(second.events).toEqual([expect.objectContaining({ type: "price_drop", searchId: b.id, previousPriceCents: 40_000 })]);
    expect(await historyFor("1")).toEqual([40_000, 30_000]);
  });

  it("records price drops silently when the search opted out of them", async () => {
    const cl = fakeAdapter("craigslist", { results: [scraped("craigslist", "1", { priceCents: 40_000 })] });
    const search = await insertSearch(db, { notifyPriceDrops: false });
    await run(search.id, { craigslist: cl });
    cl.setResults([scraped("craigslist", "1", { priceCents: 20_000 })]);
    const result = await run(search.id, { craigslist: cl }, { now: minutesAfter(NOW, 5) });
    expect(result.events).toEqual([expect.objectContaining({ type: "price_drop", silent: true })]);
    expect(notify).not.toHaveBeenCalled();
  });

  it("applies price, exclude, query-negative and title filters but still stores every listing", async () => {
    const cl = fakeAdapter("craigslist", {
      results: [
        scraped("craigslist", "ok", { title: "PS5 slim", priceCents: 30_000 }),
        scraped("craigslist", "broken", { title: "PS5 BROKEN", priceCents: 30_000 }),
        scraped("craigslist", "parts", { title: "PS5", description: "Selling for parts", priceCents: 30_000 }),
        scraped("craigslist", "cheap", { priceCents: 5_000 }),
        scraped("craigslist", "pricey", { priceCents: 60_000 }),
        scraped("craigslist", "noprice", { priceCents: null }),
        scraped("craigslist", "offtopic", { title: "Xbox series x", priceCents: 30_000 }),
      ],
    });
    const search = await insertSearch(db, {
      query: 'ps5 -"for parts"',
      excludeTerms: ["broken"],
      minPriceCents: 10_000,
      maxPriceCents: 50_000,
      titleMustMatch: true,
    });

    const result = await run(search.id, { craigslist: cl });

    expect(result.marketplaces[0]).toMatchObject({ resultCount: 7, matchedCount: 1, newCount: 1 });
    expect(await db.select().from(listings)).toHaveLength(7);
    const matches = await db.select().from(searchMatches);
    expect(matches).toHaveLength(1);
    expect((await matchFor(search.id, "ok"))).toBeDefined();
  });

  it("keeps existing matches untouched when a listing stops passing the filters", async () => {
    const cl = fakeAdapter("craigslist", { results: [scraped("craigslist", "1", { priceCents: 30_000 })] });
    const search = await insertSearch(db, { maxPriceCents: 35_000 });
    await run(search.id, { craigslist: cl });
    cl.setResults([scraped("craigslist", "1", { priceCents: 60_000 })]);
    const result = await run(search.id, { craigslist: cl }, { now: minutesAfter(NOW, 5) });
    expect(result.events).toEqual([]);
    const match = await matchFor(search.id, "1");
    expect(match.lastEvent).toBe("new");
    expect(isNear(match.lastEventAt, NOW)).toBe(true);
  });

  it("de-duplicates repeated listings within one result set", async () => {
    const cl = fakeAdapter("craigslist", {
      results: [
        scraped("craigslist", "1", { priceCents: 40_000 }),
        scraped("craigslist", "1", { priceCents: 1_000 }),
        scraped("craigslist", "2"),
      ],
    });
    const search = await insertSearch(db);
    const result = await run(search.id, { craigslist: cl });
    expect(result.events).toHaveLength(2);
    expect(await db.select().from(listings)).toHaveLength(2);
    expect(await historyFor("1")).toEqual([40_000]);
  });

  it("drops unusable listings (no id, unsafe URL) without failing the batch", async () => {
    const cl = fakeAdapter("craigslist", {
      results: [
        scraped("craigslist", "1"),
        scraped("craigslist", "", {}),
        scraped("craigslist", "3", { url: "javascript:alert(1)" }),
      ],
    });
    const search = await insertSearch(db);
    const result = await run(search.id, { craigslist: cl });
    expect(result.marketplaces[0].resultCount).toBe(1);
    expect(result.marketplaces[0].error).toBeUndefined();
  });

  it("silences low scores but still records them", async () => {
    const cl = fakeAdapter("craigslist", { results: [scraped("craigslist", "seed")] });
    const search = await insertSearch(db, { maxListingAgeHours: 24, notifyMinDealScore: 60, expectedResaleCents: 50_000 });
    await run(search.id, { craigslist: cl });

    const later = minutesAfter(NOW, 5);
    cl.setResults([
      scraped("craigslist", "good", { priceCents: 35_000 }), // 30 % margin → 80
      scraped("craigslist", "meh", { priceCents: 48_000 }), // 4 % margin → 54
    ]);
    const result = await run(search.id, { craigslist: cl }, { now: later });

    const byId = Object.fromEntries(
      await Promise.all(["good", "meh"].map(async (id) => [id, (await matchFor(search.id, id)).silent])),
    );
    expect(byId).toEqual({ good: false, meh: true });
    expect(result.events.filter((e) => !e.silent)).toHaveLength(1);
    expect(notify).toHaveBeenCalledWith(db, [expect.objectContaining({ silent: false })]);
  });

  it("still alerts on matches that can't be scored yet when a minimum score is set", async () => {
    // Four comps (< 5) and no expected resale value: no score for anything.
    const cl = fakeAdapter("craigslist", {
      results: [40_000, 42_000, 41_000, 43_000].map((p, i) => scraped("craigslist", `c${i}`, { priceCents: p })),
    });
    const search = await insertSearch(db, { notifyMinDealScore: 70 });
    await run(search.id, { craigslist: cl });
    cl.setResults([scraped("craigslist", "steal", { priceCents: 20_000 })]);
    const result = await run(search.id, { craigslist: cl }, { now: minutesAfter(NOW, 5) });
    expect((await matchFor(search.id, "steal")).dealScore).toBeNull();
    expect(result.events).toEqual([expect.objectContaining({ type: "new", silent: false })]);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  describe("old listings (max listing age)", () => {
    it("alerts on an older listing whose price was cut into the search's range", async () => {
      const posted3dAgo = minutesAfter(NOW, -3 * 24 * 60);
      const cl = fakeAdapter("craigslist", { results: [scraped("craigslist", "seed", { priceCents: 25_000 })] });
      const search = await insertSearch(db, { maxPriceCents: 30_000, maxListingAgeHours: 24 });
      await run(search.id, { craigslist: cl });

      cl.setResults([scraped("craigslist", "seed", { priceCents: 25_000 }), scraped("craigslist", "old", { priceCents: 40_000, postedAt: posted3dAgo })]);
      expect((await run(search.id, { craigslist: cl }, { now: minutesAfter(NOW, 5) })).events).toEqual([]);

      // The seller cuts the price to $250: now inside the range.
      cl.setResults([scraped("craigslist", "seed", { priceCents: 25_000 }), scraped("craigslist", "old", { priceCents: 25_000, postedAt: posted3dAgo })]);
      const cut = await run(search.id, { craigslist: cl }, { now: minutesAfter(NOW, 10) });
      expect(cut.events).toEqual([expect.objectContaining({ type: "new", silent: false })]);
      expect(notify).toHaveBeenCalledTimes(1);
    });

    it("alerts on an older listing FlipWatch never saw before (e.g. only returned once its price dropped)", async () => {
      const cl = fakeAdapter("craigslist", { results: [scraped("craigslist", "seed")] });
      const search = await insertSearch(db, { maxListingAgeHours: 24 });
      await run(search.id, { craigslist: cl });
      cl.setResults([scraped("craigslist", "old", { postedAt: minutesAfter(NOW, -48 * 60) })]);
      const result = await run(search.id, { craigslist: cl }, { now: minutesAfter(NOW, 5) });
      expect(result.events).toEqual([expect.objectContaining({ type: "new", silent: false })]);
    });

    it("records older listings posted while the search wasn't polling silently when it catches up", async () => {
      const cl = fakeAdapter("craigslist", { results: [scraped("craigslist", "seed")] });
      const search = await insertSearch(db, { maxListingAgeHours: 24 });
      await run(search.id, { craigslist: cl });

      // Three days offline (or paused), then the search runs again.
      const back = minutesAfter(NOW, 3 * 24 * 60);
      cl.setResults([
        scraped("craigslist", "fresh", { postedAt: minutesAfter(back, -60) }),
        scraped("craigslist", "missed", { postedAt: minutesAfter(NOW, 24 * 60) }), // 2 days old, posted during the gap
        scraped("craigslist", "cut", { postedAt: minutesAfter(NOW, -24 * 60) }), // up before the gap, new to us
        scraped("craigslist", "undated", { postedAt: null }),
      ]);
      const result = await run(search.id, { craigslist: cl }, { now: back });
      const silentById = Object.fromEntries(
        await Promise.all(["fresh", "missed", "cut", "undated"].map(async (id) => [id, (await matchFor(search.id, id)).silent])),
      );
      expect(silentById).toEqual({ fresh: false, missed: true, cut: false, undated: false });
      expect(result.events.filter((e) => !e.silent)).toHaveLength(3);
    });
  });

  it("never emits the same new match twice when the same search runs concurrently", async () => {
    const cl = fakeAdapter("craigslist", { results: [scraped("craigslist", "1")] });
    const search = await insertSearch(db);
    await run(search.id, { craigslist: cl });
    cl.setResults([scraped("craigslist", "1"), scraped("craigslist", "2")]);

    const later = minutesAfter(NOW, 5);
    const [a, b] = await Promise.all([
      run(search.id, { craigslist: cl }, { now: later }),
      run(search.id, { craigslist: cl }, { now: later }),
    ]);

    expect([...a.events, ...b.events]).toHaveLength(1);
    expect(await db.select().from(searchMatches)).toHaveLength(2);
    expect(await db.select().from(listings)).toHaveLength(2);
    expect(await historyFor("2")).toHaveLength(1);
  });

  it("keeps running when notifications fail", async () => {
    notify.mockRejectedValueOnce(new Error("ntfy down"));
    const cl = fakeAdapter("craigslist", { results: [scraped("craigslist", "1")] });
    const search = await insertSearch(db);
    await run(search.id, { craigslist: cl });
    cl.setResults([scraped("craigslist", "2")]);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await run(search.id, { craigslist: cl }, { now: minutesAfter(NOW, 5) });
    expect(result.events).toHaveLength(1);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("ntfy down"));
    errors.mockRestore();
  });

  describe("AI evaluation", () => {
    it("evaluates alert-worthy matches before notifying when the search opted in and AI is configured", async () => {
      vi.mocked(aiStatus).mockReturnValue({ configured: true, model: "claude" });
      const cl = fakeAdapter("craigslist", { results: [scraped("craigslist", "1")] });
      const search = await insertSearch(db, { aiEvaluate: true });
      await run(search.id, { craigslist: cl });
      expect(evaluate).not.toHaveBeenCalled(); // first run is silent

      cl.setResults([scraped("craigslist", "2"), scraped("craigslist", "1")]);
      const later = minutesAfter(NOW, 5);
      const result = await run(search.id, { craigslist: cl }, { now: later });
      expect(evaluate).toHaveBeenCalledTimes(1);
      expect(evaluate).toHaveBeenCalledWith(db, result.events, { now: expect.any(Date) });
      expect(evaluate.mock.invocationCallOrder[0]).toBeLessThan(notify.mock.invocationCallOrder[0]);
    });

    it("waits for the first few evaluations only; the rest run in the background", async () => {
      vi.mocked(aiStatus).mockReturnValue({ configured: true, model: "claude" });
      const cl = fakeAdapter("craigslist", { results: [scraped("craigslist", "seed")] });
      const search = await insertSearch(db, { aiEvaluate: true });
      await run(search.id, { craigslist: cl });

      cl.setResults(Array.from({ length: 8 }, (_, i) => scraped("craigslist", `n${i}`)));
      const result = await run(search.id, { craigslist: cl }, { now: minutesAfter(NOW, 5) });
      await aiQueueIdle();
      expect(evaluate).toHaveBeenCalledTimes(2);
      expect(evaluate.mock.calls[0][1]).toEqual(result.events.slice(0, AI_BEFORE_ALERT_MAX));
      expect(evaluate.mock.calls[1][1]).toEqual(result.events.slice(AI_BEFORE_ALERT_MAX));
      expect(evaluate.mock.invocationCallOrder[0]).toBeLessThan(notify.mock.invocationCallOrder[0]);
      expect(notify).toHaveBeenCalledWith(db, result.events);
    });

    it("alerts without the verdict when the evaluation takes too long", async () => {
      vi.mocked(aiStatus).mockReturnValue({ configured: true, model: "claude" });
      let finish!: () => void;
      evaluate.mockImplementationOnce(() => new Promise((resolve) => (finish = () => resolve({ evaluations: [], errors: [] }))));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const event = { type: "new" as const, matchId: 1, searchId: 1, listingId: 1, silent: false };
      await evaluateBeforeAlerting(db, [event], NOW, 20);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("alerting without it"));
      finish();
      await aiQueueIdle();
      warn.mockRestore();
    });

    it("skips AI when not configured or not requested, and survives AI failures", async () => {
      const cl = fakeAdapter("craigslist", { results: [scraped("craigslist", "1")] });
      const optedIn = await insertSearch(db, { aiEvaluate: true });
      const optedOut = await insertSearch(db, { aiEvaluate: false });
      for (const s of [optedIn, optedOut]) await run(s.id, { craigslist: cl });
      cl.setResults([scraped("craigslist", "2")]);

      await run(optedIn.id, { craigslist: cl }, { now: minutesAfter(NOW, 5) }); // not configured
      vi.mocked(aiStatus).mockReturnValue({ configured: true, model: "claude" });
      await run(optedOut.id, { craigslist: cl }, { now: minutesAfter(NOW, 5) }); // not requested
      await aiQueueIdle();
      expect(evaluate).not.toHaveBeenCalled();

      notify.mockClear();
      evaluate.mockResolvedValueOnce({ evaluations: [], errors: [{ listingId: 1, searchId: optedIn.id, error: "overloaded" }] });
      evaluate.mockRejectedValueOnce(new Error("database gone"));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      cl.setResults([scraped("craigslist", "3")]);
      await run(optedIn.id, { craigslist: cl }, { now: minutesAfter(NOW, 10) });
      cl.setResults([scraped("craigslist", "4")]);
      const survived = await run(optedIn.id, { craigslist: cl }, { now: minutesAfter(NOW, 15) });
      await aiQueueIdle();
      expect(evaluate).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("overloaded"));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("database gone"));
      expect(survived.events).toHaveLength(1);
      expect(notify).toHaveBeenCalledTimes(2);
      warn.mockRestore();
    });
  });
});

describe("runSearch match bookkeeping", () => {
  it("turns a silent match into an alert-worthy, unseen one when it drops in price", async () => {
    const cl = fakeAdapter("craigslist", { results: [scraped("craigslist", "1", { priceCents: 40_000 })] });
    const search = await insertSearch(db);
    await run(search.id, { craigslist: cl }); // first run: silent
    await db.update(searchMatches).set({ seen: true });

    cl.setResults([scraped("craigslist", "1", { priceCents: 30_000 })]);
    const drop = await run(search.id, { craigslist: cl }, { now: minutesAfter(NOW, 5) });

    expect(drop.events).toEqual([expect.objectContaining({ type: "price_drop", silent: false })]);
    expect(await matchFor(search.id, "1")).toMatchObject({ lastEvent: "price_drop", silent: false, seen: false, notifiedAt: null });
    expect(await countUnseen(db, DEFAULT_FEED_FILTERS)).toBe(1);
  });

  it("leaves the row alone for a silent price drop", async () => {
    const cl = fakeAdapter("craigslist", { results: [scraped("craigslist", "1", { priceCents: 40_000 })] });
    const search = await insertSearch(db, { notifyPriceDrops: false });
    await run(search.id, { craigslist: cl });
    cl.setResults([scraped("craigslist", "1", { priceCents: 30_000 })]);
    await run(search.id, { craigslist: cl }, { now: minutesAfter(NOW, 5) });
    expect(await matchFor(search.id, "1")).toMatchObject({ lastEvent: "price_drop", silent: true, seen: false });
  });

  it("ignores tiny drops (under 1 % or under one currency unit)", async () => {
    const cl = fakeAdapter("craigslist", { results: [scraped("craigslist", "1", { priceCents: 40_000 }), scraped("craigslist", "2", { priceCents: 5_000 })] });
    const search = await insertSearch(db);
    await run(search.id, { craigslist: cl });
    cl.setResults([scraped("craigslist", "1", { priceCents: 39_700 }), scraped("craigslist", "2", { priceCents: 4_901 })]);
    expect((await run(search.id, { craigslist: cl }, { now: minutesAfter(NOW, 5) })).events).toEqual([]);
    // Measured from the last event's price, so small cuts add up.
    cl.setResults([scraped("craigslist", "1", { priceCents: 39_600 }), scraped("craigslist", "2", { priceCents: 4_900 })]);
    const drops = await run(search.id, { craigslist: cl }, { now: minutesAfter(NOW, 10) });
    expect(drops.events.map((e) => [e.type, e.previousPriceCents])).toEqual([
      ["price_drop", 40_000],
      ["price_drop", 5_000],
    ]);
  });

  it("treats a currency change as a new baseline, not a price drop", async () => {
    // The same eBay item seen by a Canadian search (CAD) and a US search (USD).
    const ebay = fakeAdapter("ebay", { results: [scraped("ebay", "v1|1|0", { priceCents: 13_700, currency: "CAD" })] });
    const ca = await insertSearch(db, { name: "CA", marketplaces: ["ebay"] });
    const us = await insertSearch(db, { name: "US", marketplaces: ["ebay"], location: { ...DEFAULT_LOCATION, countryCode: "US" } });
    await run(ca.id, { ebay });
    await run(us.id, { ebay });

    ebay.setResults([scraped("ebay", "v1|1|0", { priceCents: 10_000, currency: "USD" })]);
    expect((await run(us.id, { ebay }, { now: minutesAfter(NOW, 5) })).events).toEqual([]);
    ebay.setResults([scraped("ebay", "v1|1|0", { priceCents: 13_700, currency: "CAD" })]);
    expect((await run(ca.id, { ebay }, { now: minutesAfter(NOW, 6) })).events).toEqual([]);
    ebay.setResults([scraped("ebay", "v1|1|0", { priceCents: 10_000, currency: "USD" })]);
    expect((await run(ca.id, { ebay }, { now: minutesAfter(NOW, 7) })).events).toEqual([]);
    expect(await historyFor("v1|1|0")).toEqual([13_700, 10_000, 13_700, 10_000]);

    // A real drop in the new currency is still reported, against the first price seen in it.
    ebay.setResults([scraped("ebay", "v1|1|0", { priceCents: 8_000, currency: "USD" })]);
    const drop = await run(ca.id, { ebay }, { now: minutesAfter(NOW, 8) });
    expect(drop.events).toEqual([expect.objectContaining({ type: "price_drop", previousPriceCents: 10_000 })]);
  });

  it("reports drops on a match first recorded without a price", async () => {
    const cl = fakeAdapter("craigslist", { results: [scraped("craigslist", "seed")] });
    const search = await insertSearch(db);
    await run(search.id, { craigslist: cl });

    cl.setResults([scraped("craigslist", "seed"), scraped("craigslist", "np", { priceCents: null })]);
    await run(search.id, { craigslist: cl }, { now: minutesAfter(NOW, 5) });
    cl.setResults([scraped("craigslist", "seed"), scraped("craigslist", "np", { priceCents: 50_000 })]);
    expect((await run(search.id, { craigslist: cl }, { now: minutesAfter(NOW, 10) })).events).toEqual([]);
    cl.setResults([scraped("craigslist", "seed"), scraped("craigslist", "np", { priceCents: 20_000 })]);
    const dropped = await run(search.id, { craigslist: cl }, { now: minutesAfter(NOW, 15) });
    expect(dropped.events).toEqual([expect.objectContaining({ type: "price_drop", previousPriceCents: 50_000, silent: false })]);
  });

  it("doesn't score placeholder prices or count them as comps", async () => {
    const prices = [45_000, 44_000, 46_000, 45_000, 100, 100];
    const cl = fakeAdapter("craigslist", { results: prices.map((p, i) => scraped("craigslist", `c${i}`, { priceCents: p })) });
    const search = await insertSearch(db);
    await run(search.id, { craigslist: cl });
    expect(await matchFor(search.id, "c4")).toMatchObject({ dealScore: null, dealScoreReason: "Placeholder price" });

    // Four real comps stored + this one's own price: still not enough for a median, so no score (and no 100/100 "deal").
    cl.setResults([scraped("craigslist", "new", { priceCents: 30_000 })]);
    await run(search.id, { craigslist: cl }, { now: minutesAfter(NOW, 5) });
    expect((await matchFor(search.id, "new")).dealScore).toBeNull();
  });

  it("marks matched listings gone once the marketplace stops returning them, and active when they come back", async () => {
    const cl = fakeAdapter("craigslist", {
      results: [
        scraped("craigslist", "sold-soon", { postedAt: minutesAfter(NOW, -10) }),
        scraped("craigslist", "stays", { postedAt: minutesAfter(NOW, -60) }),
        scraped("craigslist", "oldest", { postedAt: minutesAfter(NOW, -120) }),
      ],
    });
    const search = await insertSearch(db);
    await run(search.id, { craigslist: cl });
    const status = async (id: string) => (await db.select().from(listings).where(eq(listings.externalId, id)))[0].status;

    // "sold-soon" disappears although older "stays" is still returned; "oldest" merely fell out of the result window.
    cl.setResults([scraped("craigslist", "stays", { postedAt: minutesAfter(NOW, -60) })]);
    await run(search.id, { craigslist: cl }, { now: minutesAfter(NOW, 2 * 24 * 60) });
    expect(await status("sold-soon")).toBe("active");
    await run(search.id, { craigslist: cl }, { now: minutesAfter(NOW, 4 * 24 * 60) });
    expect(await status("sold-soon")).toBe("gone");
    expect(await status("oldest")).toBe("active");

    cl.setResults([scraped("craigslist", "sold-soon", { postedAt: minutesAfter(NOW, -10) })]);
    await run(search.id, { craigslist: cl }, { now: minutesAfter(NOW, 5 * 24 * 60) });
    expect(await status("sold-soon")).toBe("active");
  });

  it("doesn't rewrite listings whose signed image URLs only changed their signature", async () => {
    const image = (sig: string, expiresAt: Date) =>
      `https://scontent.xx.fbcdn.net/v/t45/1_n.jpg?_nc_cat=1&oh=${sig}&oe=${Math.floor(expiresAt.getTime() / 1000).toString(16).toUpperCase()}`;
    const far = minutesAfter(NOW, 10 * 24 * 60);
    const cl = fakeAdapter("facebook", { results: [scraped("facebook", "1", { imageUrls: [image("a", far)] })] });
    const search = await insertSearch(db, { marketplaces: ["facebook"] });
    await run(search.id, { facebook: cl });
    const stored = async () => (await db.select().from(listings))[0].imageUrls;

    cl.setResults([scraped("facebook", "1", { imageUrls: [image("b", far)] })]);
    await run(search.id, { facebook: cl }, { now: minutesAfter(NOW, 5) });
    expect(await stored()).toEqual([image("a", far)]);

    // Refreshed once the stored signature is about to expire.
    cl.setResults([scraped("facebook", "1", { imageUrls: [image("c", minutesAfter(far, 10 * 24 * 60))] })]);
    await run(search.id, { facebook: cl }, { now: minutesAfter(far, -60) });
    expect(await stored()).toEqual([image("c", minutesAfter(far, 10 * 24 * 60))]);
  });
});

describe("runSearch after a search is edited", () => {
  const edit = async (id: number, changes: Partial<SearchInput>) => {
    const s = await getSearch(db, id);
    const input: SearchInput = {
      name: s.name,
      query: s.query,
      excludeTerms: s.excludeTerms,
      titleMustMatch: s.titleMustMatch,
      minPriceCents: s.minPriceCents,
      maxPriceCents: s.maxPriceCents,
      expectedResaleCents: s.expectedResaleCents,
      marketplaces: s.marketplaces,
      location: s.location,
      category: s.category,
      pollIntervalSec: s.pollIntervalSec,
      maxListingAgeHours: s.maxListingAgeHours,
      notifyChannelIds: s.notifyChannelIds,
      notifyMinDealScore: s.notifyMinDealScore,
      notifyPriceDrops: s.notifyPriceDrops,
      aiEvaluate: s.aiEvaluate,
      enabled: s.enabled,
      ...changes,
    };
    return updateSearch(db, id, input, minutesAfter(NOW, 1));
  };

  it("restarts first-run silence when the query changes", async () => {
    const cl = fakeAdapter("craigslist", { results: [scraped("craigslist", "ps5-1"), scraped("craigslist", "ps5-2")] });
    const search = await insertSearch(db, { query: "ps5" });
    await run(search.id, { craigslist: cl });

    const edited = await edit(search.id, { query: "nintendo switch" });
    expect(edited?.definitionChangedAt).toEqual(minutesAfter(NOW, 1));
    cl.setResults(Array.from({ length: 40 }, (_, i) => scraped("craigslist", `sw-${i}`, { title: `Nintendo Switch ${i}` })));
    const first = await run(search.id, { craigslist: cl }, { now: minutesAfter(NOW, 5) });
    expect(first.events).toHaveLength(40);
    expect(first.events.every((e) => e.silent)).toBe(true);
    expect(notify).not.toHaveBeenCalled();

    // Runs after that alert as usual.
    cl.setResults([scraped("craigslist", "sw-new", { title: "Nintendo Switch OLED" })]);
    const next = await run(search.id, { craigslist: cl }, { now: minutesAfter(NOW, 10) });
    expect(next.events).toEqual([expect.objectContaining({ silent: false })]);
  });

  it("keeps alerting when only alert settings or the name change", async () => {
    const cl = fakeAdapter("craigslist", { results: [scraped("craigslist", "1")] });
    const search = await insertSearch(db);
    await run(search.id, { craigslist: cl });

    const edited = await edit(search.id, {
      name: "Renamed",
      query: "  PS5 ",
      notifyMinDealScore: 10,
      location: { ...DEFAULT_LOCATION, label: "Home" },
    });
    expect(edited?.definitionChangedAt).toBeNull();
    cl.setResults([scraped("craigslist", "2")]);
    const result = await run(search.id, { craigslist: cl }, { now: minutesAfter(NOW, 5) });
    expect(result.events).toEqual([expect.objectContaining({ silent: false })]);
  });

  it.each([
    ["exclude terms", { excludeTerms: ["broken"] }],
    ["title matching", { titleMustMatch: true }],
    ["price range", { maxPriceCents: 50_000 }],
    ["radius", { location: { ...DEFAULT_LOCATION, radiusKm: DEFAULT_LOCATION.radiusKm + 10 } }],
    ["category", { category: "video_games" }],
  ] as const)("treats a change of %s as a new definition", async (_, changes) => {
    const search = await insertSearch(db);
    const edited = await edit(search.id, changes as Partial<SearchInput>);
    expect(edited?.definitionChangedAt).toEqual(minutesAfter(NOW, 1));
  });
});

describe("runSearch alert retries", () => {
  it("offers undelivered alerts of recent matches to notify again", async () => {
    const cl = fakeAdapter("craigslist", { results: [scraped("craigslist", "1")] });
    const search = await insertSearch(db);
    await run(search.id, { craigslist: cl });
    cl.setResults([scraped("craigslist", "1"), scraped("craigslist", "2")]);
    const failed = await run(search.id, { craigslist: cl }, { now: minutesAfter(NOW, 5) }); // notify "fails": notifiedAt stays null
    const [event] = failed.events;

    // Too soon: its own run may still be delivering it.
    notify.mockClear();
    await run(search.id, { craigslist: cl }, { now: minutesAfter(NOW, 5 + (ALERT_RETRY_AFTER_MS / 60_000) / 2) });
    expect(notify).not.toHaveBeenCalled();

    await run(search.id, { craigslist: cl }, { now: minutesAfter(NOW, 15) });
    expect(notify).toHaveBeenCalledWith(db, [{ ...event, previousPriceCents: null }]);

    // Delivered, seen, dismissed, silent or older than the retry window: not offered again.
    notify.mockClear();
    await db.update(searchMatches).set({ notifiedAt: minutesAfter(NOW, 16) });
    await run(search.id, { craigslist: cl }, { now: minutesAfter(NOW, 20) });
    await db.update(searchMatches).set({ notifiedAt: null, seen: true });
    await run(search.id, { craigslist: cl }, { now: minutesAfter(NOW, 25) });
    await db.update(searchMatches).set({ seen: false, dismissed: true });
    await run(search.id, { craigslist: cl }, { now: minutesAfter(NOW, 30) });
    await db.update(searchMatches).set({ dismissed: false });
    await run(search.id, { craigslist: cl }, { now: minutesAfter(NOW, 7 * 60) });
    expect(notify).not.toHaveBeenCalled();
  });

  it("retries a price drop with the price it dropped from, not the first-seen price", async () => {
    const cl = fakeAdapter("craigslist", { results: [scraped("craigslist", "1", { priceCents: 36_000 })] });
    const search = await insertSearch(db);
    await run(search.id, { craigslist: cl });
    // $360 → $350: alerted and delivered.
    cl.setResults([scraped("craigslist", "1", { priceCents: 35_000 })]);
    await run(search.id, { craigslist: cl }, { now: minutesAfter(NOW, 5) });
    await db.update(searchMatches).set({ notifiedAt: minutesAfter(NOW, 5) });
    // $350 → $340: every channel fails, so notifiedAt stays null.
    cl.setResults([scraped("craigslist", "1", { priceCents: 34_000 })]);
    const failed = await run(search.id, { craigslist: cl }, { now: minutesAfter(NOW, 10) });
    expect(failed.events).toEqual([expect.objectContaining({ type: "price_drop", previousPriceCents: 35_000 })]);

    notify.mockClear();
    await run(search.id, { craigslist: cl }, { now: minutesAfter(NOW, 20) });
    expect(notify).toHaveBeenCalledWith(db, [{ ...failed.events[0], previousPriceCents: 35_000 }]);
  });

  it("does not retry when notifications are off for the run", async () => {
    const cl = fakeAdapter("craigslist", { results: [scraped("craigslist", "1")] });
    const search = await insertSearch(db);
    await run(search.id, { craigslist: cl });
    cl.setResults([scraped("craigslist", "2")]);
    await run(search.id, { craigslist: cl }, { now: minutesAfter(NOW, 5) });
    notify.mockClear();
    await run(search.id, { craigslist: cl }, { now: minutesAfter(NOW, 15), notify: false });
    expect(notify).not.toHaveBeenCalled();
  });
});
