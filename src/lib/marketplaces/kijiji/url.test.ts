import { describe, expect, it } from "vitest";
import { findPreset } from "../../locations";
import { CATEGORIES, type SearchLocation, type SearchQuery } from "../../types";
import { buildKijijiSearchUrl, KIJIJI_CATEGORIES, kijijiLocation, kijijiSlug } from "./url";

const toronto = findPreset("Toronto, ON")!;

function query(overrides: Partial<SearchQuery> = {}, location: Partial<SearchLocation> = {}): SearchQuery {
  return { keywords: "ps5", location: { ...toronto, ...location }, ...overrides };
}

const pathOf = (url: string) => new URL(url).pathname;
const params = (url: string) => Object.fromEntries(new URL(url).searchParams);

describe("buildKijijiSearchUrl", () => {
  it("builds the category + location + keyword URL with radius, address and coordinates", () => {
    expect(buildKijijiSearchUrl(query({ category: "video_games" }))).toBe(
      "https://www.kijiji.ca/b-video-games-consoles/city-of-toronto/ps5/k0c141l1700273?sort=dateDesc&radius=40&address=Toronto%2C+ON&ll=43.6532%2C-79.3832",
    );
  });

  it("uses the category-less form for any category", () => {
    expect(pathOf(buildKijijiSearchUrl(query()))).toBe("/b-city-of-toronto/ps5/k0l1700273");
    expect(pathOf(buildKijijiSearchUrl(query({ category: "any" })))).toBe("/b-city-of-toronto/ps5/k0l1700273");
  });

  it.each([
    ["electronics", "/b-electronics/city-of-toronto/ps5/k0c15l1700273"],
    ["computers", "/b-computer/city-of-toronto/ps5/k0c16l1700273"],
    ["phones", "/b-cell-phone/city-of-toronto/ps5/k0c760l1700273"],
    ["video_games", "/b-video-games-consoles/city-of-toronto/ps5/k0c141l1700273"],
    ["furniture", "/b-furniture/city-of-toronto/ps5/k0c235l1700273"],
    ["appliances", "/b-appliance/city-of-toronto/ps5/k0c107l1700273"],
    ["tools", "/b-tool/city-of-toronto/ps5/k0c110l1700273"],
    ["bikes", "/b-bikes/city-of-toronto/ps5/k0c644l1700273"],
    ["sporting_goods", "/b-sporting-goods-exercise/city-of-toronto/ps5/k0c111l1700273"],
    ["cars_trucks", "/b-cars-trucks/city-of-toronto/ps5/k0c174l1700273"],
    ["motorcycles", "/b-motorcycles/city-of-toronto/ps5/k0c30l1700273"],
    ["boats", "/b-boats-watercraft/city-of-toronto/ps5/k0c29l1700273"],
    ["rvs_campers", "/b-rv-camper-trailer/city-of-toronto/ps5/k0c301l1700273"],
    ["trailers", "/b-rv-camper-trailer/city-of-toronto/ps5/k0c301l1700273"],
    ["free", "/b-free-stuff/city-of-toronto/ps5/k0c17220001l1700273"],
  ] as const)("maps category %s", (category, expected) => {
    expect(pathOf(buildKijijiSearchUrl(query({ category })))).toBe(expected);
  });

  it("sends no price bound for the native free-stuff category", () => {
    expect(params(buildKijijiSearchUrl(query({ category: "free", maxPriceCents: 0 })))).not.toHaveProperty("price");
  });

  it("maps every category", () => {
    for (const category of CATEGORIES) expect(category in KIJIJI_CATEGORIES).toBe(true);
  });

  it("sends whole-dollar price bounds and leaves an open bound empty", () => {
    expect(params(buildKijijiSearchUrl(query({ minPriceCents: 10_000, maxPriceCents: 45_050 }))).price).toBe("100__451");
    expect(params(buildKijijiSearchUrl(query({ minPriceCents: 10_000 }))).price).toBe("100__");
    expect(params(buildKijijiSearchUrl(query({ maxPriceCents: 30_000 }))).price).toBe("__300");
    expect(params(buildKijijiSearchUrl(query({ minPriceCents: 0, maxPriceCents: 0 }))).price).toBe("__0");
    expect(params(buildKijijiSearchUrl(query({ minPriceCents: null, maxPriceCents: null })))).not.toHaveProperty("price");
  });

  it("falls back to Canada-wide with coordinates and radius when the location has no Kijiji id", () => {
    const url = buildKijijiSearchUrl(
      query({ category: "bikes" }, { label: "Squamish, BC", lat: 49.7016, lng: -123.1558, radiusKm: 25, kijijiLocationId: null, kijijiLocationSlug: null }),
    );
    expect(url).toBe("https://www.kijiji.ca/b-bikes/canada/ps5/k0c644l0?sort=dateDesc&radius=25&address=Squamish%2C+BC&ll=49.7016%2C-123.1558");
    expect(pathOf(buildKijijiSearchUrl(query({}, { kijijiLocationId: "" })))).toBe("/b-canada/ps5/k0l0");
  });

  it("drops the keyword segment and k0 prefix for blank keywords", () => {
    expect(pathOf(buildKijijiSearchUrl(query({ keywords: "  ", category: "furniture" })))).toBe("/b-furniture/city-of-toronto/c235l1700273");
    expect(pathOf(buildKijijiSearchUrl(query({ keywords: "" })))).toBe("/b-city-of-toronto/l1700273");
  });

  it("slugs keywords safely", () => {
    expect(pathOf(buildKijijiSearchUrl(query({ keywords: "PS5 Pro + 2TB / Sealed!" })))).toBe("/b-city-of-toronto/ps5-pro-2tb-sealed/k0l1700273");
    expect(pathOf(buildKijijiSearchUrl(query({ keywords: "../../admin?x=1#y" })))).toBe("/b-city-of-toronto/admin-x-1-y/k0l1700273");
  });
});

describe("kijijiSlug", () => {
  it("lowercases, folds accents and hyphenates", () => {
    expect(kijijiSlug("Vélo Électrique  Neuf")).toBe("velo-electrique-neuf");
    expect(kijijiSlug("  --Trek--Marlin 7--  ")).toBe("trek-marlin-7");
    expect(kijijiSlug("!!!")).toBe("");
  });

  it("keeps non-Latin letters, percent-encoded", () => {
    expect(kijijiSlug("iPhone 手机")).toBe(`iphone-${encodeURIComponent("手机")}`);
  });
});

describe("kijijiLocation", () => {
  it("uses the configured id and slug", () => {
    expect(kijijiLocation(toronto)).toEqual({ slug: "city-of-toronto", id: "1700273" });
  });

  it("derives a slug from the label when only the id is known", () => {
    expect(kijijiLocation({ ...toronto, kijijiLocationSlug: null })).toEqual({ slug: "toronto-on", id: "1700273" });
  });

  it("goes Canada-wide for a missing or non-numeric id", () => {
    expect(kijijiLocation({ ...toronto, kijijiLocationId: null })).toEqual({ slug: "canada", id: "0" });
    expect(kijijiLocation({ ...toronto, kijijiLocationId: "abc" })).toEqual({ slug: "canada", id: "0" });
  });
});
