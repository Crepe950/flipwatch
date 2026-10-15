import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ParseError } from "../types";
import { looksLikeBotChallenge } from "./challenge";
import { readOfferUpPageData } from "./page-data";
import { countListingTiles, extractOfferUpListings, parseModularFeedResponse } from "./parse";

function fixture(name: string): string {
  return readFileSync(new URL(`../../../../test/fixtures/offerup/${name}`, import.meta.url), "utf8");
}

describe("readOfferUpPageData", () => {
  it("reads __NEXT_DATA__", () => {
    const blobs = readOfferUpPageData(fixture("search-page.html"));
    expect(blobs).toHaveLength(1);
    expect(blobs[0]).toMatchObject({ page: "/search", query: { q: "ps5" } });
  });

  it("reads app-router flight rows and skips non-JSON rows", () => {
    const blobs = readOfferUpPageData(fixture("search-page-app-router.html"));
    expect(blobs).toHaveLength(1);
    expect(extractOfferUpListings(...blobs).map((l) => l.title)).toEqual(["Dyson V11"]);
  });

  it("returns [] for pages without app data or with broken JSON", () => {
    expect(readOfferUpPageData(fixture("challenge.html"))).toEqual([]);
    expect(readOfferUpPageData('<script id="__NEXT_DATA__" type="application/json">{"props":</script>')).toEqual([]);
    expect(readOfferUpPageData("")).toEqual([]);
  });
});

describe("extractOfferUpListings (search page)", () => {
  const listings = extractOfferUpListings(...readOfferUpPageData(fixture("search-page.html")));

  it("finds every listing tile, skipping ads/banners/users and duplicates", () => {
    expect(listings.map((l) => l.externalId)).toEqual([
      "1784512345",
      "a9e3f1c2-7b44-4d6e-9f10-2c3d4e5f6a7b",
      "1784500001",
      "1784500002",
    ]);
  });

  it("maps a tile completely", () => {
    expect(listings[0]).toEqual({
      marketplace: "offerup",
      externalId: "1784512345",
      url: "https://offerup.com/item/detail/1784512345",
      title: "PS5 disc edition + 2 controllers",
      priceCents: 38000,
      currency: "USD",
      description: null,
      imageUrls: ["https://images.offerup.com/Xq9vAbCdEfGh=/250x333/5a1e/5a1e8c2f0b.jpg"],
      locationText: "Seattle, WA",
      lat: null,
      lng: null,
      // Filled in from the duplicate tile that carries a postDate.
      postedAt: new Date("2026-09-28T17:02:11Z"),
      sellerName: null,
      condition: "Used",
      raw: { listingId: "1784512345", price: "380", isFirmPrice: false, flags: ["LOCAL_PICKUP"], vehicleMiles: null },
    });
  });

  it("handles thousands separators, free items, numeric prices and missing images", () => {
    expect(listings[1]).toMatchObject({ priceCents: 115000, condition: "Like new", raw: expect.objectContaining({ isFirmPrice: true }) });
    expect(listings[1].url).toBe("https://offerup.com/item/detail/a9e3f1c2-7b44-4d6e-9f10-2c3d4e5f6a7b");
    expect(listings[2]).toMatchObject({ title: "FREE couch - must pick up", priceCents: 0, imageUrls: [], condition: null, postedAt: null });
    expect(listings[3].priceCents).toBe(750000);
  });

  it("drops unsafe image URLs and fills gaps from the cache entry of the same listing", () => {
    expect(listings[3].imageUrls).toEqual([
      "https://images.offerup.com/CiViC0001=/1000x750/c1c1/c1c1a0.jpg",
      "https://images.offerup.com/CiViC0002=/1000x750/c1c1/c1c1a1.jpg",
    ]);
    expect(listings[3].postedAt).toEqual(new Date(1_790_000_000 * 1000));
  });

  it("returns [] for a page whose feed is empty", () => {
    expect(extractOfferUpListings(...readOfferUpPageData(fixture("search-page-empty.html")))).toEqual([]);
  });
});

describe("extractOfferUpListings (untrusted values)", () => {
  const tile = (listingId: string, price: unknown, title = "Thing") => ({ listing: { listingId, title, price } });

  it("treats placeholder, negative and non-scalar prices as no price", () => {
    const listings = extractOfferUpListings({
      tiles: [tile("1", "123456789012"), tile("2", -5), tile("3", { amount: 5 }), tile("4", null), tile("5", "Make offer")],
    });
    expect(listings.map((l) => [l.externalId, l.priceCents])).toEqual([
      ["1", null],
      ["2", null],
      ["3", null],
      ["4", null],
      ["5", null],
    ]);
  });

  it("strips control characters and skips nodes without a usable id, title or price key", () => {
    const listings = extractOfferUpListings([
      tile("6", "10", "Lamp\u0000 with\u0007 shade"),
      tile("  ", "10"),
      tile("7", "10", "\u0000 "),
      { listingId: "8", title: "No price key" },
    ]);
    expect(listings.map((l) => [l.externalId, l.title])).toEqual([["6", "Lamp with shade"]]);
  });
});

describe("parseModularFeedResponse", () => {
  it("maps GraphQL tiles, coercing numeric ids/prices and deduplicating", () => {
    const listings = parseModularFeedResponse(JSON.parse(fixture("graphql-modular-feed.json")));
    expect(listings.map((l) => [l.externalId, l.priceCents, l.imageUrls.length])).toEqual([
      ["1784600001", 22000, 1],
      ["1784600002", 4550, 1],
    ]);
    expect(listings[1].url).toBe("https://offerup.com/item/detail/1784600002");
  });

  it("returns [] for an empty feed", () => {
    expect(parseModularFeedResponse(JSON.parse(fixture("graphql-empty.json")))).toEqual([]);
  });

  it("throws ParseError when the feed has listing tiles none of which can be read", () => {
    const drifted = JSON.parse(fixture("graphql-modular-feed.json").replaceAll('"listingId"', '"id"'));
    expect(countListingTiles(drifted)).toBe(3);
    expect(() => parseModularFeedResponse(drifted)).toThrow(ParseError);
    expect(() => parseModularFeedResponse(drifted)).toThrow(/3 listing tiles but none could be read/);
    // Tiles that aren't listings (alerts, ads) don't count.
    const alertsOnly = { data: { modularFeed: { looseTiles: [{ __typename: "ModularFeedTileSearchAlert", tileId: "a" }] } } };
    expect(parseModularFeedResponse(alertsOnly)).toEqual([]);
  });

  it("throws ParseError with the GraphQL message when there is no feed", () => {
    expect(() => parseModularFeedResponse(JSON.parse(fixture("graphql-errors.json")))).toThrow(
      /OfferUp GraphQL error: Cannot query field "listingz"/,
    );
    expect(() => parseModularFeedResponse({ data: {} })).toThrow(ParseError);
    expect(() => parseModularFeedResponse(null)).toThrow(ParseError);
  });
});

describe("looksLikeBotChallenge", () => {
  it("recognises PerimeterX, DataDome and Cloudflare interstitials", () => {
    expect(looksLikeBotChallenge(fixture("challenge.html"))).toBe(true);
    expect(looksLikeBotChallenge('<script src="https://geo.captcha-delivery.com/captcha/"></script>')).toBe(true);
    expect(looksLikeBotChallenge("<title>Just a moment...</title><script>window._cf_chl_opt={}</script>")).toBe(true);
  });

  it("does not flag an ordinary page", () => {
    expect(looksLikeBotChallenge("<html><title>ps5 | OfferUp</title><body><h1>No results</h1></body></html>")).toBe(false);
  });
});
