import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type Db } from "@/lib/db";
import { marketplaceHealth, scrapeRuns, searchMatches } from "@/lib/db/schema";
import { LOCATION_PRESETS } from "@/lib/locations";
import { BlockedError, NotConfiguredError, RateLimitedError, type MarketplaceAdapter } from "@/lib/marketplaces/types";
import { notifyMatchEvents } from "@/lib/notify";
import type { MarketplaceId } from "@/lib/types";
import { MarketplaceGate } from "../gate";
import { recordMarketplaceFailure } from "../marketplace-health";
import { runSearch } from "../runner";
import { tick } from "../scheduler";
import type { RunSearchOptions } from "../types";
import { NOW, fakeAdapter, getSearch, insertSearch, isNear, minutesAfter, noWaitGate, resetDb, scraped } from "./helpers";

vi.mock("@/lib/notify", () => ({ notifyMatchEvents: vi.fn(async () => {}) }));
vi.mock("@/lib/ai", () => ({ aiStatus: () => ({ configured: false, model: "" }), evaluateListing: vi.fn() }));

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});

beforeEach(async () => {
  await resetDb(db);
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => close());

function run(searchId: number, adapters: Partial<Record<MarketplaceId, MarketplaceAdapter>>, opts: RunSearchOptions = {}) {
  return runSearch(db, searchId, { adapters, gate: noWaitGate(), now: NOW, ...opts });
}

async function healthOf(marketplace: MarketplaceId) {
  const [row] = await db.select().from(marketplaceHealth).where(eq(marketplaceHealth.marketplace, marketplace));
  return row;
}

describe("runSearch marketplace failures", () => {
  it("isolates a failing marketplace, records the error and backs off", async () => {
    const cl = fakeAdapter("craigslist", {
      results: () => {
        throw new RateLimitedError("Rate limited (429) by craigslist", "craigslist", 120);
      },
    });
    const kj = fakeAdapter("kijiji", { results: [scraped("kijiji", "k1")] });
    const search = await insertSearch(db, { marketplaces: ["craigslist", "kijiji"] });

    const result = await run(search.id, { craigslist: cl, kijiji: kj });

    expect(result.marketplaces).toEqual([
      expect.objectContaining({ marketplace: "craigslist", error: "Rate limited (429) by craigslist", resultCount: 0 }),
      expect.objectContaining({ marketplace: "kijiji", newCount: 1 }),
    ]);
    expect(result.events).toHaveLength(1);

    const health = await healthOf("craigslist");
    expect(health.consecutiveFailures).toBe(1);
    expect(health.lastError).toBe("Rate limited (429) by craigslist");
    expect(isNear(health.backoffUntil, new Date(NOW.getTime() + 120_000))).toBe(true);
    expect(isNear(health.lastErrorAt, NOW)).toBe(true);
    expect((await healthOf("kijiji")).consecutiveFailures).toBe(0);

    const runs = await db.select().from(scrapeRuns);
    expect(runs.map((r) => [r.marketplace, r.error])).toEqual(
      expect.arrayContaining([
        ["craigslist", "Rate limited (429) by craigslist"],
        ["kijiji", null],
      ]),
    );
    expect((await getSearch(db, search.id)).lastError).toBe("craigslist: Rate limited (429) by craigslist");
  });

  it("skips a marketplace in backoff unless forced, and resets health after a success", async () => {
    const cl = fakeAdapter("craigslist", {
      results: () => {
        throw new BlockedError("Blocked (403) by craigslist", "craigslist");
      },
    });
    const search = await insertSearch(db);
    await run(search.id, { craigslist: cl });
    expect(cl.calls).toHaveLength(1);

    const skipped = await run(search.id, { craigslist: cl }, { now: minutesAfter(NOW, 5) });
    expect(cl.calls).toHaveLength(1);
    expect(skipped.marketplaces[0].skipped).toMatch(/^Backing off until .*Blocked \(403\)/);
    expect(await db.select().from(scrapeRuns)).toHaveLength(1);
    expect((await getSearch(db, search.id)).lastError).toMatch(/^craigslist: Backing off until/);

    // A forced run failing inside the backoff window is the same outage: counted once, the window
    // only extends to 15 min after the latest failure.
    await run(search.id, { craigslist: cl }, { now: minutesAfter(NOW, 6), force: true });
    expect(cl.calls).toHaveLength(2);
    const twice = await healthOf("craigslist");
    expect(twice.consecutiveFailures).toBe(1);
    expect(isNear(twice.backoffUntil, minutesAfter(NOW, 6 + 15))).toBe(true);

    // Failing again once the window is over escalates.
    await run(search.id, { craigslist: cl }, { now: minutesAfter(NOW, 22) });
    expect(cl.calls).toHaveLength(3);
    const escalated = await healthOf("craigslist");
    expect(escalated.consecutiveFailures).toBe(2);
    expect(isNear(escalated.backoffUntil, minutesAfter(NOW, 22 + 30))).toBe(true);

    cl.setResults([scraped("craigslist", "1")]);
    const recovered = await run(search.id, { craigslist: cl }, { now: minutesAfter(NOW, 60) });
    expect(recovered.marketplaces[0].error).toBeUndefined();
    const health = await healthOf("craigslist");
    expect(health).toMatchObject({ consecutiveFailures: 0, backoffUntil: null, lastError: "Blocked (403) by craigslist" });
    expect(isNear(health.lastSuccessAt, minutesAfter(NOW, 60))).toBe(true);
    // The first *successful* run is still the silent baseline.
    expect(recovered.events).toEqual([expect.objectContaining({ silent: true })]);
    expect((await getSearch(db, search.id)).lastError).toBeNull();
  });

  it("counts one blocked moment once, even when several searches hit it in the same tick", async () => {
    const cl = fakeAdapter("craigslist", {
      results: () => {
        throw new BlockedError("Blocked (403) by craigslist", "craigslist");
      },
    });
    for (const name of ["a", "b", "c"]) await insertSearch(db, { name, query: name });
    // The gate spaces requests to one marketplace, so the searches reach it one after another.
    const result = await tick(db, { now: NOW, adapters: { craigslist: cl }, gate: new MarketplaceGate({ minSpacingMs: 200, jitterMs: 0 }) });

    expect(result.ranSearchIds).toHaveLength(3);
    const health = await healthOf("craigslist");
    const minutes = Math.round((health.backoffUntil!.getTime() - NOW.getTime()) / 60_000);
    expect({ failures: health.consecutiveFailures, minutes }).toEqual({ failures: 1, minutes: 15 });
    // Searches that reached the gate after the block were skipped instead of asking again.
    expect(cl.calls).toHaveLength(1);
    expect(await db.select().from(scrapeRuns)).toHaveLength(1);
  });

  it("counts concurrent failures once", async () => {
    const err = new BlockedError("Blocked (403) by craigslist", "craigslist");
    const states = await Promise.all([1, 2, 3].map(() => recordMarketplaceFailure(db, "craigslist", err, NOW)));
    expect(states.map((s) => s.consecutiveFailures)).toEqual([1, 1, 1]);
    expect(await healthOf("craigslist")).toMatchObject({ consecutiveFailures: 1, backoffUntil: minutesAfter(NOW, 15) });
  });

  it("records configuration errors without backing off", async () => {
    const eb = fakeAdapter("ebay", {
      results: () => {
        throw new NotConfiguredError("eBay credentials rejected", "ebay");
      },
    });
    const search = await insertSearch(db, { marketplaces: ["ebay"] });
    await run(search.id, { ebay: eb });
    expect(await healthOf("ebay")).toMatchObject({ consecutiveFailures: 1, backoffUntil: null, lastError: "eBay credentials rejected" });
    await run(search.id, { ebay: eb }, { now: minutesAfter(NOW, 1) });
    expect(eb.calls).toHaveLength(2);
  });

  it("times out a hanging adapter and aborts its signal", async () => {
    let signal: AbortSignal | undefined;
    const cl = fakeAdapter("craigslist", {
      results: (_q, ctx) => {
        signal = ctx.signal;
        return new Promise(() => {});
      },
    });
    const search = await insertSearch(db);
    const result = await run(search.id, { craigslist: cl }, { timeoutMs: 30 });
    expect(result.marketplaces[0].error).toBe("Timed out after 30 ms");
    expect(signal?.aborted).toBe(true);
    const health = await healthOf("craigslist");
    expect(health.consecutiveFailures).toBe(1);
    expect(isNear(health.backoffUntil, new Date(NOW.getTime() + 60_000))).toBe(true);
  });

  it("rejects adapters that return something other than an array", async () => {
    const cl = fakeAdapter("craigslist", { results: () => ({ nope: true }) as never });
    const search = await insertSearch(db);
    const result = await run(search.id, { craigslist: cl });
    expect(result.marketplaces[0].error).toMatch(/invalid result/);
  });

  it("treats cancellation (shutdown) as skipped, not as a marketplace failure", async () => {
    const controller = new AbortController();
    const cl = fakeAdapter("craigslist", {
      results: () => {
        controller.abort();
        return new Promise(() => {});
      },
    });
    const search = await insertSearch(db);
    const result = await run(search.id, { craigslist: cl }, { signal: controller.signal });
    expect(result.marketplaces[0].skipped).toBe("Cancelled");
    expect(await healthOf("craigslist")).toBeUndefined();
    expect(await db.select().from(scrapeRuns)).toHaveLength(0);
  });
});

describe("runSearch skipped marketplaces", () => {
  it("skips adapters that are not configured and those that don't serve the country", async () => {
    const eb = fakeAdapter("ebay", { status: { ok: false, message: "Set EBAY_CLIENT_ID and EBAY_CLIENT_SECRET" } });
    const kj = fakeAdapter("kijiji", { countries: ["CA"] });
    const cl = fakeAdapter("craigslist", { results: [scraped("craigslist", "1")] });
    const seattle = LOCATION_PRESETS.find((p) => p.label === "Seattle, WA")!;
    const search = await insertSearch(db, { marketplaces: ["ebay", "kijiji", "craigslist"], location: seattle });

    const result = await run(search.id, { ebay: eb, kijiji: kj, craigslist: cl });

    expect(result.marketplaces.map((m) => [m.marketplace, m.skipped])).toEqual([
      ["ebay", "Set EBAY_CLIENT_ID and EBAY_CLIENT_SECRET"],
      ["kijiji", "Fake kijiji does not serve US"],
      ["craigslist", undefined],
    ]);
    expect(eb.calls).toHaveLength(0);
    expect(kj.calls).toHaveLength(0);
    expect(await db.select().from(scrapeRuns)).toHaveLength(1);
    // Something was queried successfully, so skips are not reported as the search's error.
    expect((await getSearch(db, search.id)).lastError).toBeNull();
  });

  it("reports skip reasons as the search error when nothing could be queried", async () => {
    const eb = fakeAdapter("ebay", { status: { ok: false, message: "Not configured" } });
    const search = await insertSearch(db, { marketplaces: ["ebay", "ebay", "not-a-marketplace"] as never });
    const result = await run(search.id, { ebay: eb });
    expect(result.marketplaces).toHaveLength(1);
    expect((await getSearch(db, search.id)).lastError).toBe("ebay: Not configured");
    expect(await db.select().from(searchMatches)).toHaveLength(0);
    expect(notifyMatchEvents).not.toHaveBeenCalled();
  });

  it("survives an adapter whose status() throws", async () => {
    const broken = fakeAdapter("offerup");
    broken.status = () => {
      throw new Error("kaboom");
    };
    const search = await insertSearch(db, { marketplaces: ["offerup"], location: LOCATION_PRESETS.find((p) => p.countryCode === "US")! });
    const result = await run(search.id, { offerup: broken });
    expect(result.marketplaces[0].skipped).toBe("Fake offerup status check failed: kaboom");
  });
});
