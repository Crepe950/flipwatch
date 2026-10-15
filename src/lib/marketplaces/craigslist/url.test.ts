import { describe, expect, it } from "vitest";
import { findPreset, LOCATION_PRESETS } from "../../locations";
import { CATEGORIES, type SearchLocation, type SearchQuery } from "../../types";
import { NotConfiguredError } from "../types";
import { CRAIGSLIST_SITES, findCraigslistSite, nearestCraigslistSite } from "./sites";
import { buildCraigslistSearchUrl, CRAIGSLIST_CATEGORY_CODES, resolveCraigslistSite } from "./url";

const vancouver = findPreset("Vancouver, BC")!;
const seattle = findPreset("Seattle, WA")!;

function query(overrides: Partial<SearchQuery> = {}, location: Partial<SearchLocation> = {}): SearchQuery {
  return { keywords: "ps5", location: { ...vancouver, ...location }, ...overrides };
}

function params(url: string): Record<string, string> {
  return Object.fromEntries(new URL(url).searchParams);
}

describe("buildCraigslistSearchUrl", () => {
  it("builds the full search URL for a preset location", () => {
    expect(buildCraigslistSearchUrl(query({ category: "video_games", minPriceCents: 10_000, maxPriceCents: 50_000 }))).toBe(
      "https://vancouver.craigslist.org/search/vga?query=ps5&sort=date&bundleDuplicates=1&min_price=100&max_price=500&search_distance=25&postal=V6B1A1",
    );
  });

  it.each([
    ["any", "sss"],
    ["electronics", "ela"],
    ["computers", "sya"],
    ["phones", "moa"],
    ["video_games", "vga"],
    ["furniture", "fua"],
    ["appliances", "ppa"],
    ["tools", "tla"],
    ["bikes", "bia"],
    ["sporting_goods", "sga"],
    ["cars_trucks", "cta"],
    ["motorcycles", "mca"],
    ["boats", "boo"],
    ["rvs_campers", "rva"],
    ["trailers", "tra"],
    ["free", "zip"],
  ] as const)("maps category %s to /search/%s", (category, code) => {
    expect(new URL(buildCraigslistSearchUrl(query({ category }))).pathname).toBe(`/search/${code}`);
  });

  it("has a code for every category", () => {
    for (const category of CATEGORIES) expect(CRAIGSLIST_CATEGORY_CODES[category]).toMatch(/^[a-z]{3}$/);
  });

  it("sends no price bounds for the native free category", () => {
    const p = params(buildCraigslistSearchUrl(query({ category: "free", minPriceCents: null, maxPriceCents: 0 })));
    expect(p).not.toHaveProperty("max_price");
    expect(p).not.toHaveProperty("min_price");
  });

  it("defaults to all for-sale when no category is given", () => {
    expect(new URL(buildCraigslistSearchUrl(query({ category: null }))).pathname).toBe("/search/sss");
  });

  it("sends whole-dollar price bounds, rounded outward, and omits missing ones", () => {
    expect(params(buildCraigslistSearchUrl(query({ minPriceCents: 9_999, maxPriceCents: 25_050 })))).toMatchObject({
      min_price: "99",
      max_price: "251",
    });
    const onlyMax = params(buildCraigslistSearchUrl(query({ minPriceCents: null, maxPriceCents: 30_000 })));
    expect(onlyMax.max_price).toBe("300");
    expect(onlyMax).not.toHaveProperty("min_price");
    const onlyMin = params(buildCraigslistSearchUrl(query({ minPriceCents: 5_000 })));
    expect(onlyMin.min_price).toBe("50");
    expect(onlyMin).not.toHaveProperty("max_price");
    expect(params(buildCraigslistSearchUrl(query({ minPriceCents: 0 })))).not.toHaveProperty("min_price");
  });

  it("converts the radius to whole miles (at least 1)", () => {
    expect(params(buildCraigslistSearchUrl(query({}, { radiusKm: 100 }))).search_distance).toBe("62");
    expect(params(buildCraigslistSearchUrl(query({}, { radiusKm: 1 }))).search_distance).toBe("1");
  });

  it("centres on the postal code (spaces removed), else on the coordinates", () => {
    expect(params(buildCraigslistSearchUrl(query({}, { postalCode: " v5k 0a1 " }))).postal).toBe("V5K0A1");
    const noPostal = params(buildCraigslistSearchUrl(query({}, { postalCode: null })));
    expect(noPostal).not.toHaveProperty("postal");
    expect(noPostal).toMatchObject({ lat: "49.2827", lon: "-123.1207", search_distance: "25" });
  });

  it("encodes keywords and collapses whitespace", () => {
    const url = buildCraigslistSearchUrl(query({ keywords: "  nintendo   switch & dock \"oled\" " }));
    expect(params(url).query).toBe('nintendo switch & dock "oled"');
    expect(url).toContain("query=nintendo+switch+%26+dock+%22oled%22");
  });

  it("omits the query parameter for blank keywords", () => {
    expect(params(buildCraigslistSearchUrl(query({ keywords: "   " })))).not.toHaveProperty("query");
  });

  it("throws NotConfiguredError when no site covers the location", () => {
    const middleOfNowhere = { craigslistSite: null, lat: 57.5, lng: -99.0, label: "Northern Manitoba" };
    expect(() => buildCraigslistSearchUrl(query({}, middleOfNowhere))).toThrow(NotConfiguredError);
  });
});

describe("resolveCraigslistSite", () => {
  it("uses the explicit site, normalised", () => {
    expect(resolveCraigslistSite({ ...seattle, craigslistSite: " Seattle " })).toEqual({
      site: "seattle",
      origin: "https://seattle.craigslist.org",
      currency: "USD",
    });
  });

  it("prices in the known site's country, falling back to the location's", () => {
    expect(resolveCraigslistSite({ ...seattle, craigslistSite: "vancouver" }).currency).toBe("CAD");
    expect(resolveCraigslistSite({ ...vancouver, craigslistSite: "sunshine" }).currency).toBe("CAD");
    expect(resolveCraigslistSite({ ...seattle, craigslistSite: "skagit" }).currency).toBe("USD");
  });

  it("rejects a site that is not a bare subdomain", () => {
    expect(() => resolveCraigslistSite({ ...vancouver, craigslistSite: "evil.com/x" })).toThrow(NotConfiguredError);
  });

  it("picks the nearest known site when none is set", () => {
    const burnaby: SearchLocation = { ...vancouver, craigslistSite: null, label: "Burnaby, BC", lat: 49.2488, lng: -122.9805 };
    expect(resolveCraigslistSite(burnaby)).toMatchObject({ site: "vancouver", currency: "CAD" });
    const tacoma: SearchLocation = { ...seattle, craigslistSite: null, label: "Tacoma, WA", lat: 47.2529, lng: -122.4443 };
    expect(resolveCraigslistSite(tacoma)).toMatchObject({ site: "seattle", currency: "USD" });
  });

  it("prefers a site in the location's own country over a nearer one across the border", () => {
    const at = (label: string, lat: number, lng: number, countryCode: string, postalCode: string): SearchLocation => ({
      label,
      lat,
      lng,
      radiusKm: 40,
      countryCode,
      postalCode,
    });
    expect(resolveCraigslistSite(at("Bellingham, WA", 48.7519, -122.4787, "US", "98225"))).toMatchObject({ site: "bellingham", currency: "USD" });
    expect(resolveCraigslistSite(at("Blaine, WA", 48.9938, -122.7471, "US", "98230"))).toMatchObject({ site: "bellingham", currency: "USD" });
    expect(resolveCraigslistSite(at("Sarnia, ON", 42.9745, -82.4066, "CA", "N7T 1A1"))).toMatchObject({ site: "sarnia", currency: "CAD" });
    expect(resolveCraigslistSite(at("Port Huron, MI", 42.9709, -82.4249, "US", "48060"))).toMatchObject({ site: "porthuron", currency: "USD" });
    expect(resolveCraigslistSite(at("Niagara Falls, NY", 43.0962, -79.0377, "US", "14301"))).toMatchObject({ site: "buffalo", currency: "USD" });
    expect(resolveCraigslistSite(at("Windsor, ON", 42.3149, -83.0364, "CA", "N9A 1A1"))).toMatchObject({ site: "windsor", currency: "CAD" });
  });

  it("falls back to a site across the border only when none at home is within 150 km", () => {
    // The Maine site's nearest point (Bangor) is ~160 km away; Fredericton, NB is ~95 km.
    const houlton: SearchLocation = { label: "Houlton, ME", lat: 46.1259, lng: -67.8403, radiusKm: 40, countryCode: "US", postalCode: "04730" };
    expect(resolveCraigslistSite(houlton)).toMatchObject({ site: "newbrunswick", currency: "CAD" });
  });

  it("maps cities with their own site to it rather than to a neighbour", () => {
    const cities: Array<[string, number, number, string]> = [
      ["Santa Barbara, CA", 34.4208, -119.6982, "santabarbara"],
      ["Palm Springs, CA", 33.8303, -116.5453, "palmsprings"],
      ["Modesto, CA", 37.6391, -120.9969, "modesto"],
      ["Ann Arbor, MI", 42.2808, -83.743, "annarbor"],
      ["Santa Cruz, CA", 36.9741, -122.0308, "sfbay"], // part of the Bay Area site
      ["West Palm Beach, FL", 26.7153, -80.0534, "miami"], // south Florida, not the nearer Treasure Coast
      ["Casper, WY", 42.8666, -106.3131, "wyoming"],
    ];
    for (const [label, lat, lng, site] of cities) {
      expect(resolveCraigslistSite({ label, lat, lng, radiusKm: 40, countryCode: "US" }).site, label).toBe(site);
    }
  });

  it("throws NotConfiguredError beyond 150 km of every known site or without coordinates", () => {
    const remote: SearchLocation = { ...vancouver, craigslistSite: null, lat: 58.8, lng: -122.7 }; // Fort Nelson, BC
    expect(() => resolveCraigslistSite(remote)).toThrow(NotConfiguredError);
    expect(() => resolveCraigslistSite({ ...vancouver, craigslistSite: "", lat: Number.NaN })).toThrow(NotConfiguredError);
  });
});

describe("site table", () => {
  it("resolves every location preset to its configured site when the hint is removed", () => {
    for (const preset of LOCATION_PRESETS) {
      expect(resolveCraigslistSite({ ...preset, craigslistSite: null }).site).toBe(preset.craigslistSite);
      expect(nearestCraigslistSite(preset)?.distanceKm).toBeLessThan(1);
    }
  });

  it("looks sites up case-insensitively, returning a site's first (canonical) entry", () => {
    expect(findCraigslistSite("Toronto")?.countryCode).toBe("CA");
    expect(findCraigslistSite("bham")?.label).toBe("Birmingham, AL");
    expect(findCraigslistSite("miami")?.label).toBe("Miami, FL");
    expect(findCraigslistSite("nowhere")).toBeUndefined();
  });

  it("only holds well-formed US and Canadian entries", () => {
    const seen = new Set<string>();
    for (const entry of CRAIGSLIST_SITES) {
      expect(entry.site).toMatch(/^[a-z]+$/);
      expect(seen.has(`${entry.site}|${entry.label}`), entry.label).toBe(false);
      seen.add(`${entry.site}|${entry.label}`);
      // Rough bounding box of the US (incl. Alaska and Hawaii) and Canada.
      expect(entry.lat, entry.label).toBeGreaterThan(18);
      expect(entry.lat, entry.label).toBeLessThan(72);
      expect(entry.lng, entry.label).toBeGreaterThan(-170);
      expect(entry.lng, entry.label).toBeLessThan(-52);
      // Canadian labels name a province or territory, US ones a state (or are regional names).
      const region = entry.label.match(/, ([A-Z]{2})(?:\/[A-Z]{2})?$/)?.[1];
      if (region) expect(["BC", "AB", "SK", "MB", "ON", "QC", "NB", "NS", "PE", "NL", "YT", "NT"].includes(region), entry.label).toBe(entry.countryCode === "CA");
    }
    expect(new Set(CRAIGSLIST_SITES.map((s) => s.site)).size).toBeGreaterThan(400);
  });
});
