import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, type Db } from "@/lib/db";
import { aiEvaluations, appSettings, deals, notificationChannels, searchMatches } from "@/lib/db/schema";
import {
  countUnseen,
  DEFAULT_FEED_FILTERS,
  decodeFeedCursor,
  encodeFeedCursor,
  getFeedPage,
  getFeedStats,
  markAllMatchesSeen,
  parseHeartbeatSource,
  parseWorkerHeartbeat,
  setMatchDismissed,
  setMatchSeen,
  workerStatus,
  type FeedCursor,
  type FeedFilters,
} from "@/lib/queries/feed";
import { insertListing, insertMatch, insertSearch } from "./fixtures";

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
});

afterEach(async () => {
  await close();
});

const f = (overrides: Partial<FeedFilters> = {}): FeedFilters => ({ ...DEFAULT_FEED_FILTERS, ...overrides });
const minutesAgo = (base: Date, m: number) => new Date(base.getTime() - m * 60_000);

describe("getFeedPage", () => {
  it("returns card data joined with search, AI verdict and deal, newest event first", async () => {
    const now = new Date("2026-09-28T12:00:00Z");
    const search = await insertSearch(db, "PS5");
    const older = await insertListing(db, { title: "PS5 disc edition", imageUrls: ["https://img.example/1.jpg", "https://img.example/2.jpg"] });
    const newer = await insertListing(db, { title: "PS5 slim", marketplace: "kijiji", priceCents: 38000, originalPriceCents: 42000 });
    await insertMatch(db, search.id, older.id, { lastEventAt: minutesAgo(now, 30), dealScore: 72 });
    await insertMatch(db, search.id, newer.id, { lastEventAt: minutesAgo(now, 5), lastEvent: "price_drop" });
    await db.insert(aiEvaluations).values([
      { listingId: older.id, model: "m", verdict: "fair", dealScore: 50, summary: "old", createdAt: minutesAgo(now, 20) },
      { listingId: older.id, model: "m", verdict: "great", dealScore: 90, summary: "new", createdAt: minutesAgo(now, 10) },
    ]);
    const [deal] = await db.insert(deals).values({ listingId: older.id, stage: "contacted" }).returning();

    const page = await getFeedPage(db, f());
    expect(page.nextCursor).toBeNull();
    expect(page.items.map((i) => i.title)).toEqual(["PS5 slim", "PS5 disc edition"]);
    const [slim, disc] = page.items;
    expect(slim).toMatchObject({ lastEvent: "price_drop", priceCents: 38000, originalPriceCents: 42000, searchName: "PS5", imageUrl: null, dealId: null });
    expect(disc).toMatchObject({ imageUrl: "https://img.example/1.jpg", aiVerdict: "great", aiDealScore: 90, dealId: deal.id, dealStage: "contacted", dealScore: 72 });
    expect(typeof disc.lastEventAt).toBe("string");
    // When the listing last showed up in results ("not seen recently" badge).
    expect(disc.lastSeenAt).toBe(older.lastSeenAt.toISOString());
  });

  it("applies every filter", async () => {
    const now = new Date();
    const ps5 = await insertSearch(db, "PS5");
    const aeron = await insertSearch(db, "Aeron");
    const a = await insertListing(db, { title: "PS5 with 2 controllers", marketplace: "craigslist" });
    const b = await insertListing(db, { title: "PS5 digital 100% working", marketplace: "kijiji" });
    const c = await insertListing(db, { title: "Herman Miller Aeron size B", marketplace: "facebook" });
    const d = await insertListing(db, { title: "PS5 old stock", marketplace: "craigslist" });
    const e = await insertListing(db, { title: "PS5 dismissed", marketplace: "craigslist" });
    await insertMatch(db, ps5.id, a.id, { lastEventAt: minutesAgo(now, 1), dealScore: 80 });
    await insertMatch(db, ps5.id, b.id, { lastEventAt: minutesAgo(now, 2), dealScore: 40, lastEvent: "price_drop" });
    await insertMatch(db, aeron.id, c.id, { lastEventAt: minutesAgo(now, 3), dealScore: 95 });
    await insertMatch(db, ps5.id, d.id, { lastEventAt: minutesAgo(now, 4), silent: true });
    await insertMatch(db, ps5.id, e.id, { lastEventAt: minutesAgo(now, 5), dismissed: true });

    const titles = async (filters: FeedFilters) => (await getFeedPage(db, filters)).items.map((i) => i.title);

    expect(await titles(f())).toEqual(["PS5 with 2 controllers", "PS5 digital 100% working", "Herman Miller Aeron size B", "PS5 old stock"]);
    expect(await titles(f({ searchId: aeron.id }))).toEqual(["Herman Miller Aeron size B"]);
    expect(await titles(f({ marketplace: "kijiji" }))).toEqual(["PS5 digital 100% working"]);
    expect(await titles(f({ event: "price_drop" }))).toEqual(["PS5 digital 100% working"]);
    expect(await titles(f({ minScore: 80 }))).toEqual(["PS5 with 2 controllers", "Herman Miller Aeron size B"]);
    expect(await titles(f({ includeInitial: false }))).not.toContain("PS5 old stock");
    expect(await titles(f({ includeDismissed: true }))).toContain("PS5 dismissed");
    expect(await titles(f({ q: "aeron" }))).toEqual(["Herman Miller Aeron size B"]);
    // LIKE wildcards in user input are matched literally.
    expect(await titles(f({ q: "100%" }))).toEqual(["PS5 digital 100% working"]);
    expect(await titles(f({ q: "_" }))).toEqual([]);
  });

  it("paginates with a stable keyset cursor, including rows sharing a millisecond", async () => {
    const search = await insertSearch(db);
    const base = new Date("2026-09-28T12:00:00.000Z");
    const ids: number[] = [];
    for (let i = 0; i < 7; i++) {
      const l = await insertListing(db, { title: `Item ${i}` });
      const m = await insertMatch(db, search.id, l.id, { lastEventAt: minutesAgo(base, i) });
      ids.push(m.id);
    }
    // Three rows in the same millisecond but different microseconds (as now() would write them).
    const shared: number[] = [];
    for (const micros of ["123456", "123400", "123999"]) {
      const l = await insertListing(db, { title: `Same ms ${micros}` });
      const m = await insertMatch(db, search.id, l.id);
      await db
        .update(searchMatches)
        .set({ lastEventAt: sql`${`2026-09-28T11:00:00.${micros}Z`}::timestamptz` })
        .where(sql`${searchMatches.id} = ${m.id}`);
      shared.push(m.id);
    }

    const seen: number[] = [];
    let cursor: FeedCursor | null = null;
    let pages = 0;
    do {
      const page = await getFeedPage(db, f(), { cursor, limit: 3 });
      seen.push(...page.items.map((i) => i.matchId));
      cursor = page.nextCursor ? decodeFeedCursor(page.nextCursor) : null;
      pages++;
    } while (cursor && pages < 10);

    expect(pages).toBe(4);
    expect(new Set(seen).size).toBe(10);
    expect(seen.slice(0, 7)).toEqual(ids);
    expect(seen.slice(7).sort()).toEqual([...shared].sort());
  });

  it("round-trips and rejects malformed cursors", () => {
    const at = new Date("2026-09-28T12:00:00.123Z");
    expect(decodeFeedCursor(encodeFeedCursor({ at, matchId: 42 }))).toEqual({ at, matchId: 42 });
    expect(decodeFeedCursor("nope")).toBeNull();
    expect(decodeFeedCursor("123_abc")).toBeNull();
    expect(decodeFeedCursor("1_2_3")).toBeNull();
  });

  it("returns an empty page on an empty database", async () => {
    expect(await getFeedPage(db, f())).toEqual({ items: [], nextCursor: null });
  });
});

describe("getFeedPage with since (live polling)", () => {
  const since = (filters: FeedFilters, at: Date, opts: { limit?: number; cursor?: FeedCursor | null } = {}) =>
    getFeedPage(db, filters, { since: at, ...opts });

  it("returns events at or after the timestamp (boundary inclusive) and respects filters", async () => {
    const search = await insertSearch(db);
    const t0 = new Date("2026-09-28T12:00:00.000Z");
    const before = await insertListing(db, { title: "before" });
    const boundary = await insertListing(db, { title: "boundary" });
    const after = await insertListing(db, { title: "after", marketplace: "kijiji" });
    await insertMatch(db, search.id, before.id, { lastEventAt: new Date(t0.getTime() - 1) });
    await insertMatch(db, search.id, boundary.id, { lastEventAt: t0 });
    await insertMatch(db, search.id, after.id, { lastEventAt: new Date(t0.getTime() + 5000) });

    const page = await since(f(), t0);
    expect(page.items.map((i) => i.title)).toEqual(["after", "boundary"]);
    expect(page.nextCursor).toBeNull();
    expect((await since(f({ marketplace: "kijiji" }), t0)).items.map((i) => i.title)).toEqual(["after"]);
    expect((await since(f(), new Date(t0.getTime() + 60_000))).items).toEqual([]);
  });

  it("surfaces an existing match again when it gets a newer event (price drop)", async () => {
    const search = await insertSearch(db);
    const t0 = new Date("2026-09-28T12:00:00.000Z");
    const l = await insertListing(db);
    const m = await insertMatch(db, search.id, l.id, { lastEventAt: new Date(t0.getTime() - 60_000) });
    expect((await since(f(), t0)).items).toHaveLength(0);
    await db.update(searchMatches).set({ lastEvent: "price_drop", lastEventAt: t0 }).where(sql`${searchMatches.id} = ${m.id}`);
    const { items } = await since(f(), t0);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ matchId: m.id, lastEvent: "price_drop" });
  });

  it("pages through a burst bigger than the limit instead of dropping the rest", async () => {
    const search = await insertSearch(db);
    const t0 = new Date("2026-09-28T12:00:00.000Z");
    // A first run writes many matches with the same event time.
    for (let i = 0; i < 7; i++) {
      const l = await insertListing(db, { title: `Burst ${i}` });
      await insertMatch(db, search.id, l.id, { lastEventAt: t0 });
    }
    const old = await insertListing(db, { title: "old" });
    await insertMatch(db, search.id, old.id, { lastEventAt: new Date(t0.getTime() - 60_000) });

    const seen: string[] = [];
    let cursor: FeedCursor | null = null;
    let pages = 0;
    do {
      const page = await since(f(), t0, { limit: 3, cursor });
      seen.push(...page.items.map((i) => i.title));
      cursor = page.nextCursor ? decodeFeedCursor(page.nextCursor) : null;
      pages++;
    } while (cursor && pages < 10);

    expect(pages).toBe(3);
    expect(seen.sort()).toEqual(Array.from({ length: 7 }, (_, i) => `Burst ${i}`));
  });
});

describe("match mutations and unseen count", () => {
  it("dismisses, restores (keeping the seen state), marks seen and counts unseen alerts", async () => {
    const search = await insertSearch(db);
    const a = await insertListing(db);
    const b = await insertListing(db);
    const c = await insertListing(db);
    const ma = await insertMatch(db, search.id, a.id);
    const mb = await insertMatch(db, search.id, b.id);
    await insertMatch(db, search.id, c.id, { silent: true });

    expect(await countUnseen(db, f())).toBe(2);
    expect(await setMatchDismissed(db, ma.id, true)).toBe(a.id);
    expect(await countUnseen(db, f())).toBe(1);
    expect((await getFeedPage(db, f())).items.map((i) => i.matchId)).not.toContain(ma.id);

    expect(await setMatchDismissed(db, ma.id, false)).toBe(a.id);
    const restored = (await getFeedPage(db, f())).items.find((i) => i.matchId === ma.id);
    expect(restored).toMatchObject({ dismissed: false, seen: false });
    expect(await countUnseen(db, f())).toBe(2);

    expect(await setMatchSeen(db, mb.id, true)).toBe(b.id);
    expect(await countUnseen(db, f())).toBe(1);
    expect(await setMatchSeen(db, 999_999, true)).toBeNull();

    await setMatchSeen(db, mb.id, false);
    // Exactly what countUnseen counts: the silent match stays as it was.
    expect(await markAllMatchesSeen(db, f())).toBe(2);
    expect(await countUnseen(db, f())).toBe(0);
    expect(await markAllMatchesSeen(db, f())).toBe(0);
  });

  it("marks only the unseen alerts that pass the feed's filters", async () => {
    const ps5 = await insertSearch(db, "PS5");
    const aeron = await insertSearch(db, "Aeron");
    const ps5Kijiji = await insertMatch(db, ps5.id, (await insertListing(db, { title: "PS5 slim", marketplace: "kijiji" })).id);
    const ps5Craigslist = await insertMatch(db, ps5.id, (await insertListing(db, { title: "PS5 disc" })).id);
    const chair = await insertMatch(db, aeron.id, (await insertListing(db, { title: "Aeron chair" })).id);
    const dismissed = await insertMatch(db, ps5.id, (await insertListing(db, { title: "PS5 dismissed" })).id, { dismissed: true });

    const filtered = f({ searchId: ps5.id, marketplace: "kijiji" });
    expect(await countUnseen(db, filtered)).toBe(1);
    expect(await markAllMatchesSeen(db, filtered)).toBe(1);
    expect(await countUnseen(db, filtered)).toBe(0);

    const seenById = async () =>
      Object.fromEntries((await db.select().from(searchMatches)).map((m) => [m.id, m.seen])) as Record<number, boolean>;
    expect(await seenById()).toEqual({ [ps5Kijiji.id]: true, [ps5Craigslist.id]: false, [chair.id]: false, [dismissed.id]: false });

    // Title search too, and dismissed matches never count even when the feed shows them.
    expect(await markAllMatchesSeen(db, f({ q: "aeron", includeDismissed: true }))).toBe(1);
    expect(await seenById()).toEqual({ [ps5Kijiji.id]: true, [ps5Craigslist.id]: false, [chair.id]: true, [dismissed.id]: false });
    expect(await countUnseen(db, f())).toBe(1);
  });
});

describe("stats", () => {
  it("counts recent matches, drops, searches, channels and reads the heartbeat", async () => {
    const now = new Date();
    const s1 = await insertSearch(db, "PS5");
    await insertSearch(db, "Aeron");
    const l1 = await insertListing(db);
    const l2 = await insertListing(db);
    const l3 = await insertListing(db);
    const l4 = await insertListing(db);
    await insertMatch(db, s1.id, l1.id, { lastEventAt: minutesAgo(now, 10) });
    await insertMatch(db, s1.id, l2.id, { lastEventAt: minutesAgo(now, 180) });
    await insertMatch(db, s1.id, l3.id, { lastEventAt: minutesAgo(now, 5), silent: true });
    const drop = await insertMatch(db, s1.id, l4.id, { lastEventAt: minutesAgo(now, 60 * 30) });
    await db.update(searchMatches).set({ lastEvent: "price_drop", lastEventAt: minutesAgo(now, 30) }).where(sql`${searchMatches.id} = ${drop.id}`);
    await db.insert(notificationChannels).values({ name: "ntfy", type: "ntfy", config: { topic: "x" } });
    await db.insert(appSettings).values({ key: "worker.heartbeat", value: { at: minutesAgo(now, 1).toISOString(), pid: 1, mode: "cron" } });

    const stats = await getFeedStats(db, { now, workerMode: "inline" });
    expect(stats).toMatchObject({
      newLastHour: 1,
      newLast24h: 2,
      priceDropsLast24h: 1,
      activeSearches: 2,
      totalSearches: 2,
      enabledChannels: 1,
    });
    expect(stats.worker).toMatchObject({ state: "live", beatSource: "cron" });
  });

  it("works on an empty database", async () => {
    const stats = await getFeedStats(db, { now: new Date(), workerMode: "external" });
    expect(stats).toMatchObject({ newLastHour: 0, newLast24h: 0, priceDropsLast24h: 0, activeSearches: 0, enabledChannels: 0 });
    expect(stats.worker).toEqual({ state: "off", mode: "external", lastBeatAt: null, beatSource: null });
  });
});

describe("worker heartbeat", () => {
  const now = new Date("2026-09-28T12:00:00Z");
  const updatedAt = new Date("2026-09-28T11:00:00Z");

  it("accepts ISO strings, epoch millis and objects with a timestamp field", () => {
    expect(parseWorkerHeartbeat("2026-09-28T11:59:00Z", null)?.toISOString()).toBe("2026-09-28T11:59:00.000Z");
    expect(parseWorkerHeartbeat(now.getTime(), null)).toEqual(now);
    expect(parseWorkerHeartbeat({ at: "2026-09-28T11:58:00Z", pid: 1 }, null)?.toISOString()).toBe("2026-09-28T11:58:00.000Z");
    expect(parseWorkerHeartbeat({ lastTickAt: now.toISOString() }, null)).toEqual(now);
    expect(parseWorkerHeartbeat({ nothing: true }, updatedAt)).toEqual(updatedAt);
    expect(parseWorkerHeartbeat("garbage", null)).toBeNull();
  });

  it("reads the heartbeat's source from its mode field", () => {
    expect(parseHeartbeatSource({ at: "x", mode: "external" })).toBe("external");
    expect(parseHeartbeatSource({ at: "x" })).toBeNull();
    expect(parseHeartbeatSource("2026-09-28T11:59:00Z")).toBeNull();
  });

  it("is live under two minutes, stalled after, off without a beat or when disabled", () => {
    expect(workerStatus(new Date(now.getTime() - 60_000), "inline", now).state).toBe("live");
    expect(workerStatus(new Date(now.getTime() - 5 * 60_000), "external", now).state).toBe("stalled");
    expect(workerStatus(new Date(now.getTime() - 5 * 60_000), "off", now).state).toBe("off");
    expect(workerStatus(null, "inline", now).state).toBe("off");
  });
});
