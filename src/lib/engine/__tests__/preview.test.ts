import { describe, expect, it, vi } from "vitest";
import { ParseError } from "@/lib/marketplaces/types";
import { searchInputSchema } from "@/lib/search-schema";
import { DEFAULT_LOCATION } from "@/lib/locations";
import { previewSearch } from "../runner";
import { NOW, fakeAdapter, minutesAfter, noWaitGate, scraped } from "./helpers";

vi.mock("@/lib/notify", () => ({ notifyMatchEvents: vi.fn() }));
vi.mock("@/lib/ai", () => ({ aiStatus: () => ({ configured: false, model: "" }), evaluateListing: vi.fn() }));

const input = (overrides: Record<string, unknown> = {}) =>
  searchInputSchema.parse({
    name: "PS5",
    query: "ps5 -broken",
    maxPriceCents: 50_000,
    marketplaces: ["craigslist", "ebay", "kijiji"],
    location: DEFAULT_LOCATION,
    ...overrides,
  });

describe("previewSearch", () => {
  it("returns filtered, sanitized results per marketplace without touching the database", async () => {
    const cl = fakeAdapter("craigslist", {
      results: [
        scraped("craigslist", "1", { title: "PS5 disc" }),
        scraped("craigslist", "1", { title: "duplicate" }),
        scraped("craigslist", "2", { title: "PS5 broken" }),
        scraped("craigslist", "3", { priceCents: 90_000 }),
        scraped("craigslist", "4", { postedAt: minutesAfter(NOW, -3 * 24 * 60) }),
      ],
    });
    const eb = fakeAdapter("ebay", { status: { ok: false, message: "Missing eBay credentials" } });
    const kj = fakeAdapter("kijiji", {
      results: () => {
        throw new ParseError("Kijiji page layout changed", "kijiji");
      },
    });

    const results = await previewSearch(input(), { adapters: { craigslist: cl, ebay: eb, kijiji: kj }, gate: noWaitGate(), now: NOW });

    expect(results.map((r) => r.marketplace)).toEqual(["craigslist", "ebay", "kijiji"]);
    const [craigslist, ebay, kijiji] = results;

    expect(cl.calls[0].keywords).toBe("ps5");
    expect(craigslist.searchUrl).toBe("https://craigslist.example.com/search?q=ps5");
    expect(craigslist.error).toBeUndefined();
    expect(craigslist.listings.map((l) => [l.externalId, l.passesFilters, l.rejectReason ?? null, l.stale])).toEqual([
      ["1", true, null, false],
      ["2", false, 'Contains excluded term "broken"', false],
      ["3", false, "Price $900 is above the maximum $500", false],
      ["4", true, null, true],
    ]);

    expect(ebay).toEqual({ marketplace: "ebay", listings: [], error: "Missing eBay credentials", searchUrl: "https://ebay.example.com/search?q=ps5" });
    expect(eb.calls).toHaveLength(0);
    expect(kijiji).toMatchObject({ listings: [], error: "Kijiji page layout changed", searchUrl: "https://kijiji.example.com/search?q=ps5" });
  });

  it("omits unsafe or empty search URLs", async () => {
    const cl = fakeAdapter("craigslist");
    cl.buildSearchUrl = () => "";
    const eb = fakeAdapter("ebay");
    eb.buildSearchUrl = () => "javascript:alert(1)";
    const results = await previewSearch(input({ marketplaces: ["craigslist", "ebay"] }), {
      adapters: { craigslist: cl, ebay: eb },
      gate: noWaitGate(),
    });
    expect(results.map((r) => r.searchUrl)).toEqual([undefined, undefined]);
  });

  it("asks every marketplace for $0 listings in the free category and drops priced ones", async () => {
    const cl = fakeAdapter("craigslist", {
      results: [scraped("craigslist", "free", { priceCents: 0 }), scraped("craigslist", "sold", { priceCents: 2_500 })],
    });
    const [result] = await previewSearch(input({ category: "free", marketplaces: ["craigslist"] }), {
      adapters: { craigslist: cl },
      gate: noWaitGate(),
      now: NOW,
    });
    expect(cl.calls[0]).toMatchObject({ category: "free", minPriceCents: null, maxPriceCents: 0 });
    expect(result.listings.map((l) => [l.externalId, l.passesFilters, l.rejectReason ?? null])).toEqual([
      ["free", true, null],
      ["sold", false, "Not free ($25)"],
    ]);
  });
});
