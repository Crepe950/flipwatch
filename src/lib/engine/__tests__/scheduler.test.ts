import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type Db } from "@/lib/db";
import { scrapeRuns, searches } from "@/lib/db/schema";
import { readHeartbeat } from "../heartbeat";
import { ebayQuotaFloorSec } from "../ebay-quota";
import {
  CLAIM_LEASE_SEC,
  claimDueSearches,
  effectiveIntervalSec,
  loadEbayQuotaFloorSec,
  startScheduler,
  tick,
  withJitter,
} from "../scheduler";
import { NOW, fakeAdapter, getSearch, insertSearch, isNear, minutesAfter, noWaitGate, resetDb, scraped, waitFor } from "./helpers";

vi.mock("@/lib/notify", () => ({ notifyMatchEvents: vi.fn(async () => {}) }));
vi.mock("@/lib/ai", () => ({ aiStatus: () => ({ configured: false, model: "" }), evaluateListing: vi.fn() }));

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});

beforeEach(async () => {
  await resetDb(db);
  vi.stubEnv("MIN_POLL_INTERVAL_SEC", "30");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(() => close());

describe("effectiveIntervalSec", () => {
  it("takes the max of the search interval, the global floor and adapter floors", () => {
    const adapters = { craigslist: fakeAdapter("craigslist", { minIntervalSec: 60 }), facebook: fakeAdapter("facebook", { minIntervalSec: 90 }) };
    expect(effectiveIntervalSec({ pollIntervalSec: 120, marketplaces: ["craigslist"] }, adapters)).toBe(120);
    expect(effectiveIntervalSec({ pollIntervalSec: 30, marketplaces: ["craigslist"] }, adapters)).toBe(60);
    expect(effectiveIntervalSec({ pollIntervalSec: 30, marketplaces: ["craigslist", "facebook"] }, adapters)).toBe(90);
    vi.stubEnv("MIN_POLL_INTERVAL_SEC", "300");
    expect(effectiveIntervalSec({ pollIntervalSec: 30, marketplaces: ["craigslist"] }, adapters)).toBe(300);
  });

  it("applies the eBay quota floor only to searches that include eBay", () => {
    const adapters = { craigslist: fakeAdapter("craigslist", { minIntervalSec: 60 }), ebay: fakeAdapter("ebay", { minIntervalSec: 60 }) };
    const floors = { ebayQuotaSec: 960 };
    expect(effectiveIntervalSec({ pollIntervalSec: 120, marketplaces: ["craigslist", "ebay"] }, adapters, floors)).toBe(960);
    expect(effectiveIntervalSec({ pollIntervalSec: 1_800, marketplaces: ["ebay"] }, adapters, floors)).toBe(1_800);
    expect(effectiveIntervalSec({ pollIntervalSec: 120, marketplaces: ["craigslist"] }, adapters, floors)).toBe(120);
  });

  it("jitters by ±10 %", () => {
    expect(withJitter(100, () => 0)).toBe(90);
    expect(withJitter(100, () => 0.5)).toBe(100);
    expect(withJitter(100, () => 0.999999)).toBeCloseTo(110, 3);
  });
});

describe("eBay quota floor", () => {
  it("spreads 4,500 calls a day over the enabled eBay searches", () => {
    expect(ebayQuotaFloorSec(0)).toBe(0);
    expect(ebayQuotaFloorSec(1)).toBe(20);
    expect(ebayQuotaFloorSec(10)).toBe(192);
    expect(ebayQuotaFloorSec(50)).toBe(960);
  });

  it("counts enabled searches that include eBay and stretches their claims", async () => {
    const adapters = { craigslist: fakeAdapter("craigslist", { minIntervalSec: 60 }), ebay: fakeAdapter("ebay", { minIntervalSec: 60 }) };
    for (let i = 0; i < 30; i++) await insertSearch(db, { name: `eb${i}`, marketplaces: ["ebay"], nextRunAt: minutesAfter(NOW, 5) });
    await insertSearch(db, { name: "paused", marketplaces: ["craigslist", "ebay"], enabled: false });
    const clOnly = await insertSearch(db, { name: "cl", marketplaces: ["craigslist"] });
    const both = await insertSearch(db, { name: "both", marketplaces: ["craigslist", "ebay"] });

    // 31 enabled eBay searches → ceil(86,400 × 31 / 4,500) = 596 s.
    expect(await loadEbayQuotaFloorSec(db)).toBe(596);
    vi.spyOn(Math, "random").mockReturnValue(0.5); // no jitter
    const claims = await claimDueSearches(db, NOW, { adapters });
    expect(claims.map((c) => [c.searchId, Math.round(c.intervalSec)])).toEqual([
      [clOnly.id, 120],
      [both.id, 596],
    ]);
  });

  it("doesn't slow searches down while eBay isn't configured", async () => {
    const adapters = { ebay: fakeAdapter("ebay", { minIntervalSec: 60, status: { ok: false, message: "Missing credentials" } }) };
    for (let i = 0; i < 30; i++) await insertSearch(db, { name: `eb${i}`, marketplaces: ["ebay"] });
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const claims = await claimDueSearches(db, NOW, { adapters, limit: 1 });
    expect(Math.round(claims[0].intervalSec)).toBe(120);
  });
});

describe("claimDueSearches", () => {
  it("claims enabled searches that are due or never ran, and leases them", async () => {
    const never = await insertSearch(db, { name: "never" });
    const due = await insertSearch(db, { name: "due", nextRunAt: minutesAfter(NOW, -1) });
    await insertSearch(db, { name: "future", nextRunAt: minutesAfter(NOW, 1) });
    await insertSearch(db, { name: "disabled", enabled: false });

    const claims = await claimDueSearches(db, NOW);

    expect(claims.map((c) => c.searchId)).toEqual([never.id, due.id]);
    for (const claim of claims) {
      expect(claim.leaseUntil.getTime()).toBe(NOW.getTime() + CLAIM_LEASE_SEC * 1000);
      expect((await getSearch(db, claim.searchId)).nextRunAt).toEqual(claim.leaseUntil);
    }
    // Claimed searches are no longer due.
    expect(await claimDueSearches(db, NOW)).toEqual([]);
  });

  it("respects the limit, oldest first", async () => {
    const a = await insertSearch(db, { nextRunAt: minutesAfter(NOW, -10) });
    const b = await insertSearch(db, { nextRunAt: minutesAfter(NOW, -20) });
    await insertSearch(db, { nextRunAt: minutesAfter(NOW, -5) });
    const claims = await claimDueSearches(db, NOW, { limit: 2 });
    expect(claims.map((c) => c.searchId)).toEqual([b.id, a.id]);
  });

  it("lets exactly one of several concurrent claimers win each search", async () => {
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push((await insertSearch(db, { name: `s${i}` })).id);
    const results = await Promise.all([claimDueSearches(db, NOW), claimDueSearches(db, NOW), claimDueSearches(db, NOW)]);
    const claimed = results.flat().map((c) => c.searchId);
    expect(claimed.sort()).toEqual([...ids].sort());
  });
});

describe("tick", () => {
  it("runs due searches once each even when two ticks race", async () => {
    const perSearch = new Map<string, number>();
    const cl = fakeAdapter("craigslist", {
      results: async (query) => {
        perSearch.set(query.keywords, (perSearch.get(query.keywords) ?? 0) + 1);
        await new Promise((r) => setTimeout(r, 20));
        return [scraped("craigslist", query.keywords)];
      },
    });
    const ids = [];
    for (const q of ["alpha", "bravo", "charlie", "delta"]) ids.push((await insertSearch(db, { name: q, query: q })).id);

    const opts = { now: NOW, adapters: { craigslist: cl }, gate: noWaitGate() };
    const [a, b] = await Promise.all([tick(db, opts), tick(db, opts)]);

    const ran = [...a.ranSearchIds, ...b.ranSearchIds];
    expect(ran.sort()).toEqual([...ids].sort());
    expect(new Set(ran).size).toBe(ran.length);
    expect([...perSearch.values()]).toEqual([1, 1, 1, 1]);
    expect(a.errors).toEqual([]);
    expect(b.errors).toEqual([]);
    expect(await db.select().from(scrapeRuns)).toHaveLength(4);
  });

  it("reschedules each search one (jittered) interval after it finishes", async () => {
    const cl = fakeAdapter("craigslist", { minIntervalSec: 60, results: [] });
    const search = await insertSearch(db, { pollIntervalSec: 600 });
    await tick(db, { now: NOW, adapters: { craigslist: cl }, gate: noWaitGate() });

    const { nextRunAt, lastRunAt } = await getSearch(db, search.id);
    expect(isNear(lastRunAt, NOW)).toBe(true);
    const delaySec = (nextRunAt!.getTime() - NOW.getTime()) / 1000;
    expect(delaySec).toBeGreaterThanOrEqual(540);
    expect(delaySec).toBeLessThanOrEqual(661);

    // Not due again until then.
    const again = await tick(db, { now: minutesAfter(NOW, 5), adapters: { craigslist: cl }, gate: noWaitGate() });
    expect(again.ranSearchIds).toEqual([]);
    const later = await tick(db, { now: minutesAfter(NOW, 12), adapters: { craigslist: cl }, gate: noWaitGate() });
    expect(later.ranSearchIds).toEqual([search.id]);
  });

  it("does not clobber a next_run_at changed while the search was running", async () => {
    let searchId = 0;
    const cl = fakeAdapter("craigslist", {
      results: async () => {
        // e.g. the user edited the search and the UI reset it to "run asap"
        await db.update(searches).set({ nextRunAt: null }).where(eq(searches.id, searchId));
        return [];
      },
    });
    searchId = (await insertSearch(db)).id;
    await tick(db, { now: NOW, adapters: { craigslist: cl }, gate: noWaitGate() });
    expect((await getSearch(db, searchId)).nextRunAt).toBeNull();
  });

  it("collects errors per search and keeps going", async () => {
    const cl = fakeAdapter("craigslist", { results: [] });
    const ok = await insertSearch(db);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // A search whose row vanishes between claim and run makes runSearch throw.
    const gone = await insertSearch(db, { name: "gone" });
    const originalSearch = cl.search.bind(cl);
    cl.search = async (q, ctx) => {
      await db.delete(searches).where(eq(searches.id, gone.id));
      return originalSearch(q, ctx);
    };
    const result = await tick(db, { now: NOW, adapters: { craigslist: cl }, gate: noWaitGate(), concurrency: 1 });
    expect(result.ranSearchIds).toContain(ok.id);
    expect(result.errors).toEqual([{ searchId: gone.id, error: `Search ${gone.id} not found` }]);
    expect(errorSpy).toHaveBeenCalled();
  });

  it("does nothing when already cancelled and hands back unstarted claims", async () => {
    const cl = fakeAdapter("craigslist", { results: [] });
    const search = await insertSearch(db);
    const controller = new AbortController();
    controller.abort();
    expect(await tick(db, { now: NOW, adapters: { craigslist: cl }, signal: controller.signal })).toEqual({ ranSearchIds: [], errors: [] });
    expect((await getSearch(db, search.id)).nextRunAt).toBeNull();
    expect(cl.calls).toHaveLength(0);
  });
});

describe("startScheduler", () => {
  it("is a per-process singleton that ticks, beats and stops cleanly", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const cl = fakeAdapter("craigslist", { results: [scraped("craigslist", "1")] });
    const search = await insertSearch(db);
    const getDb = vi.fn(async () => db);

    const scheduler = startScheduler(getDb, {
      mode: "external",
      tickMs: 50,
      initialDelayMs: 0,
      tickOptions: { adapters: { craigslist: cl }, gate: noWaitGate() },
    });
    expect(startScheduler(getDb)).toBe(scheduler);

    await waitFor(async () => (await getSearch(db, search.id)).lastRunAt !== null);
    const heartbeat = await readHeartbeat(db);
    expect(heartbeat).toMatchObject({ pid: process.pid, mode: "external" });
    expect(Math.abs(Date.parse(heartbeat!.at) - Date.now())).toBeLessThan(10_000);

    await scheduler.stop();
    const calls = getDb.mock.calls.length;
    await new Promise((r) => setTimeout(r, 150));
    expect(getDb.mock.calls.length).toBe(calls);

    // A new scheduler can start once the old one is stopped.
    const next = startScheduler(getDb, { tickMs: 50, initialDelayMs: 10_000 });
    expect(next).not.toBe(scheduler);
    await next.stop();
  });

  it("keeps looping when a tick fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    let attempts = 0;
    const scheduler = startScheduler(
      async () => {
        attempts++;
        throw new Error("database is down");
      },
      { tickMs: 20, initialDelayMs: 0 },
    );
    await waitFor(() => attempts >= 3);
    await scheduler.stop();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("database is down"));
  });

  it("stop() cancels pending marketplace work and waits for the tick to wind down", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    let release!: () => void;
    let started = false;
    const cl = fakeAdapter("craigslist", {
      results: async (_q, ctx) => {
        started = true;
        // Ignores cancellation on purpose, like a slow adapter would.
        await new Promise<void>((r) => (release = r));
        void ctx;
        return [];
      },
    });
    const search = await insertSearch(db);
    const scheduler = startScheduler(async () => db, {
      tickMs: 1_000,
      initialDelayMs: 0,
      tickOptions: { adapters: { craigslist: cl }, gate: noWaitGate(), timeoutMs: 60_000 },
    });
    await waitFor(() => started);
    // The adapter ignores its abort signal; stop() still returns once the run has been wound down.
    await scheduler.stop();
    const [row] = await db.select().from(searches).where(eq(searches.id, search.id));
    expect(row.lastRunAt).not.toBeNull();
    expect(await db.select().from(scrapeRuns)).toHaveLength(0); // cancelled, not a marketplace failure
    release();
  });
});
