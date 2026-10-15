import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { findPreset } from "../../locations";
import type { SearchQuery } from "../../types";
import { BlockedError, MarketplaceError, NotConfiguredError, ParseError, RateLimitedError, type AdapterContext } from "../types";
import adapter from "./index";

const FIXTURES = path.resolve(import.meta.dirname, "../../../../test/fixtures/craigslist");
const fixture = (name: string) => readFileSync(path.join(FIXTURES, name), "utf8");

const vancouver = findPreset("Vancouver, BC")!;
const seattle = findPreset("Seattle, WA")!;

function html(body: string, init: ResponseInit = {}, url?: string): Response {
  const res = new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, ...init });
  if (url) Object.defineProperty(res, "url", { value: url });
  return res;
}

function context(respond: (url: string) => Response | Promise<Response>) {
  const fetch = vi.fn(async (input: RequestInfo | URL) => respond(String(input)));
  const ctx: AdapterContext = { fetch: fetch as unknown as typeof globalThis.fetch, credentials: {}, log: () => {} };
  return { ctx, fetch };
}

const ps5: SearchQuery = { keywords: "ps5", location: vancouver };

describe("craigslist adapter", () => {
  it("describes itself", () => {
    expect(adapter).toMatchObject({ id: "craigslist", displayName: "Craigslist", countries: ["US", "CA"], minIntervalSec: 60 });
    expect(adapter.status()).toMatchObject({ ok: true, message: expect.stringMatching(/public search pages/) });
  });

  it("fetches the search URL with browser headers and parses the page", async () => {
    const { ctx, fetch } = context(() => html(fixture("search-static.html")));
    const listings = await adapter.search({ ...ps5, category: "video_games" }, ctx);

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://vancouver.craigslist.org/search/vga?query=ps5&sort=date&bundleDuplicates=1&search_distance=25&postal=V6B1A1");
    expect(init.headers).toMatchObject({ "User-Agent": expect.stringContaining("Mozilla/5.0") });
    expect(init.signal).toBeInstanceOf(AbortSignal);

    expect(listings).toHaveLength(9);
    expect(listings[0]).toMatchObject({ externalId: "7781234501", currency: "CAD", priceCents: 45_000 });
  });

  it("re-applies the price bounds (unpriced listings pass) and the limit", async () => {
    const { ctx, fetch } = context(() => html(fixture("search-static.html")));
    const listings = await adapter.search({ ...ps5, minPriceCents: 40_000, maxPriceCents: 60_000, limit: 3 }, ctx);

    expect(new URL(String(fetch.mock.calls[0][0])).searchParams.get("min_price")).toBe("400");
    expect(listings.map((l) => [l.externalId, l.priceCents])).toEqual([
      ["7781234501", 45_000],
      ["7781234503", null],
      ["7781234506", 40_000],
    ]);
  });

  it("resolves links against the host it was redirected to", async () => {
    const { ctx } = context(() => html(fixture("search-gallery.html"), {}, "https://seattle.craigslist.org/search/bia?query=bike"));
    const listings = await adapter.search({ keywords: "bike", location: { ...seattle, craigslistSite: "seattle" } }, ctx);
    expect(listings.find((l) => l.externalId === "7779876504")?.url).toBe(
      "https://seattle.craigslist.org/est/bik/d/kirkland-cannondale-synapse-105/7779876504.html",
    );
    expect(listings.every((l) => l.currency === "USD")).toBe(true);
  });

  it("returns [] for a page with no results", async () => {
    const { ctx } = context(() => html(fixture("no-results.html")));
    await expect(adapter.search(ps5, ctx)).resolves.toEqual([]);
  });

  it("classifies HTTP and page-level failures", async () => {
    const cases: Array<[Response, new (...args: never[]) => Error]> = [
      [html("Forbidden", { status: 403 }), BlockedError],
      [html("slow down", { status: 429, headers: { "retry-after": "120" } }), RateLimitedError],
      [html(fixture("blocked.html")), BlockedError],
      [html(fixture("captcha.html")), BlockedError],
      [html("<html><head><title>Oops</title></head><body>Something else</body></html>"), ParseError],
      [html("", { status: 200 }), ParseError],
      [html("upstream error", { status: 502 }), MarketplaceError],
    ];
    for (const [response, errorType] of cases) {
      const { ctx } = context(() => response);
      await expect(adapter.search(ps5, ctx)).rejects.toBeInstanceOf(errorType);
    }
  });

  it("reports the Retry-After delay and marks server errors retryable", async () => {
    const limited = context(() => html("", { status: 429, headers: { "retry-after": "120" } }));
    await expect(adapter.search(ps5, limited.ctx)).rejects.toMatchObject({ retryAfterSec: 120, marketplace: "craigslist" });
    const broken = context(() => html("", { status: 503 }));
    await expect(adapter.search(ps5, broken.ctx)).rejects.toMatchObject({ retryable: true });
    const missing = context(() => html("", { status: 404 }));
    await expect(adapter.search(ps5, missing.ctx)).rejects.toMatchObject({ retryable: false });
  });

  it("wraps network failures in MarketplaceError", async () => {
    const { ctx } = context(() => Promise.reject(new TypeError("fetch failed")));
    await expect(adapter.search(ps5, ctx)).rejects.toThrow(/Network error/);
  });

  it("throws NotConfiguredError when an unknown site redirects to the site directory", async () => {
    const { ctx } = context(() => html("<html><title>craigslist: site directory</title></html>", {}, "https://www.craigslist.org/about/sites"));
    const query = { ...ps5, location: { ...vancouver, craigslistSite: "notasite" } };
    await expect(adapter.search(query, ctx)).rejects.toBeInstanceOf(NotConfiguredError);
  });

  it("throws NotConfiguredError without fetching when no site covers the location", async () => {
    const { ctx, fetch } = context(() => html(fixture("search-static.html")));
    const remote = { ...ps5, location: { ...vancouver, craigslistSite: null, lat: 58.8, lng: -122.7, label: "Fort Nelson, BC" } };
    await expect(adapter.search(remote, ctx)).rejects.toBeInstanceOf(NotConfiguredError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("builds the public search URL, falling back to the site directory", () => {
    expect(adapter.buildSearchUrl({ ...ps5, location: { ...seattle, postalCode: null } })).toBe(
      "https://seattle.craigslist.org/search/sss?query=ps5&sort=date&bundleDuplicates=1&search_distance=25&lat=47.6062&lon=-122.3321",
    );
    const remote = { ...ps5, location: { ...vancouver, craigslistSite: null, lat: 58.8, lng: -122.7 } };
    expect(adapter.buildSearchUrl(remote)).toBe("https://www.craigslist.org/about/sites");
  });
});
