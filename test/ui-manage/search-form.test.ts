import { describe, expect, it } from "vitest";
import {
  CUSTOM_LOCATION,
  POLL_INTERVALS,
  defaultFormValues,
  effectivePollInterval,
  fieldForIssuePath,
  matchPreset,
  normalizeTerms,
  parseMoney,
  parseSearchForm,
  prefillFromSearchParams,
  searchToFormValues,
  type SearchFormValues,
} from "@/components/searches/form-values";
import { SEARCH_TEMPLATES, templateHref } from "@/components/searches/templates";
import type { Search } from "@/lib/db/schema";
import { ebayQuotaFloorSec } from "@/lib/engine/ebay-quota";
import { DEFAULT_LOCATION, LOCATION_PRESETS, findPreset } from "@/lib/locations";
import { listAdapters } from "@/lib/marketplaces/registry";
import { searchInputSchema } from "@/lib/search-schema";

function values(overrides: Partial<SearchFormValues> = {}): SearchFormValues {
  return { ...defaultFormValues(DEFAULT_LOCATION, ["craigslist", "kijiji"]), name: "PS5", query: "ps5", ...overrides };
}

function expectOk(raw: unknown) {
  const result = parseSearchForm(raw);
  if (!result.ok) throw new Error(`Expected valid form, got ${JSON.stringify(result.errors)}`);
  // Whatever we produce must satisfy the shared schema as-is.
  expect(searchInputSchema.safeParse(result.input).success).toBe(true);
  return result.input;
}

function expectErrors(raw: unknown) {
  const result = parseSearchForm(raw);
  if (result.ok) throw new Error("Expected validation errors");
  return result.errors;
}

describe("parseSearchForm", () => {
  it("converts dollar strings to cents", () => {
    const input = expectOk(values({ minPrice: "$1,250.50", maxPrice: "2000", expectedResale: " 49.9 " }));
    expect(input.minPriceCents).toBe(125_050);
    expect(input.maxPriceCents).toBe(200_000);
    expect(input.expectedResaleCents).toBe(4_990);
  });

  it("treats blank prices as no limit and 0 as free", () => {
    const input = expectOk(values({ minPrice: "", maxPrice: "0" }));
    expect(input.minPriceCents).toBeNull();
    expect(input.maxPriceCents).toBe(0);
  });

  it("reports malformed or inverted prices on the right fields", () => {
    expect(expectErrors(values({ minPrice: "-5", maxPrice: "abc" }))).toMatchObject({
      minPrice: expect.stringContaining("amount"),
      maxPrice: expect.stringContaining("amount"),
    });
    expect(expectErrors(values({ minPrice: "500", maxPrice: "100" }))).toEqual({
      maxPrice: "Min price must be less than or equal to max price",
    });
    expect(expectErrors(values({ maxPrice: "2000000" })).maxPrice).toMatch(/1,000,000/);
  });

  it("normalizes exclude chips", () => {
    const input = expectOk(values({ excludeTerms: [" broken ", "-parts", '"box only"', "Broken", "", "for   parts"] }));
    expect(input.excludeTerms).toEqual(["broken", "parts", "box only", "for parts"]);
  });

  it("rejects overlong exclude terms", () => {
    expect(expectErrors(values({ excludeTerms: ["x".repeat(61)] })).excludeTerms).toMatch(/60 characters/);
  });

  it("resolves presets on the server and applies the radius", () => {
    const calgary = findPreset("Calgary, AB")!;
    const input = expectOk(
      values({
        locationPreset: calgary.label,
        // Whatever the client claims about coordinates is ignored for presets.
        location: { ...defaultFormValues(DEFAULT_LOCATION).location, lat: "0", lng: "0" },
        radiusKm: "75",
      }),
    );
    expect(input.location).toEqual({ ...calgary, radiusKm: 75 });
  });

  it("rejects unknown presets", () => {
    expect(expectErrors(values({ locationPreset: "Atlantis" }))).toEqual({ locationPreset: "Choose a location" });
  });

  it("builds a custom location with blank hints as null", () => {
    const input = expectOk(
      values({
        locationPreset: CUSTOM_LOCATION,
        location: {
          label: " Kelowna, BC ",
          lat: "49.888",
          lng: "-119.496",
          countryCode: "ca",
          postalCode: " ",
          craigslistSite: "Kelowna",
          facebookLocation: "",
          kijijiLocationId: "1700228",
          kijijiLocationSlug: "",
        },
        radiusKm: "25",
      }),
    );
    expect(input.location).toEqual({
      label: "Kelowna, BC",
      lat: 49.888,
      lng: -119.496,
      radiusKm: 25,
      countryCode: "CA",
      postalCode: null,
      craigslistSite: "kelowna",
      facebookLocation: null,
      kijijiLocationId: "1700228",
      kijijiLocationSlug: null,
    });
  });

  it("reports custom location problems per field", () => {
    const base = defaultFormValues(DEFAULT_LOCATION).location;
    const errors = expectErrors(
      values({
        locationPreset: CUSTOM_LOCATION,
        location: { ...base, label: "", lat: "north", lng: "200", countryCode: "CAN", craigslistSite: "not a site!", kijijiLocationId: "abc" },
        radiusKm: "0",
      }),
    );
    expect(Object.keys(errors).sort()).toEqual(
      [
        "location.countryCode",
        "location.craigslistSite",
        "location.kijijiLocationId",
        "location.label",
        "location.lat",
        "location.lng",
        "radiusKm",
      ].sort(),
    );
    expect(errors["location.craigslistSite"]).toMatch(/subdomain/);
  });

  it("maps channel selection and optional numbers", () => {
    expect(expectOk(values({ notifyChannelIds: [] })).notifyChannelIds).toBeNull();
    expect(expectOk(values({ notifyChannelIds: [3, 1, 3] })).notifyChannelIds).toEqual([3, 1]);
    expect(expectOk(values({ notifyMinDealScore: "" })).notifyMinDealScore).toBeNull();
    expect(expectOk(values({ notifyMinDealScore: "70" })).notifyMinDealScore).toBe(70);
    expect(expectErrors(values({ notifyMinDealScore: "101" })).notifyMinDealScore).toMatch(/0 to 100/);
    expect(expectErrors(values({ maxListingAgeHours: "1.5" })).maxListingAgeHours).toMatch(/whole hours/);
    expect(expectErrors(values({ pollIntervalSec: "10" })).pollIntervalSec).toMatch(/30 seconds/);
  });

  it("stores 'any category' as null and rejects unknown categories", () => {
    expect(expectOk(values({ category: "" })).category).toBeNull();
    expect(expectOk(values({ category: "furniture" })).category).toBe("furniture");
    expect(expectErrors(values({ category: "weapons" })).category).toBeDefined();
  });

  it("requires a name, query and marketplace", () => {
    expect(expectErrors(values({ name: " ", query: "", marketplaces: [] }))).toEqual({
      name: expect.stringContaining("name"),
      query: expect.stringContaining("search for"),
      marketplaces: "Pick at least one marketplace",
    });
    expect(expectErrors(values({ marketplaces: ["myspace" as never] })).marketplaces).toBeDefined();
  });

  it("rejects malformed payloads without throwing", () => {
    for (const raw of [null, undefined, "x", 42, { ...values(), marketplaces: "craigslist" }, { ...values(), location: null }]) {
      expect(expectErrors(raw)).toHaveProperty("form");
    }
  });
});

describe("form helpers", () => {
  it("parses money strictly", () => {
    expect(parseMoney("")).toBeNull();
    expect(parseMoney("400")).toBe(40_000);
    expect(parseMoney("$ 1,234.5")).toBe(123_450);
    expect(parseMoney(".99")).toBe(99);
    for (const bad of ["1,23", "12.345", "-1", "ten", "$", "1e5"]) expect(parseMoney(bad)).toBe("invalid");
  });

  it("normalizes terms case-insensitively", () => {
    expect(normalizeTerms(["A", "a", " b ", "-", '""'])).toEqual(["A", "b"]);
  });

  it("maps schema paths to form fields", () => {
    expect(fieldForIssuePath(["maxPriceCents"])).toBe("maxPrice");
    expect(fieldForIssuePath(["location", "radiusKm"])).toBe("radiusKm");
    expect(fieldForIssuePath(["location", "lat"])).toBe("location.lat");
    expect(fieldForIssuePath(["location"])).toBe("locationPreset");
    expect(fieldForIssuePath(["excludeTerms", 2])).toBe("excludeTerms");
    expect(fieldForIssuePath([])).toBe("form");
  });

  it("recognizes untouched presets but not customized ones", () => {
    const vancouver = LOCATION_PRESETS[0];
    expect(matchPreset({ ...vancouver, radiusKm: 5 })?.label).toBe(vancouver.label);
    expect(matchPreset({ ...vancouver, craigslistSite: "whistler" })).toBeUndefined();
    expect(matchPreset({ ...vancouver, lat: 1 })).toBeUndefined();
    expect(matchPreset({ ...vancouver, label: "Somewhere" })).toBeUndefined();
  });

  it("round-trips a stored search through the form", () => {
    const search: Search = {
      id: 7,
      name: "Aeron",
      query: "herman miller aeron",
      excludeTerms: ["replica"],
      titleMustMatch: true,
      minPriceCents: 5_000,
      maxPriceCents: 60_050,
      expectedResaleCents: null,
      marketplaces: ["kijiji", "craigslist"],
      location: { ...DEFAULT_LOCATION, radiusKm: 15 },
      category: "furniture",
      pollIntervalSec: 300,
      maxListingAgeHours: 48,
      notifyChannelIds: [2],
      notifyMinDealScore: 60,
      notifyMinAiScore: 70,
      notifyMinProfitPct: null,
      aiInstructions: "Only chairs I can refurbish",
      notifyPriceDrops: false,
      aiEvaluate: true,
      enabled: false,
      lastRunAt: null,
      nextRunAt: null,
      lastError: null,
      definitionChangedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const form = searchToFormValues(search);
    expect(form).toMatchObject({ minPrice: "50", maxPrice: "600.50", expectedResale: "", locationPreset: DEFAULT_LOCATION.label, radiusKm: "15" });
    const input = expectOk(form);
    expect(input).toMatchObject({
      name: "Aeron",
      minPriceCents: 5_000,
      maxPriceCents: 60_050,
      expectedResaleCents: null,
      marketplaces: ["kijiji", "craigslist"],
      location: { ...DEFAULT_LOCATION, radiusKm: 15 },
      category: "furniture",
      pollIntervalSec: 300,
      maxListingAgeHours: 48,
      notifyChannelIds: [2],
      notifyMinDealScore: 60,
      notifyMinAiScore: 70,
      notifyMinProfitPct: null,
      aiInstructions: "Only chairs I can refurbish",
      notifyPriceDrops: false,
      aiEvaluate: true,
      enabled: false,
    });
  });

  it("only offers intervals every marketplace can honour", () => {
    const fastestMarketplace = Math.min(...listAdapters().map((a) => a.minIntervalSec));
    expect(POLL_INTERVALS.map((o) => o.value)).toEqual([60, 120, 300, 600, 1800, 3600]);
    expect(POLL_INTERVALS[0].value).toBeGreaterThanOrEqual(fastestMarketplace);
  });

  it("explains when the selected marketplaces stretch the poll interval", () => {
    const craigslist = { displayName: "Craigslist", minIntervalSec: 60 };
    const offerup = { displayName: "OfferUp", minIntervalSec: 90 };
    const facebook = { displayName: "Facebook Marketplace", minIntervalSec: 120 };
    expect(effectivePollInterval(60, [craigslist], 30)).toEqual({ seconds: 60, limitedBy: [] });
    expect(effectivePollInterval(60, [craigslist, offerup, facebook], 30)).toEqual({ seconds: 120, limitedBy: ["Facebook Marketplace"] });
    expect(effectivePollInterval(60, [offerup], 30)).toEqual({ seconds: 90, limitedBy: ["OfferUp"] });
    expect(effectivePollInterval(300, [facebook], 30)).toEqual({ seconds: 300, limitedBy: [] });
    // The server floor alone is not the marketplaces' doing.
    expect(effectivePollInterval(60, [craigslist], 600)).toEqual({ seconds: 600, limitedBy: [] });
    expect(effectivePollInterval(60, [], 30)).toEqual({ seconds: 60, limitedBy: [] });
  });

  it("explains when eBay's daily quota stretches the poll interval (as the scheduler does)", () => {
    const ebay = { displayName: "eBay", minIntervalSec: 60 };
    const facebook = { displayName: "Facebook Marketplace", minIntervalSec: 120 };
    // 10 searches share the quota: ceil(86,400 × 10 / 4,500) = 192 s each.
    const quota = { floorSec: ebayQuotaFloorSec(10), searches: 10 };
    expect(quota.floorSec).toBe(192);
    expect(effectivePollInterval(60, [ebay], 30, quota)).toEqual({ seconds: 192, limitedBy: [], ebayQuotaSearches: 10 });
    expect(effectivePollInterval(300, [ebay], 30, quota)).toEqual({ seconds: 300, limitedBy: [] });
    // A slower marketplace wins over a smaller quota floor.
    expect(effectivePollInterval(60, [ebay, facebook], 30, { floorSec: ebayQuotaFloorSec(5), searches: 5 })).toEqual({
      seconds: 120,
      limitedBy: ["Facebook Marketplace"],
    });
  });

  it("uses custom mode for a non-preset default location", () => {
    const form = defaultFormValues({ ...DEFAULT_LOCATION, label: "Home", lat: 49.1 });
    expect(form.locationPreset).toBe(CUSTOM_LOCATION);
    expect(form.location.label).toBe("Home");
    expect(form.marketplaces).toEqual([]);
  });
});

describe("prefillFromSearchParams", () => {
  it("prefills from template params", () => {
    const ps5 = SEARCH_TEMPLATES.find((t) => t.id === "ps5")!;
    const params = Object.fromEntries(new URL(templateHref(ps5), "http://x").searchParams);
    const prefill = prefillFromSearchParams(params);
    expect(prefill).toMatchObject({ name: "PS5 under $400", query: "ps5", maxPrice: "400", category: "video_games" });
    expect(prefill.excludeTerms).toContain("box only");
    expect(expectOk(values(prefill)).maxPriceCents).toBe(40_000);
  });

  it("every template produces a valid search", () => {
    for (const template of SEARCH_TEMPLATES) {
      const prefill = prefillFromSearchParams(Object.fromEntries(new URL(templateHref(template), "http://x").searchParams));
      expectOk(values(prefill));
    }
  });

  it("ignores invalid values and takes the first of repeated params", () => {
    const prefill = prefillFromSearchParams({
      name: ["First", "Second"],
      q: "x".repeat(500),
      max: "cheap",
      category: "weapons",
      marketplaces: "ebay,myspace,ebay",
      strict: "yes",
    });
    expect(prefill.name).toBe("First");
    expect(prefill.query).toHaveLength(200);
    expect(prefill).not.toHaveProperty("maxPrice");
    expect(prefill).not.toHaveProperty("category");
    expect(prefill.marketplaces).toEqual(["ebay"]);
    expect(prefill).not.toHaveProperty("titleMustMatch");
    expect(prefillFromSearchParams({})).toEqual({});
  });
});
