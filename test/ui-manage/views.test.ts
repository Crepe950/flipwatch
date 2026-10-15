import { describe, expect, it } from "vitest";
import { describeInterval, describePriceRange, formatDuration, safeHttpUrl } from "@/components/searches/describe";
import { describeLastError, describeRunMessage, NOT_SET_UP, type SkipReasons } from "@/components/searches/run-messages";
import { runHeadline, summarizeRun, toPreviewView } from "@/components/searches/run-views";
import { timeUntil } from "@/components/ui/relative-time";
import type { PreviewListing, PreviewResult, RunSearchResult } from "@/lib/engine";

function listing(n: number, overrides: Partial<PreviewListing> = {}): PreviewListing {
  return {
    marketplace: "craigslist",
    externalId: String(n),
    url: `https://vancouver.craigslist.org/${n}.html`,
    title: `Listing ${n}`,
    priceCents: 10_000 + n,
    currency: "CAD",
    imageUrls: [`https://images.craigslist.org/${n}.jpg`],
    postedAt: new Date("2026-09-28T10:00:00Z"),
    raw: { huge: "x".repeat(1000) },
    passesFilters: n % 2 === 0,
    rejectReason: n % 2 === 0 ? undefined : "Excluded term: broken",
    ...overrides,
  };
}

describe("summarizeRun", () => {
  const result: RunSearchResult = {
    searchId: 5,
    startedAt: new Date("2026-09-28T12:00:00Z"),
    finishedAt: new Date("2026-09-28T12:00:04.5Z"),
    events: [],
    marketplaces: [
      { marketplace: "craigslist", resultCount: 40, matchedCount: 12, newCount: 3, priceDropCount: 1, durationMs: 1800 },
      { marketplace: "kijiji", resultCount: 0, matchedCount: 0, newCount: 0, priceDropCount: 0, durationMs: 900, error: "Blocked (403) by kijiji" },
      { marketplace: "ebay", resultCount: 0, matchedCount: 0, newCount: 0, priceDropCount: 0, durationMs: 0, skipped: "not configured" },
    ],
  };

  it("totals per-marketplace counts", () => {
    const summary = summarizeRun(result, "PS5");
    expect(summary).toMatchObject({
      searchId: 5,
      searchName: "PS5",
      durationMs: 4500,
      resultCount: 40,
      newCount: 3,
      priceDropCount: 1,
      errorCount: 1,
      skippedCount: 1,
    });
    expect(summary.marketplaces[1]).toEqual(expect.objectContaining({ error: "Blocked (403) by kijiji" }));
    expect(summary.marketplaces[0]).not.toHaveProperty("error");
    expect(runHeadline(summary)).toBe("3 new · 1 price drop · 40 results");
  });

  it("handles runs where nothing was queried", () => {
    const summary = summarizeRun({ ...result, marketplaces: [] }, "Empty");
    expect(summary).toMatchObject({ resultCount: 0, errorCount: 0 });
    expect(runHeadline(summary)).toBe("No marketplaces were queried");
  });

  it("shortens the setup paragraph of a marketplace that isn't set up", () => {
    const reasons: SkipReasons = new Map([["ebay", { reason: "not configured", short: NOT_SET_UP }]]);
    expect(summarizeRun(result, "PS5", reasons).marketplaces[2]).toEqual(expect.objectContaining({ skipped: NOT_SET_UP }));
  });
});

describe("toPreviewView", () => {
  it("counts pass/fail, caps listings and strips raw data", () => {
    const results: PreviewResult[] = [
      {
        marketplace: "craigslist",
        listings: Array.from({ length: 14 }, (_, i) => listing(i)),
        searchUrl: "https://vancouver.craigslist.org/search/sss?query=ps5",
      },
      { marketplace: "kijiji", listings: [], error: "Timed out" },
    ];
    const [cl, kijiji] = toPreviewView(results);
    expect(cl).toMatchObject({ total: 14, passing: 7, failing: 7, error: null });
    expect(cl.listings).toHaveLength(10);
    expect(cl.listings[1]).toMatchObject({ passesFilters: false, rejectReason: "Excluded term: broken", postedAt: "2026-09-28T10:00:00.000Z" });
    expect(cl.listings[0].rejectReason).toBeNull();
    expect(JSON.stringify(cl)).not.toContain("huge");
    expect(kijiji).toMatchObject({ total: 0, error: "Timed out", skipped: null, searchUrl: null, listings: [] });
  });

  it("shows marketplaces that can't serve the search as skipped, not failed (like Run now)", () => {
    const disabled = "Disabled. Facebook Marketplace has no public API: FlipWatch can only read it through a logged-in browser session…";
    const reasons: SkipReasons = new Map([
      ["facebook", { reason: disabled, short: NOT_SET_UP }],
      ["offerup", { reason: "OfferUp does not serve CA", short: "OfferUp does not serve CA" }],
    ]);
    const [facebook, offerup, kijiji] = toPreviewView(
      [
        { marketplace: "facebook", listings: [], error: disabled },
        { marketplace: "offerup", listings: [], error: "OfferUp does not serve CA" },
        { marketplace: "kijiji", listings: [], error: "Blocked (403) by kijiji" },
      ],
      { skipReasons: reasons },
    );
    expect(facebook).toMatchObject({ error: null, skipped: NOT_SET_UP });
    expect(offerup).toMatchObject({ error: null, skipped: "OfferUp does not serve CA" });
    expect(kijiji).toMatchObject({ error: "Blocked (403) by kijiji", skipped: null });
  });

  it("drops unsafe links and tolerates missing fields", () => {
    const [view] = toPreviewView([
      {
        marketplace: "offerup",
        listings: [
          listing(1, {
            url: "javascript:alert(1)",
            imageUrls: [],
            title: "",
            postedAt: null,
            currency: "",
            passesFilters: false,
            rejectReason: undefined,
          }),
        ],
        searchUrl: "data:text/html,hi",
      },
    ]);
    expect(view.searchUrl).toBeNull();
    expect(view.listings[0]).toMatchObject({
      url: null,
      imageUrl: null,
      title: "Untitled listing",
      postedAt: null,
      currency: "USD",
      rejectReason: "Filtered out",
    });
  });
});

describe("describe helpers", () => {
  it("describes price ranges", () => {
    expect(describePriceRange(null, null, "USD")).toBe("Any price");
    expect(describePriceRange(null, 0, "USD")).toBe("Free only");
    expect(describePriceRange(10_000, 40_000, "CAD")).toBe("$100–$400");
    expect(describePriceRange(null, 40_000, "USD")).toBe("Up to $400");
    expect(describePriceRange(5_000, null, "USD")).toBe("$50+");
    expect(describePriceRange(0, null, "USD")).toBe("Any price");
    expect(describePriceRange(0, 40_000, "USD")).toBe("Up to $400");
  });

  it("describes intervals and durations", () => {
    expect(describeInterval(30)).toBe("every 30s");
    expect(describeInterval(60)).toBe("every minute");
    expect(describeInterval(90)).toBe("every 90s");
    expect(describeInterval(120)).toBe("every 2 min");
    expect(describeInterval(3600)).toBe("every hour");
    expect(describeInterval(5400)).toBe("every 1.5 h");
    expect(formatDuration(850)).toBe("850 ms");
    expect(formatDuration(1_234)).toBe("1.2 s");
    expect(formatDuration(95_000)).toBe("95 s");
  });

  it("only allows http(s) URLs", () => {
    expect(safeHttpUrl("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
    expect(safeHttpUrl("http://example.com")).toBe("http://example.com/");
    for (const bad of ["javascript:alert(1)", "data:image/png;base64,AAA", "//example.com", "", null, undefined, "not a url"]) {
      expect(safeHttpUrl(bad)).toBeNull();
    }
  });
});

describe("run messages", () => {
  const disabled =
    "Disabled. Facebook Marketplace has no public API: FlipWatch can only read it through a logged-in browser session, which is against Meta's Terms of Service.";
  const reasons: SkipReasons = new Map([["facebook", { reason: disabled, short: NOT_SET_UP }]]);

  it("turns backoff timestamps into a time to show relatively, keeping the cause", () => {
    expect(describeRunMessage("craigslist", "Backing off until 2026-09-28T22:15:17.730Z (Blocked (403) by craigslist)")).toEqual({
      marketplace: "craigslist",
      kind: "backoff",
      text: "Blocked (403) by craigslist",
      until: "2026-09-28T22:15:17.730Z",
    });
    expect(describeRunMessage("kijiji", "Backing off until 2026-09-28T22:15:17.730Z")).toMatchObject({
      kind: "backoff",
      text: "Paused after repeated failures",
    });
  });

  it("splits a stored lastError per marketplace and recognises skips, even when truncated", () => {
    const lastError = `craigslist: Backing off until 2026-09-28T22:15:17.730Z (Blocked (403) by craigslist; retry later); kijiji: Timed out after 20 s; facebook: ${disabled.slice(0, 60)}…`;
    expect(describeLastError(lastError, reasons)).toEqual([
      { marketplace: "craigslist", kind: "backoff", text: "Blocked (403) by craigslist; retry later", until: "2026-09-28T22:15:17.730Z" },
      { marketplace: "kijiji", kind: "error", text: "Timed out after 20 s" },
      { marketplace: "facebook", kind: "skipped", text: NOT_SET_UP },
    ]);
    expect(describeLastError("Something odd happened")).toEqual([{ marketplace: null, kind: "error", text: "Something odd happened" }]);
    // A different Facebook error is still an error.
    expect(describeLastError("facebook: Facebook request failed: socket hang up", reasons)[0].kind).toBe("error");
  });

  it("says how long until a future time", () => {
    const now = new Date("2026-09-28T12:00:00Z");
    expect(timeUntil("2026-09-28T12:00:20Z", now)).toBe("any moment now");
    expect(timeUntil("2026-09-28T11:00:00Z", now)).toBe("any moment now");
    expect(timeUntil("2026-09-28T12:12:10Z", now)).toBe("in 12m");
    expect(timeUntil("2026-09-28T15:00:00Z", now)).toBe("in 3h");
    expect(timeUntil("2026-09-30T12:00:00Z", now)).toBe("in 2d");
  });
});
