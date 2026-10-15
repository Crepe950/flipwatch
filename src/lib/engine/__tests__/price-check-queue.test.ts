import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type Db } from "../../db";
import { aiEvaluations, priceChecks } from "../../db/schema";
import type { MatchEvent } from "../../events";
import { seedListing, seedSearch } from "../../ai/testing/seed";

const priceCheckListing = vi.fn(async () => ({ summary: "ok" }));
vi.mock("../../ai", () => ({ priceCheckListing: (...args: unknown[]) => priceCheckListing(...(args as [])) }));
vi.mock("../../ai/client", () => ({ isAiConfigured: () => true }));

const { AUTO_PRICE_CHECKS_PER_HOUR, autoPriceChecksIdle, queueAutoPriceChecks, resetAutoPriceChecks } = await import("../price-check-queue");

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(async () => {
  await close();
});
beforeEach(() => {
  resetAutoPriceChecks();
  priceCheckListing.mockClear();
});

const NOW = new Date("2026-10-06T20:00:00Z");
const event = (searchId: number, listingId: number): MatchEvent => ({ type: "new", matchId: listingId, searchId, listingId, silent: false }) as MatchEvent;
const score = (listingId: number, dealScore: number) =>
  db.insert(aiEvaluations).values({ listingId, model: "m", verdict: dealScore >= 60 ? "good" : "pass", dealScore, summary: "s" });

describe("queueAutoPriceChecks", () => {
  it("checks listings that pass the AI-score filter and haven't been checked today", async () => {
    const search = await seedSearch(db, { name: "Desktop PCs", notifyMinAiScore: 70, notifyMinProfitPct: 20 });
    const [good, weak, unscored, checked] = await Promise.all([seedListing(db), seedListing(db), seedListing(db), seedListing(db)]);
    await score(good.id, 80);
    await score(weak.id, 50);
    await score(checked.id, 90);
    await db.insert(priceChecks).values({ listingId: checked.id, model: "m", result: {}, createdAt: new Date(NOW.getTime() - 3_600_000) });

    const started = await queueAutoPriceChecks(db, search, [good, weak, unscored, checked].map((l) => event(search.id, l.id)), NOW);
    await autoPriceChecksIdle();
    expect(started).toEqual([good.id]);
    expect(priceCheckListing).toHaveBeenCalledTimes(1);
  });

  it("does nothing for searches without a profit target", async () => {
    const search = await seedSearch(db, { notifyMinAiScore: 70 });
    const listing = await seedListing(db);
    await score(listing.id, 95);
    expect(await queueAutoPriceChecks(db, search, [event(search.id, listing.id)], NOW)).toEqual([]);
  });

  it("caps checks per hour; the rest wait for a later run", async () => {
    const search = await seedSearch(db, { notifyMinProfitPct: 20 });
    const listings = await Promise.all(Array.from({ length: AUTO_PRICE_CHECKS_PER_HOUR + 2 }, () => seedListing(db)));
    const events = listings.map((l) => event(search.id, l.id));
    expect(await queueAutoPriceChecks(db, search, events, NOW)).toHaveLength(AUTO_PRICE_CHECKS_PER_HOUR);
    await autoPriceChecksIdle();
    expect(await queueAutoPriceChecks(db, search, events.slice(-2), new Date(NOW.getTime() + 30 * 60_000))).toEqual([]);
    expect(await queueAutoPriceChecks(db, search, events.slice(-2), new Date(NOW.getTime() + 61 * 60_000))).toHaveLength(2);
    await autoPriceChecksIdle();
  });
});
