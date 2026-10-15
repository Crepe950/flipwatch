import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type Db } from "@/lib/db";
import { deals, listings, marketplaceHealth, notificationChannels, notificationLog, priceHistory, scrapeRuns, searchMatches } from "@/lib/db/schema";
import { isAuthorizedCronRequest } from "../cron-auth";
import { getHealthSummary } from "../health";
import { writeHeartbeat } from "../heartbeat";
import { runRetention, runRetentionIfDue } from "../retention";
import { NOW, fakeAdapter, insertSearch, minutesAfter, resetDb } from "./helpers";

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});

beforeEach(() => resetDb(db));

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(() => close());

const daysAgo = (days: number) => minutesAfter(NOW, -days * 24 * 60);

async function addListing(externalId: string, lastSeenDaysAgo: number) {
  const [row] = await db
    .insert(listings)
    .values({
      marketplace: "craigslist",
      externalId,
      url: `https://x/${externalId}`,
      title: externalId,
      firstSeenAt: daysAgo(lastSeenDaysAgo + 1),
      lastSeenAt: daysAgo(lastSeenDaysAgo),
    })
    .returning();
  await db.insert(priceHistory).values({ listingId: row.id, priceCents: 100, observedAt: daysAgo(lastSeenDaysAgo) });
  return row;
}

describe("retention", () => {
  it("deletes old runs, old notification logs and stale unmatched listings only", async () => {
    const search = await insertSearch(db);
    await db.insert(scrapeRuns).values([
      { searchId: search.id, marketplace: "craigslist", startedAt: daysAgo(8) },
      { searchId: search.id, marketplace: "craigslist", startedAt: daysAgo(6) },
    ]);

    const oldOrphan = await addListing("old-orphan", 22);
    const oldMatched = await addListing("old-matched", 30);
    const oldDeal = await addListing("old-deal", 30);
    const recentOrphan = await addListing("recent-orphan", 5);
    const [match] = await db.insert(searchMatches).values({ searchId: search.id, listingId: oldMatched.id }).returning();
    await db.insert(deals).values({ listingId: oldDeal.id });

    const [channel] = await db.insert(notificationChannels).values({ name: "ntfy", type: "ntfy" }).returning();
    await db.insert(notificationLog).values([
      { channelId: channel.id, matchId: match.id, status: "sent", createdAt: daysAgo(31) },
      { channelId: channel.id, matchId: match.id, status: "sent", createdAt: daysAgo(29) },
    ]);

    const result = await runRetention(db, NOW);

    expect(result).toEqual({ scrapeRuns: 1, notificationLog: 1, listings: 1 });
    const remaining = (await db.select({ id: listings.id }).from(listings)).map((r) => r.id).sort();
    expect(remaining).toEqual([oldMatched.id, oldDeal.id, recentOrphan.id].sort());
    expect(remaining).not.toContain(oldOrphan.id);
    // Price history of the deleted listing went with it.
    expect(await db.select().from(priceHistory)).toHaveLength(3);
  });

  it("runs at most once a day", async () => {
    await db.insert(scrapeRuns).values({ marketplace: "craigslist", startedAt: daysAgo(10) });
    expect(await runRetentionIfDue(db, NOW)).toEqual({ scrapeRuns: 1, notificationLog: 0, listings: 0 });
    await db.insert(scrapeRuns).values({ marketplace: "craigslist", startedAt: daysAgo(10) });
    expect(await runRetentionIfDue(db, minutesAfter(NOW, 60))).toBeNull();
    expect(await runRetentionIfDue(db, minutesAfter(NOW, 25 * 60))).toEqual({ scrapeRuns: 1, notificationLog: 0, listings: 0 });
  });
});

describe("getHealthSummary", () => {
  const adapters = [fakeAdapter("craigslist"), fakeAdapter("ebay", { status: { ok: false, message: "Missing credentials" } })];

  it("reports worker liveness, marketplace health and search counts", async () => {
    vi.stubEnv("WORKER_MODE", "external");
    await writeHeartbeat(db, { mode: "external", now: minutesAfter(NOW, -1) });
    await db.insert(marketplaceHealth).values({
      marketplace: "craigslist",
      consecutiveFailures: 2,
      backoffUntil: minutesAfter(NOW, 10),
      lastError: "HTTP 500 from craigslist for https://vancouver.craigslist.org/search/sss?query=secret+thing",
      lastErrorAt: minutesAfter(NOW, -2),
    });
    await insertSearch(db);
    await insertSearch(db, { enabled: false });

    const summary = await getHealthSummary(db, { now: NOW, adapters });

    expect(summary).toMatchObject({
      ok: true,
      workerMode: "external",
      heartbeatAgeSec: 60,
      heartbeatMode: "external",
      searches: { enabled: 1, total: 2 },
    });
    expect(summary.marketplaces).toEqual([
      {
        marketplace: "craigslist",
        displayName: "Fake craigslist",
        available: true,
        statusMessage: null,
        consecutiveFailures: 2,
        backoffUntil: minutesAfter(NOW, 10).toISOString(),
        lastSuccessAt: null,
        lastError: "HTTP 500 from craigslist for <url>",
        lastErrorAt: minutesAfter(NOW, -2).toISOString(),
      },
      expect.objectContaining({ marketplace: "ebay", available: false, statusMessage: "Missing credentials", consecutiveFailures: 0 }),
    ]);
    expect(JSON.stringify(summary)).not.toContain("secret");
  });

  it("is not ok when the poller's heartbeat is missing or stale", async () => {
    vi.stubEnv("WORKER_MODE", "inline");
    expect((await getHealthSummary(db, { now: NOW, adapters })).ok).toBe(false);
    await writeHeartbeat(db, { mode: "inline", now: minutesAfter(NOW, -10) });
    const stale = await getHealthSummary(db, { now: NOW, adapters });
    expect(stale).toMatchObject({ ok: false, heartbeatAgeSec: 600 });
  });

  it("does not require a heartbeat when polling is off", async () => {
    vi.stubEnv("WORKER_MODE", "off");
    expect(await getHealthSummary(db, { now: NOW, adapters })).toMatchObject({ ok: true, heartbeatAt: null, searches: { enabled: 0, total: 0 } });
  });
});

describe("isAuthorizedCronRequest", () => {
  it("accepts only the exact bearer secret", () => {
    expect(isAuthorizedCronRequest("Bearer s3cret", "s3cret")).toBe(true);
    expect(isAuthorizedCronRequest("bearer   s3cret ", "s3cret")).toBe(true);
    expect(isAuthorizedCronRequest("Bearer s3cret2", "s3cret")).toBe(false);
    expect(isAuthorizedCronRequest("Bearer s3cre", "s3cret")).toBe(false);
    expect(isAuthorizedCronRequest("s3cret", "s3cret")).toBe(false);
    expect(isAuthorizedCronRequest("Basic s3cret", "s3cret")).toBe(false);
    expect(isAuthorizedCronRequest(null, "s3cret")).toBe(false);
  });

  it("rejects everything when no secret is configured", () => {
    expect(isAuthorizedCronRequest("Bearer ", "")).toBe(false);
    expect(isAuthorizedCronRequest("Bearer undefined", undefined)).toBe(false);
  });
});
