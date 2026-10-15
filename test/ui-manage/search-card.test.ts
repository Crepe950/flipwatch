import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SearchCard } from "@/components/searches/search-card";
import { DEFAULT_LOCATION } from "@/lib/locations";
import type { SearchWithStats } from "@/lib/queries/searches";
import type { MarketplaceId } from "@/lib/types";

function search(overrides: Partial<SearchWithStats> = {}): SearchWithStats {
  return {
    id: 7,
    name: "Road bikes",
    query: "road bike",
    excludeTerms: [],
    titleMustMatch: false,
    minPriceCents: null,
    maxPriceCents: 50_000,
    expectedResaleCents: null,
    marketplaces: ["ebay"] as MarketplaceId[],
    location: DEFAULT_LOCATION,
    category: null,
    pollIntervalSec: 60,
    maxListingAgeHours: 48,
    notifyChannelIds: [],
    notifyMinDealScore: null,
    notifyMinAiScore: null,
    notifyMinProfitPct: null,
    aiInstructions: null,
    notifyPriceDrops: true,
    aiEvaluate: false,
    enabled: true,
    lastRunAt: null,
    nextRunAt: null,
    lastError: null,
    definitionChangedAt: null,
    createdAt: new Date("2026-09-01T00:00:00Z"),
    updatedAt: new Date("2026-09-01T00:00:00Z"),
    recentMatches: 0,
    totalMatches: 0,
    ...overrides,
  };
}

const render = (s: SearchWithStats, ebaySearches: number | null = null) =>
  renderToStaticMarkup(createElement(SearchCard, { search: s, skipReasons: new Map(), ebaySearches }));

describe("search card", () => {
  it("shows the interval the scheduler really uses when eBay's daily quota stretches it", () => {
    // 10 enabled eBay searches share 4,500 calls a day: ceil(86,400 × 10 / 4,500) = 192 s each.
    expect(render(search(), 10)).toContain("every 192s");
    // A paused one would share it with the 10 others once resumed.
    expect(render(search({ enabled: false }), 10)).toContain("every 212s");
    // Searches without eBay, and eBay without credentials (null), keep their own interval.
    expect(render(search({ marketplaces: ["craigslist"] }), 10)).toContain("every minute");
    expect(render(search(), null)).toContain("every minute");
  });

  it("doesn't fade paused cards: opacity would drop their text below 4.5:1 contrast", () => {
    const html = render(search({ enabled: false, lastError: "craigslist: Blocked (403)" }));
    expect(html).toContain(">Paused</span>");
    const cardClass = /^<li class="([^"]*)"/.exec(html)?.[1];
    expect(cardClass).not.toMatch(/opacity/);
    // The page background, like every surface, keeps muted and badge text readable (contrast.test.ts).
    expect(cardClass).toMatch(/\bbg-bg\b/);
  });
});
