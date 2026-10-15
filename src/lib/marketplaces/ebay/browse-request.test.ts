import { describe, expect, it } from "vitest";
import type { SearchQuery } from "../../types";
import {
  buildBrowseFilter,
  buildBrowseHeaders,
  buildBrowseSearchUrl,
  buildEndUserContext,
  buildPriceFilter,
  clampLimit,
  normalizePostalCode,
} from "./browse-request";
import { buildEbayPublicSearchUrl } from "./public-url";

const vancouver = {
  label: "Vancouver, BC",
  lat: 49.2827,
  lng: -123.1207,
  radiusKm: 40,
  countryCode: "CA",
  postalCode: "V6B 1A1",
};

function query(overrides: Partial<SearchQuery> = {}): SearchQuery {
  return { keywords: "ps5 console", location: vancouver, ...overrides };
}

describe("buildPriceFilter", () => {
  it("builds closed and open-ended ranges in whole units", () => {
    expect(buildPriceFilter(10_000, 50_000, "USD")).toEqual(["price:[100..500]", "priceCurrency:USD"]);
    expect(buildPriceFilter(10_000, null, "USD")).toEqual(["price:[100..]", "priceCurrency:USD"]);
    expect(buildPriceFilter(null, 50_000, "CAD")).toEqual(["price:[..500]", "priceCurrency:CAD"]);
  });

  it("rounds the minimum down and the maximum up", () => {
    expect(buildPriceFilter(15_050, 49_999, "USD")[0]).toBe("price:[150..500]");
  });

  it("omits the filter when there is no bound, and treats a 0 minimum as none", () => {
    expect(buildPriceFilter(null, undefined, "USD")).toEqual([]);
    expect(buildPriceFilter(0, null, "USD")).toEqual([]);
    expect(buildPriceFilter(0, 0, "USD")).toEqual(["price:[..0]", "priceCurrency:USD"]);
  });
});

describe("buildBrowseFilter", () => {
  it("searches Buy It Now listings located anywhere in the country by default, even with a postal code", () => {
    expect(buildBrowseFilter(query({ minPriceCents: 20_000, maxPriceCents: 45_000 }), "CAD")).toBe(
      "price:[200..450],priceCurrency:CAD,buyingOptions:{FIXED_PRICE|BEST_OFFER},itemLocationCountry:CA",
    );
  });

  it("includes auctions only when asked to", () => {
    expect(buildBrowseFilter(query(), "CAD", { includeAuctions: true })).toBe(
      "buyingOptions:{FIXED_PRICE|BEST_OFFER|AUCTION},itemLocationCountry:CA",
    );
  });

  it("uses local pickup around the postal code in pickup-only mode", () => {
    expect(buildBrowseFilter(query({ minPriceCents: 20_000, maxPriceCents: 45_000 }), "CAD", { localPickupOnly: true })).toBe(
      "price:[200..450],priceCurrency:CAD,buyingOptions:{FIXED_PRICE|BEST_OFFER}," +
        "deliveryOptions:{SELLER_ARRANGED_LOCAL_PICKUP},pickupCountry:CA,pickupPostalCode:V6B1A1," +
        "pickupRadius:40,pickupRadiusUnit:km",
    );
  });

  it("falls back to the item location country in pickup-only mode without a postal code", () => {
    const q = query({ location: { ...vancouver, countryCode: "us", postalCode: null } });
    expect(buildBrowseFilter(q, "USD", { localPickupOnly: true })).toBe("buyingOptions:{FIXED_PRICE|BEST_OFFER},itemLocationCountry:US");
  });

  it("rounds the pickup radius and never sends 0", () => {
    const pickup = { localPickupOnly: true };
    expect(buildBrowseFilter(query({ location: { ...vancouver, radiusKm: 0.2 } }), "CAD", pickup)).toContain("pickupRadius:1,");
    expect(buildBrowseFilter(query({ location: { ...vancouver, radiusKm: 32.6 } }), "CAD", pickup)).toContain("pickupRadius:33,");
  });

  it("strips characters that could break the filter grammar from postal codes", () => {
    expect(normalizePostalCode(" 98101-1234 ")).toBe("98101-1234");
    expect(normalizePostalCode("v6b,1a1}|")).toBe("V6B1A1");
    expect(normalizePostalCode("  ")).toBeNull();
    expect(normalizePostalCode(null)).toBeNull();
  });
});

describe("buildBrowseSearchUrl", () => {
  it("builds the exact item_summary/search URL", () => {
    const url = buildBrowseSearchUrl(query({ maxPriceCents: 45_000, category: "video_games", limit: 25 }), "EBAY_CA", "CAD");
    expect(url).toBe(
      "https://api.ebay.com/buy/browse/v1/item_summary/search?q=ps5%20console&limit=25&sort=newlyListed" +
        "&category_ids=1249&filter=price%3A%5B..450%5D%2CpriceCurrency%3ACAD%2CbuyingOptions%3A%7BFIXED_PRICE%7CBEST_OFFER%7D" +
        "%2CitemLocationCountry%3ACA",
    );
    const parsed = new URL(url);
    expect(parsed.searchParams.get("q")).toBe("ps5 console");
    expect(parsed.searchParams.get("filter")).toContain("buyingOptions:{FIXED_PRICE|BEST_OFFER}");
  });

  it("passes the search options through to the filter", () => {
    const url = new URL(buildBrowseSearchUrl(query(), "EBAY_CA", "CAD", { includeAuctions: true, localPickupOnly: true }));
    expect(url.searchParams.get("filter")).toBe(
      "buyingOptions:{FIXED_PRICE|BEST_OFFER|AUCTION},deliveryOptions:{SELLER_ARRANGED_LOCAL_PICKUP}," +
        "pickupCountry:CA,pickupPostalCode:V6B1A1,pickupRadius:40,pickupRadiusUnit:km",
    );
    expect(url.searchParams.get("sort")).toBe("newlyListed");
  });

  it("encodes eBay query syntax and omits category_ids for 'any' and unmapped marketplaces", () => {
    const url = new URL(buildBrowseSearchUrl(query({ keywords: "(ps5, xbox) -broken & more", category: "any" }), "EBAY_US", "USD"));
    expect(url.searchParams.get("q")).toBe("(ps5, xbox) -broken & more");
    expect(url.searchParams.has("category_ids")).toBe(false);
    const gb = new URL(buildBrowseSearchUrl(query({ category: "phones" }), "EBAY_GB", "GBP"));
    expect(gb.searchParams.has("category_ids")).toBe(false);
  });

  it("omits q for a category-only search", () => {
    const url = new URL(buildBrowseSearchUrl(query({ keywords: "  ", category: "bikes" }), "EBAY_US", "USD"));
    expect(url.searchParams.has("q")).toBe(false);
    expect(url.searchParams.get("category_ids")).toBe("177831");
  });

  it("clamps the limit to eBay's 1..200 range with a default of 50", () => {
    expect(clampLimit(undefined)).toBe(50);
    expect(clampLimit(500)).toBe(200);
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(Number.NaN)).toBe(50);
  });
});

describe("headers", () => {
  it("URL-encodes the end-user context the way eBay documents it", () => {
    expect(buildEndUserContext(vancouver)).toBe("contextualLocation=country%3DCA%2Czip%3DV6B1A1");
    expect(buildEndUserContext({ ...vancouver, countryCode: "US", postalCode: undefined })).toBe(
      "contextualLocation=country%3DUS",
    );
  });

  it("sends the bearer token and marketplace id", () => {
    expect(buildBrowseHeaders("tok", "EBAY_CA", vancouver)).toEqual({
      Authorization: "Bearer tok",
      Accept: "application/json",
      "X-EBAY-C-MARKETPLACE-ID": "EBAY_CA",
      "X-EBAY-C-ENDUSERCTX": "contextualLocation=country%3DCA%2Czip%3DV6B1A1",
    });
  });
});

describe("buildEbayPublicSearchUrl", () => {
  it("links to the local eBay site: newly listed Buy It Now items located in the country", () => {
    expect(buildEbayPublicSearchUrl(query({ minPriceCents: 10_050, maxPriceCents: 40_000 }), "EBAY_CA")).toBe(
      "https://www.ebay.ca/sch/i.html?_nkw=ps5+console&_sop=10&_udlo=100&_udhi=400&LH_BIN=1&LH_PrefLoc=1",
    );
    const seattle = { ...vancouver, countryCode: "US", postalCode: "98101" };
    expect(buildEbayPublicSearchUrl(query({ category: "video_games", location: seattle }), "EBAY_US")).toBe(
      "https://www.ebay.com/sch/i.html?_nkw=ps5+console&_sop=10&_sacat=1249&LH_BIN=1&LH_PrefLoc=1",
    );
  });

  it("does not restrict to the site's country when it is not the search's", () => {
    expect(buildEbayPublicSearchUrl(query(), "EBAY_US")).toBe("https://www.ebay.com/sch/i.html?_nkw=ps5+console&_sop=10&LH_BIN=1");
  });

  it("includes auctions when the API search does", () => {
    expect(buildEbayPublicSearchUrl(query(), "EBAY_CA", { includeAuctions: true })).toBe(
      "https://www.ebay.ca/sch/i.html?_nkw=ps5+console&_sop=10&LH_PrefLoc=1",
    );
  });

  it("searches local pickup around the postal code in pickup-only mode, in the site's distance unit", () => {
    expect(buildEbayPublicSearchUrl(query(), "EBAY_CA", { localPickupOnly: true })).toBe(
      "https://www.ebay.ca/sch/i.html?_nkw=ps5+console&_sop=10&LH_BIN=1&LH_LPickup=1&_stpos=V6B1A1&_sadis=40",
    );
    const seattle = { ...vancouver, countryCode: "US", postalCode: "98101" };
    const url = new URL(buildEbayPublicSearchUrl(query({ location: seattle }), "EBAY_US", { localPickupOnly: true }));
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ LH_LPickup: "1", _stpos: "98101", _sadis: "25" });
    // Without a postal code there is nothing to pick up around: same as the API's country fallback.
    const noPostal = buildEbayPublicSearchUrl(query({ location: { ...vancouver, postalCode: null } }), "EBAY_CA", { localPickupOnly: true });
    expect(noPostal).toBe("https://www.ebay.ca/sch/i.html?_nkw=ps5+console&_sop=10&LH_BIN=1&LH_PrefLoc=1");
  });
});
