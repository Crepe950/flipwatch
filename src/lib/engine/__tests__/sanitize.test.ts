import { describe, expect, it } from "vitest";
import type { ScrapedListing } from "@/lib/types";
import { LIMITS, cleanText, safeHttpUrl, sanitizeResults, sanitizeScrapedListing } from "../sanitize";

const base: ScrapedListing = {
  marketplace: "craigslist",
  externalId: "123",
  url: "https://vancouver.craigslist.org/item/123.html",
  title: "PS5",
  priceCents: 40_000,
  currency: "CAD",
  imageUrls: [],
};

describe("sanitizeScrapedListing", () => {
  it("keeps a valid listing intact and forces the marketplace id", () => {
    const result = sanitizeScrapedListing({ ...base, marketplace: "ebay" }, "craigslist", "USD");
    expect(result).toMatchObject({ ...base, marketplace: "craigslist" });
  });

  it("rejects listings without an id or with a non-http URL", () => {
    expect(sanitizeScrapedListing({ ...base, externalId: "  " }, "craigslist", "USD")).toBeNull();
    expect(sanitizeScrapedListing({ ...base, url: "javascript:alert(1)" }, "craigslist", "USD")).toBeNull();
    expect(sanitizeScrapedListing({ ...base, url: "not a url" }, "craigslist", "USD")).toBeNull();
    expect(sanitizeScrapedListing({ ...base, externalId: "x".repeat(LIMITS.externalId + 1) }, "craigslist", "USD")).toBeNull();
  });

  it("cleans and bounds text fields", () => {
    const result = sanitizeScrapedListing(
      {
        ...base,
        title: "  PS5\u0000  <b>deal</b>\n\n",
        description: "line1\r\n\r\n\r\n\r\nline2\u0007",
        sellerName: "x".repeat(500),
      },
      "craigslist",
      "USD",
    )!;
    expect(result.title).toBe("PS5 <b>deal</b>");
    expect(result.description).toBe("line1\n\nline2");
    expect(result.sellerName!.length).toBe(LIMITS.sellerName);
    expect(result.sellerName!.endsWith("…")).toBe(true);
  });

  it("falls back to a placeholder title and the country currency", () => {
    const result = sanitizeScrapedListing({ ...base, title: "   ", currency: "dollars" }, "craigslist", "CAD")!;
    expect(result.title).toBe("Untitled listing");
    expect(result.currency).toBe("CAD");
    expect(sanitizeScrapedListing({ ...base, currency: "usd" }, "craigslist", "CAD")!.currency).toBe("USD");
  });

  it("drops impossible prices and coordinates", () => {
    const result = sanitizeScrapedListing(
      { ...base, priceCents: -5, lat: 123, lng: Number.NaN, postedAt: new Date("garbage") },
      "craigslist",
      "USD",
    )!;
    expect(result.priceCents).toBeNull();
    expect(result.lat).toBeNull();
    expect(result.lng).toBeNull();
    expect(result.postedAt).toBeNull();
    expect(sanitizeScrapedListing({ ...base, priceCents: 3e9 }, "craigslist", "USD")!.priceCents).toBeNull();
    expect(sanitizeScrapedListing({ ...base, priceCents: 1234.6 }, "craigslist", "USD")!.priceCents).toBe(1235);
  });

  it("keeps only http(s) image URLs, de-duplicated and capped", () => {
    const urls = ["https://img/1.jpg", "data:image/png;base64,xx", "https://img/1.jpg", ...Array.from({ length: 30 }, (_, i) => `https://img/${i + 2}.jpg`)];
    const result = sanitizeScrapedListing({ ...base, imageUrls: urls }, "craigslist", "USD")!;
    expect(result.imageUrls[0]).toBe("https://img/1.jpg");
    expect(result.imageUrls).toHaveLength(LIMITS.images);
    expect(result.imageUrls.every((u) => u.startsWith("https://"))).toBe(true);
  });

  it("drops oversized or unstorable raw snapshots", () => {
    expect(sanitizeScrapedListing({ ...base, raw: { id: 1 } }, "craigslist", "USD")!.raw).toEqual({ id: 1 });
    expect(sanitizeScrapedListing({ ...base, raw: { big: "x".repeat(10_000) } }, "craigslist", "USD")!.raw).toBeNull();
    expect(sanitizeScrapedListing({ ...base, raw: { nul: "a\u0000b" } }, "craigslist", "USD")!.raw).toBeNull();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(sanitizeScrapedListing({ ...base, raw: circular }, "craigslist", "USD")!.raw).toBeNull();
  });
});

describe("sanitizeResults", () => {
  it("de-duplicates by externalId keeping the first occurrence and skips junk", () => {
    const results = sanitizeResults(
      [
        { ...base, externalId: "1", title: "first" },
        { ...base, externalId: "1", title: "duplicate" },
        { ...base, externalId: "2", url: "ftp://x" },
        null as unknown as ScrapedListing,
        { ...base, externalId: "3" },
      ],
      "craigslist",
      "USD",
    );
    expect(results.map((r) => [r.externalId, r.title])).toEqual([
      ["1", "first"],
      ["3", "PS5"],
    ]);
  });
});

describe("helpers", () => {
  it("cleanText returns null for non-strings and blanks", () => {
    expect(cleanText(42, 10)).toBeNull();
    expect(cleanText("   ", 10)).toBeNull();
  });

  it("cleanText never splits a surrogate pair", () => {
    expect(cleanText("😀😀😀😀", 3)).toBe("😀😀…");
  });

  it("safeHttpUrl normalizes and filters", () => {
    expect(safeHttpUrl(" https://example.com/a b ")).toBe("https://example.com/a%20b");
    expect(safeHttpUrl("mailto:x@y.z")).toBeNull();
    expect(safeHttpUrl(undefined)).toBeNull();
  });
});
