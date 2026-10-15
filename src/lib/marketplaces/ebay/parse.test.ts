import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ParseError } from "../types";
import { mapItemSummary, parseBrowseSearchResponse, readWarnings } from "./parse";

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../../../../test/fixtures/ebay/${name}`, import.meta.url), "utf8"));
}

describe("parseBrowseSearchResponse", () => {
  const listings = parseBrowseSearchResponse(fixture("browse-search.json"), "USD");

  it("keeps valid items in order and skips duplicates and items without id/title", () => {
    expect(listings.map((l) => l.externalId)).toEqual([
      "v1|306012345678|0",
      "v1|126712345001|0",
      "v1|287712345002|0",
      "v1|156612345003|0",
      "v1|166612345004|0",
    ]);
  });

  it("maps a fixed-price item completely", () => {
    expect(listings[0]).toEqual({
      marketplace: "ebay",
      externalId: "v1|306012345678|0",
      // Rebuilt from the legacy id: itemWebUrl's tracking parameters change between responses.
      url: "https://www.ebay.com/itm/306012345678",
      title: "Sony PlayStation 5 Disc Edition 825GB w/ 2 controllers",
      priceCents: 38000,
      currency: "USD",
      description: null,
      imageUrls: [
        "https://i.ebayimg.com/images/g/aBcAAOSw1234abcd/s-l225.jpg",
        "https://i.ebayimg.com/images/g/xYzAAOSw5678efgh/s-l225.jpg",
      ],
      locationText: "Seattle, WA, US",
      lat: null,
      lng: null,
      postedAt: new Date("2026-09-28T17:02:11.000Z"),
      sellerName: "retro_flips_sea",
      condition: "Used",
      raw: expect.objectContaining({
        legacyItemId: "306012345678",
        buyingOptions: ["FIXED_PRICE", "BEST_OFFER"],
        categoryIds: ["139971", "1249"],
        sellerFeedbackScore: 1532,
      }),
    });
  });

  it("leaves auction-only listings unpriced, keeping the bid in raw", () => {
    expect(listings[1]).toMatchObject({ priceCents: null, currency: "USD", locationText: "972**, US" });
    expect(listings[1].raw).toMatchObject({
      buyingOptions: ["AUCTION"],
      currentBidPrice: { value: "212.50", currency: "USD" },
      bidCount: 14,
      itemEndDate: "2026-10-03T02:15:00.000Z",
    });
  });

  it("uses the Buy It Now price when an auction also offers FIXED_PRICE", () => {
    expect(listings[2].priceCents).toBe(4500);
    expect(listings[2].postedAt).toEqual(new Date("2026-09-28T14:05:30.000Z"));
    expect(listings[2].condition).toBeNull();
  });

  it("tolerates missing images/location, thousands separators and invalid dates", () => {
    expect(listings[3]).toMatchObject({
      priceCents: 115000,
      imageUrls: [],
      locationText: null,
      postedAt: null,
      condition: "For parts or not working",
    });
  });

  it("falls back to the legacy item URL, thumbnails and the listed currency", () => {
    expect(listings[4]).toMatchObject({
      url: "https://www.ebay.com/itm/166612345004",
      currency: "CAD",
      imageUrls: ["https://i.ebayimg.com/thumbs/images/g/tHuMAOSw0000/s-l140.jpg"],
      locationText: "BC, CA",
    });
  });

  it("returns [] when eBay omits itemSummaries (no results)", () => {
    expect(parseBrowseSearchResponse(fixture("browse-search-empty.json"), "USD")).toEqual([]);
  });

  it("throws ParseError on a shape it does not understand", () => {
    expect(() => parseBrowseSearchResponse("<html>", "USD")).toThrow(ParseError);
    expect(() => parseBrowseSearchResponse({ itemSummaries: { a: 1 } }, "USD")).toThrow(ParseError);
  });

  it("throws ParseError when there are item summaries but none can be read", () => {
    const body = { total: 3, itemSummaries: [{ item_id: "v1|1|0" }, { item_id: "v1|2|0" }, { item_id: "v1|3|0" }] };
    expect(() => parseBrowseSearchResponse(body, "USD")).toThrow(/3 item summaries but none could be read/);
    expect(parseBrowseSearchResponse({ total: 0, itemSummaries: [] }, "USD")).toEqual([]);
  });

  it("reads non-fatal warnings", () => {
    expect(readWarnings(fixture("browse-search.json"))).toEqual([
      "The 'pickupRadius' value exceeds the maximum and was set to 250 km.",
    ]);
    expect(readWarnings({})).toEqual([]);
  });
});

describe("mapItemSummary", () => {
  it("uses the fallback currency and a null price when the amount is missing or junk", () => {
    const listing = mapItemSummary(
      { itemId: "v1|1|0", title: "Thing", price: { value: "n/a", currency: "us dollars" }, itemWebUrl: "https://www.ebay.com/itm/1" },
      "CAD",
    );
    expect(listing).toMatchObject({ priceCents: null, currency: "CAD" });
  });

  it("rejects non-http item URLs", () => {
    expect(mapItemSummary({ itemId: "v1|2|0", title: "Thing", itemWebUrl: "javascript:alert(1)" }, "USD")).toBeNull();
  });

  it("drops prices too large to store", () => {
    const base = { itemId: "v1|3|0", title: "Thing", itemWebUrl: "https://www.ebay.com/itm/3" };
    expect(mapItemSummary({ ...base, price: { value: "99999999999.00", currency: "USD" } }, "USD")?.priceCents).toBeNull();
  });

  describe("auctions", () => {
    const base = { itemId: "v1|126799999999|0", title: "Sony PS5 Slim", itemWebUrl: "https://www.ebay.com/itm/126799999999" };
    const bid = (value: string) => ({ value, currency: "USD" });

    it("never prices an auction-only listing by its bid (a new auction's is its opening bid)", () => {
      const penny = { ...base, buyingOptions: ["AUCTION"], currentBidPrice: bid("0.99"), price: bid("0.99"), bidCount: 0 };
      expect(mapItemSummary(penny, "USD")).toMatchObject({ priceCents: null, currency: "USD" });
      expect(mapItemSummary(penny, "USD")?.raw).toMatchObject({ currentBidPrice: bid("0.99"), bidCount: 0 });
    });

    it("prices an auction with Buy It Now at the Buy It Now price, and unpriced once that option is gone", () => {
      const withBin = { ...base, buyingOptions: ["AUCTION", "FIXED_PRICE"], price: bid("400.00"), currentBidPrice: bid("50.00") };
      expect(mapItemSummary(withBin, "USD")?.priceCents).toBe(40_000);
      const afterFirstBid = { ...base, buyingOptions: ["AUCTION"], currentBidPrice: bid("55.00"), bidCount: 1 };
      expect(mapItemSummary(afterFirstBid, "USD")?.priceCents).toBeNull();
      // No fallback to the bid when the Buy It Now amount is missing.
      expect(mapItemSummary({ ...withBin, price: undefined }, "USD")?.priceCents).toBeNull();
    });
  });

  describe("item URL", () => {
    const base = { itemId: "v1|306012345678|0", legacyItemId: "306012345678", title: "Thing" };

    it("is rebuilt from the legacy id on the host eBay linked to, without tracking parameters", () => {
      const ca = { ...base, itemWebUrl: "https://www.ebay.ca/itm/306012345678?hash=item473f1c2b4e:g:abc&amdata=enc%3AAQ" };
      expect(mapItemSummary(ca, "CAD")?.url).toBe("https://www.ebay.ca/itm/306012345678");
    });

    it("keeps the variation of a multi-variation listing", () => {
      const variation = { ...base, itemId: "v1|306012345678|410987654321", itemWebUrl: "https://www.ebay.com/itm/306012345678?var=410987654321&hash=x" };
      expect(mapItemSummary(variation, "USD")?.url).toBe("https://www.ebay.com/itm/306012345678?var=410987654321");
    });

    it("never points at a non-eBay host, and uses itemWebUrl as is without a legacy id", () => {
      expect(mapItemSummary({ ...base, itemWebUrl: "https://evil.example/itm/306012345678" }, "USD")?.url).toBe(
        "https://www.ebay.com/itm/306012345678",
      );
      const noLegacy = { itemId: "v1|5|0", title: "Thing", itemWebUrl: "https://www.ebay.com/itm/5?hash=abc" };
      expect(mapItemSummary(noLegacy, "USD")?.url).toBe("https://www.ebay.com/itm/5?hash=abc");
    });
  });

  it("strips control characters from untrusted text", () => {
    const listing = mapItemSummary(
      { itemId: "v1|4|0", title: "PS5\u0000 bundle\u001b", seller: { username: "bob\u0000" }, itemWebUrl: "https://www.ebay.com/itm/4" },
      "USD",
    );
    expect(listing).toMatchObject({ title: "PS5 bundle", sellerName: "bob" });
  });
});
