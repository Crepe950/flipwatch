import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchQuery } from "../../types";
import type { AdapterContext } from "../types";
import { BlockedError, MarketplaceError, NotConfiguredError, RateLimitedError } from "../types";
import ebay, { resetEbayTokenCache } from "./index";

const TOKEN_URL = "https://api.ebay.com/identity/v1/oauth2/token";
const SEARCH_PREFIX = "https://api.ebay.com/buy/browse/v1/item_summary/search?";

function fixtureText(name: string): string {
  return readFileSync(new URL(`../../../../test/fixtures/ebay/${name}`, import.meta.url), "utf8");
}

function json(body: string | object, status = 200, headers: Record<string, string> = {}): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(text, { status, headers: { "Content-Type": "application/json", ...headers } });
}

interface Call {
  url: string;
  init: RequestInit;
  headers: Record<string, string>;
}

/** Routes token and search requests to handlers and records every call. */
function fakeEbay(handlers: { token?: (n: number) => Response; search?: (n: number, call: Call) => Response }) {
  const calls: Call[] = [];
  let tokenCalls = 0;
  let searchCalls = 0;
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const call = { url: String(input), init, headers: (init.headers ?? {}) as Record<string, string> };
    calls.push(call);
    if (call.url === TOKEN_URL) {
      tokenCalls++;
      return handlers.token?.(tokenCalls) ?? json({ access_token: `token-${tokenCalls}`, expires_in: 7200 });
    }
    if (call.url.startsWith(SEARCH_PREFIX)) {
      searchCalls++;
      return handlers.search?.(searchCalls, call) ?? json(fixtureText("browse-search.json"));
    }
    return new Response("unexpected", { status: 404 });
  });
  const ctx: AdapterContext = {
    fetch: fetchImpl as unknown as typeof fetch,
    credentials: { ebayClientId: "App-ID-123", ebayClientSecret: "Cert-SECRET-456" },
  };
  return {
    ctx,
    calls,
    tokenCalls: () => calls.filter((c) => c.url === TOKEN_URL),
    searchCalls: () => calls.filter((c) => c.url.startsWith(SEARCH_PREFIX)),
  };
}

const query: SearchQuery = {
  keywords: "ps5",
  maxPriceCents: 45_000,
  location: { label: "Vancouver, BC", lat: 49.28, lng: -123.12, radiusKm: 40, countryCode: "CA", postalCode: "V6B 1A1" },
};

beforeEach(() => {
  resetEbayTokenCache();
  vi.stubEnv("EBAY_CLIENT_ID", "");
  vi.stubEnv("EBAY_CLIENT_SECRET", "");
  vi.stubEnv("EBAY_MARKETPLACE_ID", "");
  vi.stubEnv("EBAY_INCLUDE_AUCTIONS", "");
  vi.stubEnv("EBAY_LOCAL_PICKUP_ONLY", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("status()", () => {
  it("explains how to get keys when none are configured", () => {
    const status = ebay.status();
    expect(status.ok).toBe(false);
    expect(status.message).toContain("App ID and Cert ID missing");
    expect(status.message).toContain("Settings → eBay");
    expect(status.message).toContain("developer.ebay.com");
    expect(status.message).toContain("Production keyset");
    expect(status.message).toContain("5,000 calls/day");
  });

  it("names only the missing key", () => {
    vi.stubEnv("EBAY_CLIENT_ID", "abc");
    expect(ebay.status().message).toContain("(Cert ID missing)");
  });

  it("is ok with both keys and mentions the quota", () => {
    vi.stubEnv("EBAY_CLIENT_ID", "abc");
    vi.stubEnv("EBAY_CLIENT_SECRET", "def");
    expect(ebay.status()).toEqual({ ok: true, message: expect.stringContaining("5,000 calls/day") });
  });

  it("flags a malformed EBAY_MARKETPLACE_ID", () => {
    vi.stubEnv("EBAY_CLIENT_ID", "abc");
    vi.stubEnv("EBAY_CLIENT_SECRET", "def");
    vi.stubEnv("EBAY_MARKETPLACE_ID", "ebay.com");
    expect(ebay.status()).toMatchObject({ ok: false, message: expect.stringContaining("EBAY_MARKETPLACE_ID") });
  });
});

describe("buildSearchUrl()", () => {
  it("uses ebay.ca for Canadian searches and honours a marketplace override", () => {
    expect(ebay.buildSearchUrl(query)).toBe("https://www.ebay.ca/sch/i.html?_nkw=ps5&_sop=10&_udhi=450&LH_BIN=1&LH_PrefLoc=1");
    vi.stubEnv("EBAY_MARKETPLACE_ID", "ebay_us");
    expect(ebay.buildSearchUrl(query)).toBe("https://www.ebay.com/sch/i.html?_nkw=ps5&_sop=10&_udhi=450&LH_BIN=1");
  });

  it("matches the API search's auction and local-pickup settings", () => {
    vi.stubEnv("EBAY_INCLUDE_AUCTIONS", "true");
    vi.stubEnv("EBAY_LOCAL_PICKUP_ONLY", "true");
    expect(ebay.buildSearchUrl(query)).toBe(
      "https://www.ebay.ca/sch/i.html?_nkw=ps5&_sop=10&_udhi=450&LH_LPickup=1&_stpos=V6B1A1&_sadis=40",
    );
  });
});

describe("search()", () => {
  it("throws NotConfiguredError without credentials (and makes no request)", async () => {
    const fetchImpl = vi.fn();
    const ctx: AdapterContext = { fetch: fetchImpl as unknown as typeof fetch, credentials: {} };
    await expect(ebay.search(query, ctx)).rejects.toBeInstanceOf(NotConfiguredError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("falls back to environment credentials when the context has none", async () => {
    vi.stubEnv("EBAY_CLIENT_ID", "env-id");
    vi.stubEnv("EBAY_CLIENT_SECRET", "env-secret");
    const fake = fakeEbay({});
    fake.ctx.credentials = {};
    await ebay.search(query, fake.ctx);
    expect(fake.tokenCalls()[0].headers.Authorization).toBe(`Basic ${Buffer.from("env-id:env-secret").toString("base64")}`);
  });

  it("gets a client-credentials token, then searches with the right URL and headers", async () => {
    const fake = fakeEbay({});
    const listings = await ebay.search(query, fake.ctx);

    expect(listings).toHaveLength(5);
    expect(listings[0]).toMatchObject({ externalId: "v1|306012345678|0", priceCents: 38000, currency: "USD" });

    const [token] = fake.tokenCalls();
    expect(token.init.method).toBe("POST");
    expect(token.headers.Authorization).toBe(`Basic ${Buffer.from("App-ID-123:Cert-SECRET-456").toString("base64")}`);
    expect(token.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(token.init.body).toBe("grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope");

    const [search] = fake.searchCalls();
    const url = new URL(search.url);
    expect(url.searchParams.get("q")).toBe("ps5");
    expect(url.searchParams.get("limit")).toBe("50");
    expect(url.searchParams.get("sort")).toBe("newlyListed");
    expect(url.searchParams.get("filter")).toBe("price:[..450],priceCurrency:CAD,buyingOptions:{FIXED_PRICE|BEST_OFFER},itemLocationCountry:CA");
    expect(search.headers).toMatchObject({
      Authorization: "Bearer token-1",
      Accept: "application/json",
      "X-EBAY-C-MARKETPLACE-ID": "EBAY_CA",
      "X-EBAY-C-ENDUSERCTX": "contextualLocation=country%3DCA%2Czip%3DV6B1A1",
    });
  });

  it("adds auctions and restricts to local pickup when configured", async () => {
    vi.stubEnv("EBAY_INCLUDE_AUCTIONS", "true");
    vi.stubEnv("EBAY_LOCAL_PICKUP_ONLY", "true");
    const fake = fakeEbay({});
    await ebay.search(query, fake.ctx);
    expect(new URL(fake.searchCalls()[0].url).searchParams.get("filter")).toBe(
      "price:[..450],priceCurrency:CAD,buyingOptions:{FIXED_PRICE|BEST_OFFER|AUCTION}," +
        "deliveryOptions:{SELLER_ARRANGED_LOCAL_PICKUP},pickupCountry:CA,pickupPostalCode:V6B1A1,pickupRadius:40,pickupRadiusUnit:km",
    );
  });

  it("uses the marketplace override and its currency", async () => {
    const fake = fakeEbay({});
    fake.ctx.credentials.ebayMarketplaceId = "EBAY_US";
    await ebay.search(query, fake.ctx);
    const [search] = fake.searchCalls();
    expect(search.headers["X-EBAY-C-MARKETPLACE-ID"]).toBe("EBAY_US");
    expect(new URL(search.url).searchParams.get("filter")).toContain("priceCurrency:USD");
  });

  it("rejects a malformed marketplace override as NotConfigured", async () => {
    const fake = fakeEbay({});
    fake.ctx.credentials.ebayMarketplaceId = "EBAY US\r\nX-Evil: 1";
    await expect(ebay.search(query, fake.ctx)).rejects.toBeInstanceOf(NotConfiguredError);
    expect(fake.calls).toHaveLength(0);
  });

  it("caches the token until 60 s before it expires", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-28T12:00:00Z"));
    const fake = fakeEbay({});

    await ebay.search(query, fake.ctx);
    await ebay.search(query, fake.ctx);
    expect(fake.tokenCalls()).toHaveLength(1);

    vi.setSystemTime(new Date("2026-09-28T13:58:59Z")); // 7,139 s later: still inside expires_in − 60
    await ebay.search(query, fake.ctx);
    expect(fake.tokenCalls()).toHaveLength(1);

    vi.setSystemTime(new Date("2026-09-28T13:59:01Z"));
    await ebay.search(query, fake.ctx);
    expect(fake.tokenCalls()).toHaveLength(2);
    expect(fake.searchCalls().at(-1)?.headers.Authorization).toBe("Bearer token-2");
  });

  it("keeps separate tokens per client id", async () => {
    const fake = fakeEbay({});
    await ebay.search(query, fake.ctx);
    fake.ctx.credentials.ebayClientId = "Other-App";
    await ebay.search(query, fake.ctx);
    expect(fake.tokenCalls()).toHaveLength(2);
  });

  it("shares one token request between concurrent searches", async () => {
    const fake = fakeEbay({});
    await Promise.all([ebay.search(query, fake.ctx), ebay.search(query, fake.ctx), ebay.search(query, fake.ctx)]);
    expect(fake.tokenCalls()).toHaveLength(1);
    expect(fake.searchCalls()).toHaveLength(3);
  });

  it("drops the cached token on 401 and retries once with a fresh one", async () => {
    const fake = fakeEbay({
      search: (n) => (n === 1 ? json({ errors: [{ errorId: 1001, message: "Invalid access token" }] }, 401) : json(fixtureText("browse-search.json"))),
    });
    const log = vi.fn();
    fake.ctx.log = log;
    const listings = await ebay.search(query, fake.ctx);

    expect(listings).toHaveLength(5);
    expect(fake.tokenCalls()).toHaveLength(2);
    expect(fake.searchCalls().map((c) => c.headers.Authorization)).toEqual(["Bearer token-1", "Bearer token-2"]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("401"));

    // The refreshed token is cached for the next search.
    await ebay.search(query, fake.ctx);
    expect(fake.tokenCalls()).toHaveLength(2);
  });

  it("gives up with BlockedError when a fresh token is also rejected", async () => {
    const fake = fakeEbay({ search: () => json({ errors: [{ errorId: 1001, message: "Invalid access token" }] }, 401) });
    await expect(ebay.search(query, fake.ctx)).rejects.toBeInstanceOf(BlockedError);
    expect(fake.searchCalls()).toHaveLength(2);
    expect(fake.tokenCalls()).toHaveLength(2);
  });

  it("reports rejected keys as NotConfigured with eBay's reason", async () => {
    const fake = fakeEbay({ token: () => json(fixtureText("token-invalid-client.json"), 401) });
    const error = await ebay.search(query, fake.ctx).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotConfiguredError);
    expect((error as Error).message).toContain("invalid_client: client authentication failed");
    expect(fake.searchCalls()).toHaveLength(0);
  });

  it("does not cache a failed token request", async () => {
    const fake = fakeEbay({ token: (n) => (n === 1 ? new Response("oops", { status: 503 }) : json({ access_token: "ok", expires_in: 7200 })) });
    await expect(ebay.search(query, fake.ctx)).rejects.toMatchObject({ name: "MarketplaceError", retryable: true });
    await expect(ebay.search(query, fake.ctx)).resolves.toHaveLength(5);
  });

  it("classifies 403 as blocked and 429 as rate limited", async () => {
    const blocked = fakeEbay({ search: () => json({ errors: [{ errorId: 1100, message: "Access denied" }] }, 403) });
    const blockedError = await ebay.search(query, blocked.ctx).catch((e: unknown) => e);
    expect(blockedError).toBeInstanceOf(BlockedError);
    expect((blockedError as Error).message).toContain("Access denied");

    resetEbayTokenCache();
    const limited = fakeEbay({ search: () => json({ errors: [] }, 429, { "Retry-After": "120" }) });
    const limitedError = await ebay.search(query, limited.ctx).catch((e: unknown) => e);
    expect(limitedError).toBeInstanceOf(RateLimitedError);
    expect((limitedError as RateLimitedError).retryAfterSec).toBe(120);
  });

  it("surfaces eBay's message for a 400 as a non-retryable error", async () => {
    const fake = fakeEbay({ search: () => json(fixtureText("error-invalid-filter.json"), 400) });
    const error = await ebay.search(query, fake.ctx).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MarketplaceError);
    expect(error).toMatchObject({ retryable: false });
    expect((error as Error).message).toContain("'pickupPostalCode' value is invalid for the specified pickupCountry. (errorId 12023)");
  });

  it("reports a response body that fails mid-read as a retryable MarketplaceError", async () => {
    const failing = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new TypeError("terminated"));
      },
    });
    const fake = fakeEbay({ search: () => new Response(failing) });
    const error = await ebay.search(query, fake.ctx).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MarketplaceError);
    expect(error).toMatchObject({ retryable: true, message: expect.stringContaining("terminated") });
  });

  it("returns [] for an empty result set", async () => {
    const fake = fakeEbay({ search: () => json(fixtureText("browse-search-empty.json")) });
    await expect(ebay.search(query, fake.ctx)).resolves.toEqual([]);
  });

  it("refuses a search with neither keywords nor a mapped category", async () => {
    const fake = fakeEbay({});
    await expect(ebay.search({ ...query, keywords: "   " }, fake.ctx)).rejects.toMatchObject({ retryable: false });
    expect(fake.calls).toHaveLength(0);
  });
});
