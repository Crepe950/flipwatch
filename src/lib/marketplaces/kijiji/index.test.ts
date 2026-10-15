import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { findPreset } from "../../locations";
import type { SearchQuery } from "../../types";
import { BlockedError, MarketplaceError, ParseError, RateLimitedError, type AdapterContext } from "../types";
import adapter from "./index";

const FIXTURES = path.resolve(import.meta.dirname, "../../../../test/fixtures/kijiji");
const fixture = (name: string) => readFileSync(path.join(FIXTURES, name), "utf8");

const toronto = findPreset("Toronto, ON")!;

function html(body: string, init: ResponseInit = {}): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, ...init });
}

function context(respond: (url: string) => Response | Promise<Response>) {
  const log = vi.fn();
  const fetch = vi.fn(async (input: RequestInfo | URL) => respond(String(input)));
  const ctx: AdapterContext = { fetch: fetch as unknown as typeof globalThis.fetch, credentials: {}, log };
  return { ctx, fetch, log };
}

const ps5: SearchQuery = { keywords: "ps5", category: "video_games", location: toronto };

describe("kijiji adapter", () => {
  it("describes itself", () => {
    expect(adapter).toMatchObject({ id: "kijiji", displayName: "Kijiji", countries: ["CA"], minIntervalSec: 60 });
    expect(adapter.status()).toMatchObject({ ok: true });
  });

  it("fetches the search URL and parses the page state", async () => {
    const { ctx, fetch } = context(() => html(fixture("search-next.html")));
    const listings = await adapter.search(ps5, ctx);

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      "https://www.kijiji.ca/b-video-games-consoles/city-of-toronto/ps5/k0c141l1700273?sort=dateDesc&radius=40&address=Toronto%2C+ON&ll=43.6532%2C-79.3832",
    );
    expect(init.headers).toMatchObject({ "User-Agent": expect.stringContaining("Mozilla/5.0") });

    expect(listings).toHaveLength(8);
    expect(listings[0]).toMatchObject({ marketplace: "kijiji", externalId: "1712000008", priceCents: 8_999, currency: "CAD" });
  });

  it("re-applies the price bounds (unpriced listings pass) and the limit", async () => {
    const { ctx, fetch } = context(() => html(fixture("search-next.html")));
    const listings = await adapter.search({ ...ps5, minPriceCents: 10_000, maxPriceCents: 50_000, limit: 4 }, ctx);

    expect(new URL(String(fetch.mock.calls[0][0])).searchParams.get("price")).toBe("100__500");
    expect(listings.map((l) => [l.externalId, l.priceCents])).toEqual([
      ["1712000001", 45_000],
      ["1712000003", null],
      ["1712000005", null],
      ["1712000004", 38_000],
    ]);
  });

  it("parses the legacy markup", async () => {
    const { ctx } = context(() => html(fixture("search-legacy.html")));
    const listings = await adapter.search({ keywords: "bike", category: "bikes", location: findPreset("Ottawa, ON")! }, ctx);
    expect(listings.map((l) => l.externalId)).toEqual(["1598765440", "1598765441", "1598765442", "1598765443", "1598765432", "1598765444"]);
  });

  it("returns [] for a page with no results", async () => {
    const { ctx } = context(() => html(fixture("no-results.html")));
    await expect(adapter.search(ps5, ctx)).resolves.toEqual([]);
  });

  it("classifies HTTP and page-level failures", async () => {
    const cases: Array<[Response, new (...args: never[]) => Error]> = [
      [html(fixture("blocked-cloudflare.html"), { status: 403 }), BlockedError],
      [html("", { status: 429 }), RateLimitedError],
      [html(fixture("blocked-cloudflare.html")), BlockedError],
      [html(fixture("blocked-captcha.html")), BlockedError],
      [html("<html><head><title>Oops</title></head><body>Something else</body></html>"), ParseError],
      [html(""), ParseError],
      [html("", { status: 500 }), MarketplaceError],
    ];
    for (const [response, errorType] of cases) {
      const { ctx } = context(() => response);
      await expect(adapter.search(ps5, ctx)).rejects.toBeInstanceOf(errorType);
    }
  });

  it("aborts with MarketplaceError when the caller's signal fires", async () => {
    const controller = new AbortController();
    const { ctx } = context(
      () =>
        new Promise<Response>((_, reject) => {
          controller.signal.addEventListener("abort", () => reject(controller.signal.reason));
        }),
    );
    const pending = adapter.search(ps5, { ...ctx, signal: controller.signal });
    controller.abort(new Error("shutting down"));
    await expect(pending).rejects.toBeInstanceOf(MarketplaceError);
  });

  it("searches Canada-wide around the point for locations outside Canada, and logs it", async () => {
    const { ctx, fetch, log } = context(() => html(fixture("no-results.html")));
    await adapter.search({ keywords: "ps5", location: findPreset("Seattle, WA")! }, ctx);
    expect(String(fetch.mock.calls[0][0])).toBe(
      "https://www.kijiji.ca/b-canada/ps5/k0l0?sort=dateDesc&radius=40&address=Seattle%2C+WA&ll=47.6062%2C-122.3321",
    );
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/outside Canada/));
  });

  it("builds the public search URL", () => {
    expect(adapter.buildSearchUrl({ keywords: "trek marlin", location: findPreset("Ottawa, ON")!, category: "bikes", maxPriceCents: 60_000 })).toBe(
      "https://www.kijiji.ca/b-bikes/ottawa/trek-marlin/k0c644l1700185?sort=dateDesc&radius=40&address=Ottawa%2C+ON&ll=45.4215%2C-75.6972&price=__600",
    );
  });
});
