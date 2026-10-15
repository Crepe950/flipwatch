import { describe, expect, it } from "vitest";
import type { AiEvaluation, Listing, SearchMatch } from "../../db/schema";
import { alertTitle, buildDigestAlert, buildMatchAlert, buildSampleAlert, money, normalizeAppUrl, safeHttpUrl, type MatchAlertInput } from "../format";
import { APP_URL, NOW } from "./fixtures";

const fmt = { appUrl: APP_URL, now: NOW };

function listing(overrides: Partial<Listing> = {}): Listing {
  return {
    id: 42,
    marketplace: "craigslist",
    externalId: "7712345678",
    url: "https://vancouver.craigslist.org/van/vgm/d/ps5/7712345678.html",
    title: "PS5 Digital Edition",
    description: null,
    priceCents: 12_000,
    originalPriceCents: 15_000,
    currency: "USD",
    imageUrls: ["//images.craigslist.org/a_600x450.jpg", "https://images.craigslist.org/b.jpg"],
    locationText: "Vancouver, BC",
    lat: null,
    lng: null,
    postedAt: new Date(NOW.getTime() - 5 * 60_000),
    sellerName: null,
    condition: null,
    status: "active",
    raw: null,
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    ...overrides,
  };
}

function match(overrides: Partial<SearchMatch> = {}): SearchMatch {
  return {
    id: 7,
    searchId: 3,
    listingId: 42,
    firstMatchedAt: NOW,
    lastEventAt: NOW,
    lastEvent: "new",
    lastEventPreviousPriceCents: null,
    dealScore: 86,
    dealScoreReason: "32% below median of 14 comps",
    estimatedProfitCents: 9_500,
    silent: false,
    notifiedAt: null,
    seen: false,
    dismissed: false,
    ...overrides,
  };
}

const ai: AiEvaluation = {
  id: 1,
  listingId: 42,
  searchId: 3,
  model: "claude",
  verdict: "great",
  dealScore: 90,
  estimatedResaleLowCents: 20_000,
  estimatedResaleHighCents: 24_000,
  suggestedOfferCents: 11_000,
  summary: "Clean unit,\npriced well under comps.",
  reasons: [],
  redFlags: [],
  questionsForSeller: [],
  inputTokens: null,
  outputTokens: null,
  createdAt: NOW,
};

function input(overrides: Partial<MatchAlertInput> = {}): MatchAlertInput {
  return { event: { type: "new" }, search: { id: 3, name: "PS5" }, listing: listing(), match: match(), ai: null, ...overrides };
}

describe("buildMatchAlert", () => {
  it("formats a new-listing alert", () => {
    const alert = buildMatchAlert(input({ ai }), fmt);
    expect(alert.title).toBe("$120 · PS5 Digital Edition");
    expect(alert.lines).toEqual([
      "Craigslist · Vancouver, BC · posted 5m ago",
      "Deal score: 86/100 · 32% below median of 14 comps",
      "Est. profit: +$95",
      "AI verdict: Great deal · offer $110 — Clean unit, priced well under comps.",
      "Search: PS5",
    ]);
    expect(alert).toMatchObject({
      kind: "new",
      url: "https://vancouver.craigslist.org/van/vgm/d/ps5/7712345678.html",
      appUrl: `${APP_URL}/listings/42`,
      appPath: "/listings/42",
      imageUrl: "https://images.craigslist.org/a_600x450.jpg",
      tag: "match-7",
      matchIds: [7],
      dealScore: 86,
    });
    expect(alert.listing?.imageUrls).toHaveLength(2);
    expect(alert.ai?.verdict).toBe("great");
  });

  it("formats price drops with the previous price", () => {
    expect(alertTitle({ event: { type: "price_drop", previousPriceCents: 15_000 }, listing: listing() })).toBe("Price drop $150 → $120 · PS5 Digital Edition");
    // Falls back to the first-seen price when the engine didn't pass one.
    expect(alertTitle({ event: { type: "price_drop" }, listing: listing() })).toBe("Price drop $150 → $120 · PS5 Digital Edition");
    expect(alertTitle({ event: { type: "price_drop" }, listing: listing({ originalPriceCents: null }) })).toBe("Price drop to $120 · PS5 Digital Edition");
  });

  it("handles free, missing and oddly-denominated prices", () => {
    expect(alertTitle({ event: { type: "new" }, listing: listing({ priceCents: 0 }) })).toBe("Free · PS5 Digital Edition");
    expect(alertTitle({ event: { type: "new" }, listing: listing({ priceCents: null }) })).toBe("PS5 Digital Edition");
    expect(money(12_000, "CAD")).toBe("$120");
    expect(money(12_050, "not-a-currency")).toBe("120.50 not-a-currency");
  });

  it("cleans hostile or broken listing data", () => {
    const alert = buildMatchAlert(
      input({
        listing: listing({ title: "  PS5\n‮evil  ", url: "javascript:alert(1)", imageUrls: ["data:image/png;base64,xx"], locationText: null, postedAt: null }),
        match: match({ dealScore: null, estimatedProfitCents: null }),
      }),
      fmt,
    );
    expect(alert.title).toBe("$120 · PS5 evil");
    expect(alert.url).toBe(`${APP_URL}/listings/42`);
    expect(alert.imageUrl).toBeNull();
    expect(alert.lines).toEqual(["Craigslist", "Search: PS5"]);
  });

  it("normalises APP_URL for links", () => {
    expect(normalizeAppUrl("https://flip.example.com/")).toBe("https://flip.example.com");
    expect(normalizeAppUrl("flip.example.com")).toBe("https://flip.example.com");
    expect(normalizeAppUrl("http://192.168.1.10:3000//")).toBe("http://192.168.1.10:3000");
    expect(normalizeAppUrl("https://example.com/flipwatch/")).toBe("https://example.com/flipwatch");
    expect(normalizeAppUrl("ftp://nope")).toBe("http://localhost:3000");
  });

  it("validates URLs", () => {
    expect(safeHttpUrl("//cdn.example.com/a.jpg")).toBe("https://cdn.example.com/a.jpg");
    expect(safeHttpUrl("ftp://x")).toBeNull();
    expect(safeHttpUrl("not a url")).toBeNull();
    expect(safeHttpUrl(42)).toBeNull();
  });
});

describe("buildDigestAlert", () => {
  it("summarises overflow matches and links to the search feed", () => {
    const inputs = Array.from({ length: 12 }, (_, i) => input({ listing: listing({ id: 100 + i, title: `Item ${i}` }), match: match({ id: 200 + i, dealScore: i }) }));
    const digest = buildDigestAlert({ id: 3, name: "PS5" }, inputs, fmt);
    expect(digest.title).toBe("+12 more matches for PS5");
    expect(digest.url).toBe(`${APP_URL}/?search=3`);
    expect(digest.appPath).toBe("/?search=3");
    expect(digest.matchIds).toHaveLength(12);
    expect(digest.items[0]).toEqual({ matchId: 200, listingId: 100, title: "$120 · Item 0", url: listing().url, appUrl: `${APP_URL}/listings/100` });
    expect(digest.lines).toHaveLength(11);
    expect(digest.lines.at(-1)).toBe("…and 2 more");
    expect(digest.dealScore).toBe(11);
    expect(buildDigestAlert({ id: 3, name: "PS5" }, inputs.slice(0, 1), fmt).title).toBe("+1 more match for PS5");
  });
});

describe("buildSampleAlert", () => {
  it("is a complete, clearly-marked test alert", () => {
    const sample = buildSampleAlert(fmt);
    expect(sample.test).toBe(true);
    expect(sample.url).toBe(`${APP_URL}/`);
    expect(sample.lines.at(-1)).toMatch(/test alert/);
    expect(sample.listing?.priceCents).toBe(12_000);
  });
});
