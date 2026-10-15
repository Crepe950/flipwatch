import { describe, expect, it } from "vitest";
import { containsTerm, createListingFilter, evaluateListing, normalizeText, parseQuery, type FilterableSearch } from "../filters";

const NOW = new Date("2026-05-01T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

const baseSearch: FilterableSearch = {
  query: "ps5",
  excludeTerms: [],
  titleMustMatch: false,
  minPriceCents: null,
  maxPriceCents: null,
  location: { lat: 49.2827, lng: -123.1207, radiusKm: 40 },
  maxListingAgeHours: 24,
};

const listing = (overrides: Partial<Parameters<typeof evaluateListing>[0]> = {}) => ({
  title: "PS5 Disc Edition",
  description: "Barely used, comes with one controller.",
  priceCents: 40_000,
  currency: "CAD",
  lat: null,
  lng: null,
  postedAt: hoursAgo(1),
  ...overrides,
});

describe("normalizeText", () => {
  it("lowercases, strips diacritics and collapses punctuation/whitespace", () => {
    expect(normalizeText("  Crème BRÛLÉE -- Torch!!  ")).toBe("creme brulee torch");
    expect(normalizeText("Men's  Nike\tAir-Max 90")).toBe("mens nike air max 90");
    expect(normalizeText("Ñandú ÅNGSTRÖM")).toBe("nandu angstrom");
  });

  it("handles empty and nullish input", () => {
    expect(normalizeText("")).toBe("");
    expect(normalizeText(null)).toBe("");
    expect(normalizeText(undefined)).toBe("");
    expect(normalizeText("!!! ???")).toBe("");
  });

  it("keeps non-latin letters and digits", () => {
    expect(normalizeText("ソニー PS5")).toBe("ソニー ps5");
  });
});

describe("parseQuery", () => {
  it("extracts negative words and phrases and removes them from the marketplace query", () => {
    expect(parseQuery('ps5 -broken -"for parts"')).toEqual({
      marketplaceQuery: "ps5",
      requiredGroups: [["ps5"]],
      excludeTerms: ["broken", "for parts"],
    });
  });

  it("keeps positive phrases quoted for marketplaces and as one required term", () => {
    const parsed = parseQuery('"air max" 90 -kids');
    expect(parsed.marketplaceQuery).toBe('"air max" 90');
    expect(parsed.requiredGroups).toEqual([["air max", "90"]]);
    expect(parsed.excludeTerms).toEqual(["kids"]);
  });

  it("does not treat inner hyphens or inch marks as operators", () => {
    const parsed = parseQuery('t-shirt 55" tv');
    expect(parsed.marketplaceQuery).toBe('t-shirt 55" tv');
    expect(parsed.excludeTerms).toEqual([]);
    expect(parsed.requiredGroups).toEqual([["t", "shirt", "55", "tv"]]);
  });

  it("tolerates a lone dash, empty quotes, unterminated quotes and smart quotes", () => {
    expect(parseQuery("ps5 - ").marketplaceQuery).toBe("ps5");
    expect(parseQuery('ps5 ""').requiredGroups).toEqual([["ps5"]]);
    expect(parseQuery('ps5 -"for parts').excludeTerms).toEqual(["for parts"]);
    expect(parseQuery("ps5 -“for parts”").excludeTerms).toEqual(["for parts"]);
  });

  it("passes OR operators through, splitting the required terms into alternatives, and skips filler words", () => {
    const parsed = parseQuery("table and chairs OR bench");
    expect(parsed.marketplaceQuery).toBe("table and chairs OR bench");
    expect(parsed.requiredGroups).toEqual([["table", "chairs"], ["bench"]]);
    expect(parseQuery("ps5 | xbox AND console").requiredGroups).toEqual([["ps5"], ["xbox", "console"]]);
  });

  it("treats a bar inside a word as an alternative without changing the marketplace query", () => {
    const parsed = parseQuery("ps5|xbox -broken");
    expect(parsed.marketplaceQuery).toBe("ps5|xbox");
    expect(parsed.requiredGroups).toEqual([["ps5"], ["xbox"]]);
    expect(parseQuery("OR ps5 | | switch OR").requiredGroups).toEqual([["ps5"], ["switch"]]);
  });

  it("handles an all-negative or empty query", () => {
    expect(parseQuery("-broken")).toEqual({ marketplaceQuery: "", requiredGroups: [], excludeTerms: ["broken"] });
    expect(parseQuery("   ")).toEqual({ marketplaceQuery: "", requiredGroups: [], excludeTerms: [] });
  });

  it("de-duplicates terms", () => {
    expect(parseQuery("PS5 ps5 -Broken -broken").requiredGroups).toEqual([["ps5"]]);
    expect(parseQuery("PS5 ps5 -Broken -broken").excludeTerms).toEqual(["broken"]);
  });
});

describe("containsTerm", () => {
  const words = (s: string) => normalizeText(s).split(" ");

  it("matches whole words only", () => {
    expect(containsTerm(words("broken screen"), "broken")).toBe(true);
    expect(containsTerm(words("unbroken seal"), "broken")).toBe(false);
    expect(containsTerm(words("sold as is"), "as is")).toBe(true);
    expect(containsTerm(words("has issues"), "as is")).toBe(false);
  });

  it("tolerates simple plurals in both directions", () => {
    expect(containsTerm(words("4 dining chairs"), "chair")).toBe(true);
    expect(containsTerm(words("dining chair"), "chairs")).toBe(true);
    expect(containsTerm(words("moving boxes"), "box")).toBe(true);
    expect(containsTerm(words("spare batteries"), "battery")).toBe(true);
    expect(containsTerm(words("two tvs"), "tv")).toBe(true);
  });

  it("does not stretch plural tolerance to model numbers or odd stems", () => {
    expect(containsTerm(words("iphone 4s"), "iphone 4")).toBe(false);
    expect(containsTerm(words("ice cubes"), "cub")).toBe(false);
    expect(containsTerm(words("who cares"), "car")).toBe(false);
  });
});

describe("evaluateListing", () => {
  it("passes a plain listing", () => {
    expect(evaluateListing(listing(), baseSearch, NOW)).toEqual({ pass: true, stale: false });
  });

  describe("price bounds", () => {
    const bounded = { ...baseSearch, minPriceCents: 20_000, maxPriceCents: 45_000 };

    it("accepts prices inside the inclusive range", () => {
      expect(evaluateListing(listing({ priceCents: 20_000 }), bounded, NOW).pass).toBe(true);
      expect(evaluateListing(listing({ priceCents: 45_000 }), bounded, NOW).pass).toBe(true);
    });

    it("rejects prices outside the range with a readable reason", () => {
      const low = evaluateListing(listing({ priceCents: 19_999 }), bounded, NOW);
      expect(low.pass).toBe(false);
      expect(low.reason).toMatch(/below the minimum/);
      const high = evaluateListing(listing({ priceCents: 45_001 }), bounded, NOW);
      expect(high.reason).toMatch(/above the maximum \$450/);
    });

    it("rejects a missing price when any bound is set, including min 0", () => {
      expect(evaluateListing(listing({ priceCents: null }), bounded, NOW).reason).toBe("No price listed");
      expect(evaluateListing(listing({ priceCents: null }), { ...baseSearch, minPriceCents: 0 }, NOW).pass).toBe(false);
      expect(evaluateListing(listing({ priceCents: null }), { ...baseSearch, maxPriceCents: 100 }, NOW).pass).toBe(false);
    });

    it("accepts a missing price when there are no bounds", () => {
      expect(evaluateListing(listing({ priceCents: null }), baseSearch, NOW).pass).toBe(true);
    });

    it("treats free (0) as passing min 0 but failing a positive min", () => {
      expect(evaluateListing(listing({ priceCents: 0 }), { ...baseSearch, minPriceCents: 0 }, NOW).pass).toBe(true);
      expect(evaluateListing(listing({ priceCents: 0 }), { ...baseSearch, maxPriceCents: 0 }, NOW).pass).toBe(true);
      expect(evaluateListing(listing({ priceCents: 0 }), { ...baseSearch, minPriceCents: 1 }, NOW).pass).toBe(false);
    });
  });

  describe("exclude terms", () => {
    it("rejects whole-word matches in title or description (search terms and query negatives)", () => {
      const search = { ...baseSearch, query: 'ps5 -"for parts"', excludeTerms: ["Broken"] };
      expect(evaluateListing(listing({ title: "PS5 BROKEN hdmi" }), search, NOW).reason).toBe('Contains excluded term "broken"');
      expect(evaluateListing(listing({ description: "Selling for parts only." }), search, NOW).reason).toBe(
        'Contains excluded term "for parts"',
      );
    });

    it("checks title: terms against the title only", () => {
      const search = { ...baseSearch, query: "rtx", excludeTerms: ["title:pc", "Title: gaming laptop", "broken"] };
      const card = listing({ title: "RTX 3070 8GB", description: "Pulled from my gaming PC, works great." });
      expect(evaluateListing(card, search, NOW).pass).toBe(true);
      expect(evaluateListing(listing({ title: "Gaming PC RTX 3070" }), search, NOW).reason).toBe('Title contains excluded term "pc"');
      expect(evaluateListing(listing({ title: "ASUS gaming laptop RTX 3060" }), search, NOW).reason).toBe('Title contains excluded term "gaming laptop"');
      expect(evaluateListing(listing({ title: "RTX 3070", description: "fan is broken" }), search, NOW).pass).toBe(false);
    });

    it("does not match inside other words", () => {
      const search = { ...baseSearch, excludeTerms: ["box"] };
      expect(evaluateListing(listing({ title: "PS5 Xbox bundle" }), search, NOW).pass).toBe(true);
      expect(evaluateListing(listing({ title: "PS5 empty boxes" }), search, NOW).pass).toBe(false);
    });

    it("normalizes accents and punctuation on both sides", () => {
      const search = { ...baseSearch, excludeTerms: ["réplica"] };
      expect(evaluateListing(listing({ title: "PS5 (REPLICA!)" }), search, NOW).pass).toBe(false);
    });

    it("ignores blank exclude terms", () => {
      const search = { ...baseSearch, excludeTerms: ["", "  ", "!!"] };
      expect(evaluateListing(listing(), search, NOW).pass).toBe(true);
    });
  });

  describe("titleMustMatch", () => {
    const strict = { ...baseSearch, query: "herman miller chair -kids", titleMustMatch: true };

    it("requires every positive term in the title, with plural tolerance", () => {
      expect(evaluateListing(listing({ title: "Herman Miller Aeron Chairs x2" }), strict, NOW).pass).toBe(true);
      const miss = evaluateListing(listing({ title: "Aeron chair", description: "herman miller" }), strict, NOW);
      expect(miss.pass).toBe(false);
      expect(miss.reason).toBe('Title is missing "herman"');
    });

    it("requires phrases to appear in order", () => {
      const phrase = { ...baseSearch, query: '"air max"', titleMustMatch: true };
      expect(evaluateListing(listing({ title: "Nike Air Max 90" }), phrase, NOW).pass).toBe(true);
      expect(evaluateListing(listing({ title: "Max Air cushion" }), phrase, NOW).pass).toBe(false);
    });

    it("is not applied when disabled", () => {
      expect(evaluateListing(listing({ title: "Aeron" }), { ...strict, titleMustMatch: false }, NOW).pass).toBe(true);
    });

    it("passes a title matching any OR / | alternative", () => {
      const either = { ...baseSearch, query: "ps5 OR xbox series", titleMustMatch: true };
      expect(evaluateListing(listing({ title: "PS5 Disc Edition" }), either, NOW).pass).toBe(true);
      expect(evaluateListing(listing({ title: "Xbox Series X" }), either, NOW).pass).toBe(true);
      const neither = evaluateListing(listing({ title: "Xbox One" }), either, NOW);
      expect(neither).toMatchObject({ pass: false, reason: 'Title matches none of "ps5", "xbox series"' });

      const bar = { ...baseSearch, query: "aeron|embody chair", titleMustMatch: true };
      expect(evaluateListing(listing({ title: "Herman Miller Aeron" }), bar, NOW).pass).toBe(true);
      expect(evaluateListing(listing({ title: "Embody gaming chair" }), bar, NOW).pass).toBe(true);
      expect(evaluateListing(listing({ title: "Embody" }), bar, NOW).pass).toBe(false);
    });
  });

  describe("free category", () => {
    const free = { ...baseSearch, category: "free" };

    it("only passes free or unpriced listings, whatever the marketplace returned", () => {
      expect(evaluateListing(listing({ priceCents: 0 }), free, NOW).pass).toBe(true);
      expect(evaluateListing(listing({ priceCents: null }), free, NOW).pass).toBe(true);
      expect(evaluateListing(listing({ priceCents: 2_500 }), free, NOW)).toMatchObject({ pass: false, reason: "Not free ($25)" });
      expect(evaluateListing(listing({ priceCents: 2_500 }), { ...free, category: "furniture" }, NOW).pass).toBe(true);
    });

    it("keeps unpriced free posts even when the search also sets a $0 maximum", () => {
      const freeWithMax = { ...free, maxPriceCents: 0 };
      expect(evaluateListing(listing({ priceCents: null }), freeWithMax, NOW).pass).toBe(true);
      expect(evaluateListing(listing({ priceCents: 0 }), freeWithMax, NOW).pass).toBe(true);
      expect(evaluateListing(listing({ priceCents: 100 }), freeWithMax, NOW).pass).toBe(false);
    });
  });

  describe("distance", () => {
    it("rejects listings further than radius × 1.25", () => {
      // Seattle is ~190 km from Vancouver.
      const result = evaluateListing(listing({ lat: 47.6062, lng: -122.3321 }), baseSearch, NOW);
      expect(result.pass).toBe(false);
      expect(result.reason).toMatch(/km away \(search radius 40 km\)/);
    });

    it("allows the 25% tolerance", () => {
      // ~45 km east of downtown Vancouver: outside 40 km, inside 50 km.
      expect(evaluateListing(listing({ lat: 49.2827, lng: -122.5 }), baseSearch, NOW).pass).toBe(true);
    });

    it("ignores missing, invalid or (0, 0) coordinates", () => {
      expect(evaluateListing(listing({ lat: null, lng: null }), baseSearch, NOW).pass).toBe(true);
      expect(evaluateListing(listing({ lat: 0, lng: 0 }), baseSearch, NOW).pass).toBe(true);
      expect(evaluateListing(listing({ lat: Number.NaN, lng: 5 }), baseSearch, NOW).pass).toBe(true);
      expect(evaluateListing(listing({ lat: 49.2, lng: undefined }), baseSearch, NOW).pass).toBe(true);
    });
  });

  describe("staleness", () => {
    it("flags listings older than maxListingAgeHours without rejecting them", () => {
      expect(evaluateListing(listing({ postedAt: hoursAgo(25) }), baseSearch, NOW)).toEqual({ pass: true, stale: true });
      expect(evaluateListing(listing({ postedAt: hoursAgo(23) }), baseSearch, NOW).stale).toBe(false);
    });

    it("reports staleness on rejected listings too", () => {
      const result = evaluateListing(listing({ postedAt: hoursAgo(48), priceCents: 1 }), { ...baseSearch, minPriceCents: 10 }, NOW);
      expect(result).toMatchObject({ pass: false, stale: true });
    });

    it("treats unknown, invalid or future dates as fresh", () => {
      expect(evaluateListing(listing({ postedAt: null }), baseSearch, NOW).stale).toBe(false);
      expect(evaluateListing(listing({ postedAt: new Date("nope") }), baseSearch, NOW).stale).toBe(false);
      expect(evaluateListing(listing({ postedAt: new Date(NOW.getTime() + 3_600_000) }), baseSearch, NOW).stale).toBe(false);
    });
  });

  it("createListingFilter reuses compiled rules across listings", () => {
    const filter = createListingFilter({ ...baseSearch, excludeTerms: ["broken"] });
    expect(filter(listing(), NOW).pass).toBe(true);
    expect(filter(listing({ title: "broken ps5" }), NOW).pass).toBe(false);
  });
});
