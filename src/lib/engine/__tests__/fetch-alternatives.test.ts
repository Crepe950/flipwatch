import { describe, expect, it } from "vitest";
import { DEFAULT_LOCATION } from "@/lib/locations";
import { BlockedError } from "@/lib/marketplaces/types";
import { ALTERNATIVE_ROTATION_MS, buildSearchQuery, fetchMarketplace, RESULT_LIMIT, rotateAlternatives } from "../fetch";
import { parseQuery } from "../filters";
import { fakeAdapter, noWaitGate, scraped } from "./helpers";

const orQuery = buildSearchQuery({ location: DEFAULT_LOCATION }, parseQuery('laptop | macbook | "graphics card"'));

describe("fetchMarketplace with OR queries", () => {
  it("passes the alternatives of an OR query along with the query", () => {
    expect(orQuery.alternatives).toEqual(["laptop", "macbook", "graphics card"]);
    expect(buildSearchQuery({ location: DEFAULT_LOCATION }, parseQuery("road bike")).alternatives).toBeUndefined();
  });

  it("sends the OR query as-is to marketplaces that support it", async () => {
    const adapter = fakeAdapter("craigslist", { results: [scraped("craigslist", "1")] });
    await fetchMarketplace(adapter, orQuery, { gate: noWaitGate() });
    expect(adapter.calls.map((q) => q.keywords)).toEqual([orQuery.keywords]);
  });

  it("searches each alternative separately on marketplaces without OR syntax, merging and de-duplicating", async () => {
    const adapter = {
      ...fakeAdapter("facebook", {
        results: (q) => (q.keywords === "laptop" ? [scraped("facebook", "a"), scraped("facebook", "b")] : [scraped("facebook", "b"), scraped("facebook", q.keywords)]),
      }),
      supportsOrQueries: false,
    };
    const results = await fetchMarketplace(adapter, orQuery, { gate: noWaitGate() });
    expect(adapter.calls.map((q) => q.keywords)).toEqual(["laptop", "macbook", "graphics card"]);
    expect(adapter.calls.every((q) => q.alternatives === undefined)).toBe(true);
    expect(results.map((l) => l.externalId)).toEqual(["a", "b", "macbook", "graphics card"]);
  });

  it("stops at the first failing alternative", async () => {
    const adapter = {
      ...fakeAdapter("facebook", {
        results: (q) => {
          if (q.keywords === "macbook") throw new BlockedError("blocked", "facebook");
          return [scraped("facebook", q.keywords)];
        },
      }),
      supportsOrQueries: false,
    };
    await expect(fetchMarketplace(adapter, orQuery, { gate: noWaitGate() })).rejects.toThrow("blocked");
    expect(adapter.calls.map((q) => q.keywords)).toEqual(["laptop", "macbook"]);
  });

  it("rotates through alternatives when the adapter caps them per run", async () => {
    const six = ["a", "b", "c", "d", "e", "f"];
    const slot = ALTERNATIVE_ROTATION_MS;
    expect(rotateAlternatives(six, 2, 0)).toEqual(["a", "b"]);
    expect(rotateAlternatives(six, 2, slot)).toEqual(["c", "d"]);
    expect(rotateAlternatives(six, 2, 2 * slot)).toEqual(["e", "f"]);
    expect(rotateAlternatives(six, 2, 3 * slot)).toEqual(["a", "b"]);
    expect(rotateAlternatives(["a", "b", "c"], 2, slot)).toEqual(["c", "a"]);
    expect(rotateAlternatives(six, undefined, slot)).toEqual(six);

    const adapter = { ...fakeAdapter("facebook"), supportsOrQueries: false, maxAlternativesPerRun: 2 };
    await fetchMarketplace(adapter, orQuery, { gate: noWaitGate() });
    expect(adapter.calls).toHaveLength(2);
  });

  it("uses the adapter's own result cap instead of the default", async () => {
    const adapter = { ...fakeAdapter("craigslist"), maxResults: 300 };
    await fetchMarketplace(adapter, orQuery, { gate: noWaitGate() });
    expect(orQuery.limit).toBe(RESULT_LIMIT);
    expect(adapter.calls[0].limit).toBe(300);
  });
});
