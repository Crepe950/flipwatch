import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchQuery } from "../../types";
import type { AdapterContext } from "../types";
import { BlockedError, MarketplaceError, NotConfiguredError, ParseError, RateLimitedError } from "../types";
import { resetFacebookBudget } from "./budget";
import facebook from "./index";
import { normalizeCookieHeader } from "./settings";
import { buildFacebookSearchUrl, facebookLocationSlug } from "./url";

function fixture(name: string): string {
  return readFileSync(new URL(`../../../../test/fixtures/facebook/${name}`, import.meta.url), "utf8");
}

const COOKIES = "c_user=100012345678901; xs=12%3AabcDEF%3A2%3A1790000000%3A-1%3A1234; datr=Zx9aZ1b2c3d4";

const vancouver = {
  label: "Vancouver, BC",
  lat: 49.2827,
  lng: -123.1207,
  radiusKm: 40,
  countryCode: "CA",
  postalCode: "V6B 1A1",
  facebookLocation: "vancouver",
};
const query: SearchQuery = { keywords: "ps5 disc", minPriceCents: 10_050, maxPriceCents: 45_000, location: vancouver };

function page(body: string, init: { status?: number; url?: string } = {}): Response {
  const res = new Response(body, { status: init.status ?? 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
  if (init.url) Object.defineProperty(res, "url", { value: init.url });
  return res;
}

function failingStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.error(new TypeError("terminated"));
    },
  });
}

function fakeFacebook(respond: () => Response) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), headers: (init.headers ?? {}) as Record<string, string> });
    return respond();
  });
  const ctx: AdapterContext = { fetch: fetchImpl as unknown as typeof fetch, credentials: { facebookCookies: COOKIES } };
  return { ctx, calls };
}

beforeEach(() => {
  resetFacebookBudget();
  vi.stubEnv("FACEBOOK_ENABLED", "true");
  vi.stubEnv("FACEBOOK_COOKIES", "");
  vi.stubEnv("SCRAPER_USER_AGENT", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("URL building", () => {
  it("builds the newest-first keyword search URL without price or age filters (they make Facebook drop the keyword)", () => {
    expect(buildFacebookSearchUrl(query)).toBe(
      "https://www.facebook.com/marketplace/vancouver/search?query=ps5+disc&sortBy=creation_time_descend",
    );
    expect(facebook.buildSearchUrl(query)).toBe(buildFacebookSearchUrl(query));
    expect(buildFacebookSearchUrl({ ...query, sort: "relevance" })).toBe(
      "https://www.facebook.com/marketplace/vancouver/search?query=ps5+disc&sortBy=best_match",
    );
  });

  it("derives the location slug from the label when no Facebook location is set", () => {
    expect(facebookLocationSlug({ ...vancouver, facebookLocation: null, label: "San Francisco, CA" })).toBe("sanfrancisco");
    expect(facebookLocationSlug({ ...vancouver, facebookLocation: "", label: "Montréal, QC" })).toBe("montreal");
    expect(facebookLocationSlug({ ...vancouver, facebookLocation: " 108187565878869 " })).toBe("108187565878869");
    expect(facebookLocationSlug({ ...vancouver, facebookLocation: null, label: "!!!" })).toBeNull();
  });

  it("always uses the keyword search page and falls back to the account location without a slug", () => {
    expect(buildFacebookSearchUrl({ ...query, category: "cars_trucks", minPriceCents: null, maxPriceCents: 0 })).toBe(
      "https://www.facebook.com/marketplace/vancouver/search?query=ps5+disc&sortBy=creation_time_descend",
    );
    const noSlug = { ...query, location: { ...vancouver, facebookLocation: null, label: "---" } };
    expect(buildFacebookSearchUrl(noSlug)).toMatch(/^https:\/\/www\.facebook\.com\/marketplace\/search\?query=/);
  });

  it("encodes a hostile location override instead of letting it change the path", () => {
    const url = buildFacebookSearchUrl({ ...query, location: { ...vancouver, facebookLocation: "../../login?x=" } });
    expect(new URL(url).pathname).toBe("/marketplace/..%2F..%2Flogin%3Fx%3D/search");
  });
});

describe("status()", () => {
  it("is disabled by default and explains the ToS / ban risk and both requirements", () => {
    vi.stubEnv("FACEBOOK_ENABLED", "");
    const status = facebook.status();
    expect(status.ok).toBe(false);
    expect(status.message).toContain("Terms of Service");
    expect(status.message).toContain("banned");
    expect(status.message).toContain("Settings → Facebook");
  });

  it("asks for cookies when enabled without them", () => {
    const status = facebook.status();
    expect(status.ok).toBe(false);
    expect(status.message).toContain("no account is connected");
  });

  it("is ok (with the risk caveat) when enabled with cookies", () => {
    vi.stubEnv("FACEBOOK_COOKIES", COOKIES);
    const status = facebook.status();
    expect(status.ok).toBe(true);
    expect(status.message).toContain("Terms of Service");
    expect(status.message).not.toContain("Warning");
  });

  it("warns when the cookies do not look like a logged-in session", () => {
    vi.stubEnv("FACEBOOK_COOKIES", "datr=abc; locale=en_US");
    expect(facebook.status()).toMatchObject({ ok: true, message: expect.stringContaining("no c_user/xs") });
  });

  it("rejects a cookie header that cannot be sent (e.g. a truncated copy)", () => {
    vi.stubEnv("FACEBOOK_COOKIES", "c_user=1; xs=12%3Aab…");
    expect(facebook.status()).toMatchObject({ ok: false, message: expect.stringContaining("can't be sent") });
  });

  it("polls no more than every 10 minutes and searches at most 2 alternatives per run", () => {
    expect(facebook.minIntervalSec).toBe(600);
    expect(facebook.maxAlternativesPerRun).toBe(2);
  });
});

describe("normalizeCookieHeader", () => {
  it("accepts a pasted header line and strips line breaks", () => {
    expect(normalizeCookieHeader("Cookie: c_user=1;\r\n xs=2")).toBe("c_user=1;  xs=2");
    expect(normalizeCookieHeader("   ")).toBeUndefined();
    expect(normalizeCookieHeader(undefined)).toBeUndefined();
  });
});

describe("search()", () => {
  it("throws NotConfiguredError when disabled, even with cookies", async () => {
    vi.stubEnv("FACEBOOK_ENABLED", "false");
    const fake = fakeFacebook(() => page(fixture("search-page.html")));
    await expect(facebook.search(query, fake.ctx)).rejects.toBeInstanceOf(NotConfiguredError);
    expect(fake.calls).toHaveLength(0);
  });

  it("throws NotConfiguredError when enabled without cookies", async () => {
    const fake = fakeFacebook(() => page(fixture("search-page.html")));
    fake.ctx.credentials = {};
    await expect(facebook.search(query, fake.ctx)).rejects.toThrow(/no account is connected/);
    expect(fake.calls).toHaveLength(0);
  });

  it("throws NotConfiguredError (not a network error) for unsendable cookies", async () => {
    const fake = fakeFacebook(() => page(fixture("search-page.html")));
    fake.ctx.credentials = { facebookCookies: "c_user=1; xs=ab…" };
    await expect(facebook.search(query, fake.ctx)).rejects.toBeInstanceOf(NotConfiguredError);
    expect(fake.calls).toHaveLength(0);
  });

  it("requests the search like a logged-in browser navigation and parses listings", async () => {
    const fake = fakeFacebook(() => page(fixture("search-page.html")));
    const listings = await facebook.search(query, fake.ctx);

    expect(listings).toHaveLength(5);
    expect(listings[0]).toMatchObject({ externalId: "1234567890123456", priceCents: 45000, currency: "CAD" });
    const [call] = fake.calls;
    expect(call.url).toBe(buildFacebookSearchUrl(query));
    expect(call.headers).toMatchObject({
      Cookie: COOKIES,
      "Accept-Language": "en-US,en;q=0.9",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-User": "?1",
      "Upgrade-Insecure-Requests": "1",
    });
    expect(call.headers["User-Agent"]).toMatch(/Chrome\/\d+/);
    expect(call.headers["Sec-CH-UA"]).toContain("Google Chrome");
  });

  it("keeps the same UA across polls and honours SCRAPER_USER_AGENT without mismatched client hints", async () => {
    const fake = fakeFacebook(() => page(fixture("search-page.html")));
    await facebook.search(query, fake.ctx);
    await facebook.search(query, fake.ctx);
    expect(fake.calls[0].headers["User-Agent"]).toBe(fake.calls[1].headers["User-Agent"]);

    vi.stubEnv("SCRAPER_USER_AGENT", "MyAgent/1.0");
    await facebook.search(query, fake.ctx);
    expect(fake.calls[2].headers["User-Agent"]).toBe("MyAgent/1.0");
    expect(fake.calls[2].headers["Sec-CH-UA"]).toBeUndefined();
  });

  it("uses env cookies when the context has none, and the country currency as fallback", async () => {
    vi.stubEnv("FACEBOOK_COOKIES", "Cookie: c_user=1; xs=2");
    const fake = fakeFacebook(() => page(fixture("search-page.html")));
    fake.ctx.credentials = {};
    const listings = await facebook.search({ ...query, location: { ...vancouver, countryCode: "US" } }, fake.ctx);
    expect(fake.calls[0].headers.Cookie).toBe("c_user=1; xs=2");
    expect(listings[0].currency).toBe("USD");
  });

  it("honours query.limit as a soft cap", async () => {
    const fake = fakeFacebook(() => page(fixture("search-page.html")));
    await expect(facebook.search({ ...query, limit: 2 }, fake.ctx)).resolves.toHaveLength(2);
  });

  it("returns [] for an empty result feed", async () => {
    const fake = fakeFacebook(() => page(fixture("search-page-empty.html")));
    await expect(facebook.search(query, fake.ctx)).resolves.toEqual([]);
  });

  it("throws BlockedError telling the user to refresh cookies on a login redirect", async () => {
    const fake = fakeFacebook(() => page(fixture("login-wall.html"), { url: "https://www.facebook.com/login/?next=%2Fmarketplace" }));
    const error = await facebook.search(query, fake.ctx).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BlockedError);
    expect((error as Error).message).toContain("login redirect");
    expect((error as Error).message).toContain("Reconnect Facebook");
  });

  it("throws BlockedError on a login wall served in place (no redirect)", async () => {
    const fake = fakeFacebook(() => page(fixture("login-wall.html")));
    const error = await facebook.search(query, fake.ctx).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BlockedError);
    expect((error as Error).message).toMatch(/^Facebook served a login page instead of Marketplace results\. .*Settings → Facebook/);
  });

  it("throws BlockedError on a checkpoint", async () => {
    const redirected = fakeFacebook(() => page(fixture("checkpoint.html"), { url: "https://www.facebook.com/checkpoint/828281030927956/" }));
    await expect(facebook.search(query, redirected.ctx)).rejects.toThrow(/security checkpoint redirect/);
    const inPlace = fakeFacebook(() => page(fixture("checkpoint.html")));
    await expect(facebook.search(query, inPlace.ctx)).rejects.toThrow(/security checkpoint/);
  });

  it("throws BlockedError on a meta-refresh bounce to the login page", async () => {
    const html = '<html><head><meta http-equiv="refresh" content="0; URL=/login/?next=%2Fmarketplace%2F" /></head></html>';
    const fake = fakeFacebook(() => page(html));
    await expect(facebook.search(query, fake.ctx)).rejects.toThrow(/login redirect.*Reconnect Facebook/);
  });

  it("classifies 401/403 as blocked and 429 as rate limited", async () => {
    const blocked = fakeFacebook(() => page("denied", { status: 403 }));
    await expect(facebook.search(query, blocked.ctx)).rejects.toBeInstanceOf(BlockedError);
    const unauthorized = fakeFacebook(() => page("login required", { status: 401 }));
    await expect(facebook.search(query, unauthorized.ctx)).rejects.toBeInstanceOf(BlockedError);
    const limited = fakeFacebook(() => new Response("slow down", { status: 429, headers: { "Retry-After": "600" } }));
    await expect(facebook.search(query, limited.ctx)).rejects.toMatchObject({ name: "RateLimitedError", retryAfterSec: 600 });
    await expect(facebook.search(query, limited.ctx)).rejects.toBeInstanceOf(RateLimitedError);
  });

  it("reports a body that fails mid-read as a retryable MarketplaceError", async () => {
    const fake = fakeFacebook(() => new Response(failingStream(), { status: 200 }));
    const error = await facebook.search(query, fake.ctx).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MarketplaceError);
    expect(error).toMatchObject({ retryable: true, message: expect.stringContaining("terminated") });
  });

  it("throws ParseError when the feed has listings none of which can be read", async () => {
    const drifted = fixture("search-page.html").replaceAll('"listing_price"', '"price_info"');
    const fake = fakeFacebook(() => page(drifted));
    const error = await facebook.search(query, fake.ctx).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ParseError);
    expect((error as Error).message).toMatch(/search feed has \d+ listings but none could be read/);
  });

  it("throws ParseError when the page has data but no feed, or no data at all", async () => {
    const noFeed = fakeFacebook(() => page(fixture("unknown-page.html")));
    await expect(facebook.search(query, noFeed.ctx)).rejects.toThrow(/changed its page format/);
    const noData = fakeFacebook(() => page("<html><body>maintenance</body></html>"));
    await expect(facebook.search(query, noData.ctx)).rejects.toBeInstanceOf(ParseError);
  });
});
