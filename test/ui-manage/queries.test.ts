import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type Db } from "@/lib/db";
import { appSettings, listings, marketplaceHealth, notificationChannels, scrapeRuns, searchMatches, searches } from "@/lib/db/schema";
import { DEFAULT_LOCATION, findPreset } from "@/lib/locations";
import {
  createSearch,
  deleteSearch,
  duplicateSearch,
  getSearch,
  listSearchesWithStats,
  parseSearchId,
  setSearchEnabled,
  updateSearch,
} from "@/lib/queries/searches";
import {
  DEFAULT_LOCATION_KEY,
  WORKER_HEARTBEAT_KEY,
  clearMarketplaceBackoff,
  createChannel,
  deleteChannel,
  getDefaultLocation,
  getWorkerHeartbeat,
  heartbeatStatus,
  listChannels,
  listRecentScrapeRuns,
  setChannelEnabled,
  setDefaultLocation,
  setSetting,
  updateChannel,
} from "@/lib/queries/settings";
import { searchInputSchema, type SearchInput } from "@/lib/search-schema";

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});

afterAll(async () => {
  await close();
});

beforeEach(async () => {
  // Children first; cascades would handle most of it but keep this explicit.
  for (const table of [searchMatches, scrapeRuns, listings, searches, notificationChannels, marketplaceHealth, appSettings]) {
    await db.delete(table);
  }
});

function input(overrides: Partial<SearchInput> = {}): SearchInput {
  return searchInputSchema.parse({
    name: "PS5",
    query: "ps5",
    marketplaces: ["craigslist"],
    location: DEFAULT_LOCATION,
    ...overrides,
  });
}

const NOW = new Date("2026-09-28T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

describe("search queries", () => {
  it("creates searches with normalized columns", async () => {
    const created = await createSearch(
      db,
      input({
        excludeTerms: ["Broken", "broken", "parts"],
        marketplaces: ["craigslist", "kijiji", "craigslist"],
        category: "any",
        notifyChannelIds: [],
        location: { ...DEFAULT_LOCATION, facebookLocation: " ", postalCode: "", countryCode: "ca" },
      }),
    );
    expect(created.excludeTerms).toEqual(["Broken", "parts"]);
    expect(created.marketplaces).toEqual(["craigslist", "kijiji"]);
    expect(created.category).toBeNull();
    expect(created.notifyChannelIds).toBeNull();
    expect(created.location.facebookLocation).toBeNull();
    expect(created.location.postalCode).toBeNull();
    expect(created.location.countryCode).toBe("CA");
    expect(created.nextRunAt).toBeNull();
    expect(await getSearch(db, created.id)).toEqual(created);
    expect(await getSearch(db, created.id + 1000)).toBeNull();
  });

  it("lists newest first with 24h (non-silent) and total match counts", async () => {
    const older = await createSearch(db, input({ name: "Older" }));
    const newer = await createSearch(db, input({ name: "Newer" }));
    await db
      .update(searches)
      .set({ createdAt: hoursAgo(48) })
      .where(eqId(older.id));

    const rows = await db
      .insert(listings)
      .values([1, 2, 3, 4].map((n) => ({ marketplace: "craigslist" as const, externalId: String(n), url: `https://x/${n}`, title: `L${n}` })))
      .returning();
    await db.insert(searchMatches).values([
      { searchId: older.id, listingId: rows[0].id, firstMatchedAt: hoursAgo(1) },
      { searchId: older.id, listingId: rows[1].id, firstMatchedAt: hoursAgo(2), silent: true },
      { searchId: older.id, listingId: rows[2].id, firstMatchedAt: hoursAgo(30) },
      { searchId: newer.id, listingId: rows[3].id, firstMatchedAt: hoursAgo(25) },
    ]);

    const list = await listSearchesWithStats(db, NOW);
    expect(list.map((s) => s.name)).toEqual(["Newer", "Older"]);
    expect(list[1]).toMatchObject({ recentMatches: 1, totalMatches: 3 });
    expect(list[0]).toMatchObject({ recentMatches: 0, totalMatches: 1 });
  });

  it("returns an empty list and zero counts when there is nothing", async () => {
    expect(await listSearchesWithStats(db, NOW)).toEqual([]);
    await createSearch(db, input());
    expect((await listSearchesWithStats(db, NOW))[0]).toMatchObject({ recentMatches: 0, totalMatches: 0 });
  });

  it("updates the definition, bumps updatedAt and clears nextRunAt", async () => {
    const created = await createSearch(db, input());
    await db
      .update(searches)
      .set({ nextRunAt: hoursAgo(-1), lastRunAt: hoursAgo(1) })
      .where(eqId(created.id));

    const updated = await updateSearch(
      db,
      created.id,
      input({ name: "PS5 Slim", maxPriceCents: 40_000, location: { ...findPreset("Toronto, ON")!, radiusKm: 10 } }),
      NOW,
    );
    expect(updated).toMatchObject({ name: "PS5 Slim", maxPriceCents: 40_000, nextRunAt: null, updatedAt: NOW });
    expect(updated?.location).toMatchObject({ label: "Toronto, ON", radiusKm: 10 });
    expect(updated?.lastRunAt).toEqual(hoursAgo(1));
    expect(await updateSearch(db, 999_999, input())).toBeNull();
  });

  it("pauses and resumes; resuming schedules a prompt run", async () => {
    const created = await createSearch(db, input());
    await db
      .update(searches)
      .set({ nextRunAt: hoursAgo(-2) })
      .where(eqId(created.id));

    expect(await setSearchEnabled(db, created.id, false, NOW)).toBe(true);
    expect(await getSearch(db, created.id)).toMatchObject({ enabled: false, nextRunAt: hoursAgo(-2) });
    expect(await setSearchEnabled(db, created.id, true, NOW)).toBe(true);
    expect(await getSearch(db, created.id)).toMatchObject({ enabled: true, nextRunAt: null });
    expect(await setSearchEnabled(db, 999_999, true)).toBe(false);
  });

  it("duplicates a search as a paused copy without run state", async () => {
    const created = await createSearch(db, input({ name: "x".repeat(80), excludeTerms: ["broken"], notifyChannelIds: [4] }));
    await db.update(searches).set({ lastRunAt: NOW, lastError: "boom" }).where(eqId(created.id));

    const copy = await duplicateSearch(db, created.id);
    expect(copy).not.toBeNull();
    expect(copy!.id).not.toBe(created.id);
    expect(copy!.name).toHaveLength(80);
    expect(copy!.name.endsWith(" (copy)")).toBe(true);
    expect(copy).toMatchObject({ enabled: false, lastRunAt: null, lastError: null, excludeTerms: ["broken"], notifyChannelIds: [4] });
    expect(await duplicateSearch(db, 999_999)).toBeNull();
  });

  it("deletes a search and cascades its matches and runs", async () => {
    const created = await createSearch(db, input());
    const [listing] = await db.insert(listings).values({ marketplace: "craigslist", externalId: "1", url: "https://x", title: "PS5" }).returning();
    await db.insert(searchMatches).values({ searchId: created.id, listingId: listing.id });
    await db.insert(scrapeRuns).values({ searchId: created.id, marketplace: "craigslist" });

    expect(await deleteSearch(db, created.id)).toBe(true);
    expect(await deleteSearch(db, created.id)).toBe(false);
    expect(await db.select().from(searchMatches)).toEqual([]);
    expect(await db.select().from(scrapeRuns)).toEqual([]);
    expect(await db.select().from(listings)).toHaveLength(1);
  });

  it("parses ids from route params", () => {
    expect(parseSearchId("12")).toBe(12);
    for (const bad of ["0", "-1", "1.5", "abc", "", "9999999999", undefined, null]) expect(parseSearchId(bad)).toBeNull();
  });
});

describe("settings queries", () => {
  it("falls back to DEFAULT_LOCATION until a valid default is saved", async () => {
    expect(await getDefaultLocation(db)).toEqual(DEFAULT_LOCATION);
    await setSetting(db, DEFAULT_LOCATION_KEY, { label: "broken" });
    expect(await getDefaultLocation(db)).toEqual(DEFAULT_LOCATION);

    const toronto = { ...findPreset("Toronto, ON")!, radiusKm: 25 };
    await setDefaultLocation(db, toronto);
    expect(await getDefaultLocation(db)).toEqual(toronto);
    // Upsert, not a second row.
    await setDefaultLocation(db, { ...toronto, radiusKm: 30 });
    expect((await getDefaultLocation(db)).radiusKm).toBe(30);
    expect(await db.select().from(appSettings)).toHaveLength(1);
  });

  it("rejects invalid default locations", async () => {
    await expect(setDefaultLocation(db, { ...DEFAULT_LOCATION, radiusKm: 0 })).rejects.toThrow();
  });

  it("reads the worker heartbeat and classifies it", async () => {
    expect(await getWorkerHeartbeat(db)).toBeNull();
    expect(heartbeatStatus(null, "inline", NOW)).toBe("none");
    expect(heartbeatStatus(null, "off", NOW)).toBe("off");

    await setSetting(db, WORKER_HEARTBEAT_KEY, { at: new Date(NOW.getTime() - 30_000).toISOString(), pid: 42, mode: "inline" });
    const heartbeat = await getWorkerHeartbeat(db);
    expect(heartbeat).toMatchObject({ pid: 42, mode: "inline" });
    expect(heartbeatStatus(heartbeat, "inline", NOW)).toBe("live");
    const later = new Date(NOW.getTime() + 5 * 60_000);
    expect(heartbeatStatus(heartbeat, "inline", later)).toBe("stalled");
    expect(heartbeatStatus(heartbeat, "external", later)).toBe("stalled");
    // WORKER_MODE=off: an old beat (e.g. written by db:seed, or before polling was switched off) is not a stalled worker…
    expect(heartbeatStatus(heartbeat, "off", later)).toBe("off");
    // …but a fresh one means something (cron, an external worker) is polling.
    expect(heartbeatStatus(heartbeat, "off", NOW)).toBe("live");

    await setSetting(db, WORKER_HEARTBEAT_KEY, { at: "not a date" });
    expect(await getWorkerHeartbeat(db)).toBeNull();
  });

  it("creates, updates, toggles and deletes channels", async () => {
    const created = await createChannel(db, { name: "Phone", type: "ntfy", config: { topic: "abc" } });
    expect(created).toMatchObject({ enabled: true, config: { topic: "abc" } });
    await db.update(notificationChannels).set({ lastError: "old failure" });

    const updated = await updateChannel(db, created.id, { name: "My phone", config: { topic: "def" } });
    expect(updated).toMatchObject({ name: "My phone", type: "ntfy", config: { topic: "def" }, lastError: null });
    expect(await updateChannel(db, 999_999, { name: "x", config: {} })).toBeNull();

    expect(await setChannelEnabled(db, created.id, false)).toBe(true);
    expect((await listChannels(db))[0].enabled).toBe(false);
    expect(await deleteChannel(db, created.id)).toBe(true);
    expect(await deleteChannel(db, created.id)).toBe(false);
    expect(await listChannels(db)).toEqual([]);
  });

  it("removes a deleted channel from searches that selected it", async () => {
    const [a, b] = await Promise.all([
      createChannel(db, { name: "A", type: "ntfy", config: { topic: "a" } }),
      createChannel(db, { name: "B", type: "ntfy", config: { topic: "b" } }),
    ]);
    const onlyA = await createSearch(db, input({ name: "only A", notifyChannelIds: [a.id] }));
    const both = await createSearch(db, input({ name: "both", notifyChannelIds: [a.id, b.id] }));
    const all = await createSearch(db, input({ name: "all" }));

    expect(await deleteChannel(db, a.id)).toBe(true);
    expect((await getSearch(db, onlyA.id))?.notifyChannelIds).toBeNull();
    expect((await getSearch(db, both.id))?.notifyChannelIds).toEqual([b.id]);
    expect((await getSearch(db, all.id))?.notifyChannelIds).toBeNull();
  });

  it("clears marketplace backoff", async () => {
    await db.insert(marketplaceHealth).values([
      { marketplace: "kijiji", consecutiveFailures: 4, backoffUntil: hoursAgo(-1), lastError: "403" },
      { marketplace: "ebay", consecutiveFailures: 2, backoffUntil: hoursAgo(-1) },
    ]);
    await clearMarketplaceBackoff(db, "kijiji");
    const rows = await db.select().from(marketplaceHealth);
    expect(rows.find((r) => r.marketplace === "kijiji")).toMatchObject({ consecutiveFailures: 0, backoffUntil: null, lastError: "403" });
    expect(rows.find((r) => r.marketplace === "ebay")).toMatchObject({ consecutiveFailures: 2 });
  });

  it("lists recent scrape runs newest first with search names", async () => {
    const search = await createSearch(db, input({ name: "Bikes" }));
    await db.insert(scrapeRuns).values([
      { searchId: search.id, marketplace: "craigslist", startedAt: hoursAgo(3), resultCount: 5 },
      { searchId: search.id, marketplace: "kijiji", startedAt: hoursAgo(1), error: "Blocked (403)" },
      { searchId: null, marketplace: "ebay", startedAt: hoursAgo(2) },
    ]);
    const runs = await listRecentScrapeRuns(db, 2);
    expect(runs.map((r) => [r.marketplace, r.searchName])).toEqual([
      ["kijiji", "Bikes"],
      ["ebay", null],
    ]);
    expect(runs[0].error).toBe("Blocked (403)");
  });
});

function eqId(id: number) {
  return eq(searches.id, id);
}
