import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { SearchQuery } from "../../types";
import type { AdapterContext } from "../types";
import { BlockedError, MarketplaceError, ParseError, RateLimitedError } from "../types";
import { buildModularFeedParams, MODULAR_FEED_QUERY } from "./graphql";
import offerup from "./index";
import { buildOfferUpSearchUrl, offerUpDistanceMiles } from "./url";

const GRAPHQL_URL = "https://offerup.com/api/graphql";

function fixture(name: string): string {
  return readFileSync(new URL(`../../../../test/fixtures/offerup/${name}`, import.meta.url), "utf8");
}

const seattle = { label: "Seattle, WA", lat: 47.6062, lng: -122.3321, radiusKm: 40, countryCode: "US", postalCode: "98101" };
const query: SearchQuery = { keywords: "ps5 disc", minPriceCents: 20_050, maxPriceCents: 45_000, location: seattle };

interface Call {
  url: string;
  init: RequestInit;
  headers: Record<string, string>;
}

function fakeOfferUp(page: () => Response, graphql: () => Response = () => new Response(fixture("graphql-empty.json"))) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const call = { url: String(input), init, headers: (init.headers ?? {}) as Record<string, string> };
    calls.push(call);
    return call.url === GRAPHQL_URL ? graphql() : page();
  });
  const log = vi.fn();
  const ctx: AdapterContext = { fetch: fetchImpl as unknown as typeof fetch, credentials: {}, log };
  return { ctx, calls, log };
}

function failingStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.error(new TypeError("terminated"));
    },
  });
}

function html(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8", ...headers } });
}

describe("request building", () => {
  it("builds the public search URL with whole-dollar bounds, a UI distance and location hints", () => {
    expect(buildOfferUpSearchUrl(query)).toBe(
      "https://offerup.com/search?q=ps5+disc&SORT=-posted&PRICE_MIN=200&PRICE_MAX=450&DISTANCE=30" +
        "&lat=47.6062&lon=-122.3321",
    );
    expect(offerup.buildSearchUrl({ keywords: "tv", location: seattle, maxPriceCents: 0 })).toBe(
      "https://offerup.com/search?q=tv&SORT=-posted&PRICE_MAX=0&DISTANCE=30&lat=47.6062&lon=-122.3321",
    );
  });

  it("encodes hostile keywords instead of letting them add parameters", () => {
    const url = new URL(buildOfferUpSearchUrl({ ...query, keywords: "tv&SORT=price#x" }));
    expect(url.searchParams.get("q")).toBe("tv&SORT=price#x");
    expect(url.searchParams.getAll("SORT")).toEqual(["-posted"]);
  });

  it("snaps the radius up to OfferUp's distance options", () => {
    expect(offerUpDistanceMiles(1)).toBe(5);
    expect(offerUpDistanceMiles(8)).toBe(5);
    expect(offerUpDistanceMiles(16)).toBe(10);
    expect(offerUpDistanceMiles(40)).toBe(30);
    expect(offerUpDistanceMiles(80)).toBe(50);
    expect(offerUpDistanceMiles(500)).toBe(50);
  });

  it("builds GetModularFeed search params", () => {
    expect(buildModularFeedParams({ ...query, limit: 500 })).toEqual([
      { key: "q", value: "ps5 disc" },
      { key: "platform", value: "web" },
      { key: "lat", value: "47.6062" },
      { key: "lon", value: "-122.3321" },
      { key: "limit", value: "50" },
      { key: "SORT", value: "-posted" },
      { key: "DISTANCE", value: "30" },
      { key: "PRICE_MIN", value: "200" },
      { key: "PRICE_MAX", value: "450" },
    ]);
  });
});

describe("status()", () => {
  it("is usable, with a caveat about undocumented endpoints", () => {
    const status = offerup.status();
    expect(status.ok).toBe(true);
    expect(status.message).toContain("undocumented");
  });

  it("declares US-only and a gentle poll interval", () => {
    expect(offerup.countries).toEqual(["US"]);
    expect(offerup.minIntervalSec).toBe(90);
  });
});

describe("search()", () => {
  it("returns listings from the search page without calling GraphQL", async () => {
    const fake = fakeOfferUp(() => html(fixture("search-page.html")));
    const listings = await offerup.search(query, fake.ctx);

    expect(listings).toHaveLength(4);
    expect(fake.calls).toHaveLength(1);
    const [page] = fake.calls;
    expect(page.url).toBe(buildOfferUpSearchUrl(query));
    expect(page.headers).toMatchObject({ "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" });
    expect(page.headers["User-Agent"]).toMatch(/Mozilla\/5\.0/);
  });

  it("honours query.limit as a soft cap", async () => {
    const fake = fakeOfferUp(() => html(fixture("search-page.html")));
    await expect(offerup.search({ ...query, limit: 2 }, fake.ctx)).resolves.toHaveLength(2);
  });

  it("falls back to GraphQL when the page has no listings, replaying cookies and the UA", async () => {
    const fake = fakeOfferUp(
      () =>
        html(fixture("search-page-empty.html"), 200, {
          "Set-Cookie": "ou.session=abc123; Path=/; HttpOnly; Secure",
        }),
      () => new Response(fixture("graphql-modular-feed.json"), { headers: { "Content-Type": "application/json" } }),
    );
    const listings = await offerup.search(query, fake.ctx);

    expect(listings.map((l) => l.externalId)).toEqual(["1784600001", "1784600002"]);
    const [page, graphql] = fake.calls;
    expect(graphql.url).toBe(GRAPHQL_URL);
    expect(graphql.init.method).toBe("POST");
    expect(graphql.headers).toMatchObject({
      "Content-Type": "application/json",
      Accept: "application/json",
      Origin: "https://offerup.com",
      Referer: buildOfferUpSearchUrl(query),
      Cookie: "ou.session=abc123",
      "User-Agent": page.headers["User-Agent"],
    });
    const body = JSON.parse(String(graphql.init.body));
    expect(body.operationName).toBe("GetModularFeed");
    expect(body.query).toBe(MODULAR_FEED_QUERY);
    expect(body.variables).toEqual({ debug: false, searchParams: buildModularFeedParams(query) });
  });

  it("returns [] when both the page and GraphQL are empty", async () => {
    const fake = fakeOfferUp(() => html(fixture("search-page-empty.html")));
    await expect(offerup.search(query, fake.ctx)).resolves.toEqual([]);
    expect(fake.calls).toHaveLength(2);
  });

  it("does not mistake page text for a bot check when app data is present", async () => {
    // search-page.html contains "Press & hold" in its body copy.
    const fake = fakeOfferUp(() => html(fixture("search-page.html")));
    await expect(offerup.search(query, fake.ctx)).resolves.toHaveLength(4);
  });

  it("throws BlockedError on a bot challenge page and does not hit GraphQL", async () => {
    const fake = fakeOfferUp(() => html(fixture("challenge.html")));
    await expect(offerup.search(query, fake.ctx)).rejects.toBeInstanceOf(BlockedError);
    expect(fake.calls).toHaveLength(1);
  });

  it("throws BlockedError on 403 and RateLimitedError on 429 without falling back", async () => {
    const blocked = fakeOfferUp(() => html(fixture("challenge.html"), 403));
    await expect(offerup.search(query, blocked.ctx)).rejects.toBeInstanceOf(BlockedError);
    expect(blocked.calls).toHaveLength(1);

    const limited = fakeOfferUp(() => html("slow down", 429, { "Retry-After": "300" }));
    await expect(offerup.search(query, limited.ctx)).rejects.toMatchObject({ name: "RateLimitedError", retryAfterSec: 300 });
    expect(limited.calls).toHaveLength(1);
  });

  it("tries GraphQL when the page errors with a 5xx", async () => {
    const fake = fakeOfferUp(
      () => html("upstream error", 502),
      () => new Response(fixture("graphql-modular-feed.json")),
    );
    await expect(offerup.search(query, fake.ctx)).resolves.toHaveLength(2);
    expect(fake.log).toHaveBeenCalledWith(expect.stringContaining("HTTP 502"));
  });

  it("tries GraphQL when the page body fails mid-read, and wraps a failing GraphQL body", async () => {
    const fake = fakeOfferUp(
      () => new Response(failingStream()),
      () => new Response(fixture("graphql-modular-feed.json")),
    );
    await expect(offerup.search(query, fake.ctx)).resolves.toHaveLength(2);
    expect(fake.log).toHaveBeenCalledWith(expect.stringContaining("terminated"));

    const broken = fakeOfferUp(() => html(fixture("search-page-empty.html")), () => new Response(failingStream()));
    await expect(offerup.search(query, broken.ctx)).rejects.toMatchObject({ name: "MarketplaceError", retryable: true });
  });

  it("surfaces GraphQL failures: challenge → Blocked, errors → ParseError, 429 → RateLimited", async () => {
    const challenge = fakeOfferUp(() => html(fixture("search-page-empty.html")), () => html(fixture("challenge.html")));
    await expect(offerup.search(query, challenge.ctx)).rejects.toBeInstanceOf(BlockedError);

    const errors = fakeOfferUp(() => html(fixture("search-page-empty.html")), () => new Response(fixture("graphql-errors.json")));
    await expect(offerup.search(query, errors.ctx)).rejects.toBeInstanceOf(ParseError);

    const junk = fakeOfferUp(() => html(fixture("search-page-empty.html")), () => new Response("<html>oops</html>"));
    await expect(offerup.search(query, junk.ctx)).rejects.toBeInstanceOf(ParseError);

    const limited = fakeOfferUp(() => html(fixture("search-page-empty.html")), () => new Response("", { status: 429 }));
    await expect(offerup.search(query, limited.ctx)).rejects.toBeInstanceOf(RateLimitedError);
  });

  it("falls back to GraphQL when the page's listing tiles can't be read, and fails loudly if GraphQL's can't either", async () => {
    const driftedPage = html(fixture("search-page.html").replaceAll('"listingId"', '"id"'));
    const recovered = fakeOfferUp(() => driftedPage.clone(), () => new Response(fixture("graphql-modular-feed.json")));
    await expect(offerup.search(query, recovered.ctx)).resolves.toHaveLength(2);
    expect(recovered.log).toHaveBeenCalledWith(expect.stringMatching(/search page has \d+ listing tiles but none could be read/));

    const driftedFeed = fixture("graphql-modular-feed.json").replaceAll('"listingId"', '"id"');
    const broken = fakeOfferUp(() => driftedPage.clone(), () => new Response(driftedFeed));
    await expect(offerup.search(query, broken.ctx)).rejects.toThrow(/GraphQL feed has 3 listing tiles but none could be read/);
  });

  it("reports network failures as retryable MarketplaceErrors", async () => {
    const ctx: AdapterContext = {
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
      credentials: {},
    };
    await expect(offerup.search(query, ctx)).rejects.toMatchObject({ retryable: true });
    await expect(offerup.search(query, ctx)).rejects.toBeInstanceOf(MarketplaceError);
  });
});
