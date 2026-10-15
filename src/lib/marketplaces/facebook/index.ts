import { config } from "../../config";
import { currencyForCountry } from "../../locations";
import type { ScrapedListing, SearchQuery } from "../../types";
import { isListingUrlFor, parseFacebookDescription } from "../description";
import { request } from "../http";
import type { AdapterContext, MarketplaceAdapter } from "../types";
import { BlockedError, MarketplaceError, NotConfiguredError, ParseError, RateLimitedError } from "../types";
import { isRateLimitMessage, pickFacebookAccount, startFacebookCooldown, takeFacebookRequest } from "./budget";
import { extractEmbeddedJson } from "./embedded-json";
import {
  bundleUrls,
  buildSearchVariables,
  CONTAINER_QUERY,
  extractGraphqlSession,
  findOperationDocId,
  GRAPHQL_URL,
  graphqlBody,
  PAGE_SIZE,
  PAGINATION_QUERY,
  parseGraphqlResponse,
  type GraphqlSession,
} from "./graphql";
import { facebookGraphqlHeaders, facebookNavigationHeaders } from "./headers";
import { loginRedirectReason, loginWallReason } from "./login-wall";
import { extractFacebookListings } from "./parse";
import {
  DISABLED_MESSAGE,
  facebookStatus,
  INVALID_COOKIES_MESSAGE,
  isSendableCookieHeader,
  MISSING_COOKIES_MESSAGE,
  REFRESH_COOKIES_HINT,
  facebookAccounts,
  type FacebookAccount,
} from "./settings";
import { buildFacebookSearchUrl } from "./url";

/** Page tokens stay valid for hours; refresh well before, and after any failure. */
const SESSION_TTL_MS = 45 * 60_000;
/** The "load more" query's doc id only changes when Facebook ships; a failed lookup is retried after an hour. */
const DOC_ID_TTL_MS = 12 * 3_600_000;
const DOC_ID_RETRY_MS = 3_600_000;
const MAX_PAGES = 5;
const MAX_BUNDLES = 25;

interface CachedSession {
  session: GraphqlSession;
  at: number;
  /** Search page the session came from: the Referer of its GraphQL requests, and where its bundles are listed. */
  referer: string;
  bundles: string[];
}

// Survives Next dev HMR; one entry per cookie header (the whole header is the key, kept in memory only).
const cache = globalThis as unknown as {
  __flipwatchFbSessions?: Map<string, CachedSession>;
  __flipwatchFbPaginationDocId?: { id: string | null; at: number };
};
const sessions = (cache.__flipwatchFbSessions ??= new Map());

/** Test hook: forget cached sessions and doc ids. */
export function resetFacebookGraphqlCache(): void {
  sessions.clear();
  cache.__flipwatchFbPaginationDocId = undefined;
}

function loginWall(reason: string): BlockedError {
  return new BlockedError(`Facebook served a ${reason} instead of Marketplace results. ${REFRESH_COOKIES_HINT}`, "facebook");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(timer), reject(signal.reason)), { once: true });
  });
}

/** The logged-in search page (server-rendered). Throws on login walls. */
async function loadSearchPage(query: SearchQuery, ctx: AdapterContext, account: FacebookAccount): Promise<{ html: string; url: string }> {
  const url = buildFacebookSearchUrl(query);
  takeFacebookRequest(account, query.interactive === true);
  const res = await request(ctx, "facebook", url, { headers: facebookNavigationHeaders(account.cookies) });
  // res.url is the post-redirect URL; empty for synthetic responses.
  const redirect = loginRedirectReason(res.url || url);
  if (redirect) throw loginWall(redirect);
  return { html: await res.text(), url };
}

/** Listings from a server-rendered search page (first ~24, the account's saved radius), or the reason there are none. */
function listingsFromPage(html: string, query: SearchQuery): ScrapedListing[] {
  const blobs = extractEmbeddedJson(html);
  const { listings, sawSearchFeed, unreadableFeedListings } = extractFacebookListings(blobs, currencyForCountry(query.location.countryCode));
  if (listings.length) return limited(listings, query);

  const wall = loginWallReason(html);
  if (wall) throw loginWall(wall);
  if (unreadableFeedListings > 0) {
    throw new ParseError(
      `The Marketplace search feed has ${unreadableFeedListings} listings but none could be read. Facebook may have changed its page format.`,
      "facebook",
    );
  }
  if (sawSearchFeed) return [];
  throw new ParseError(
    blobs.length
      ? "Found no Marketplace search results in the page data. Facebook may have changed its page format, " +
          "or the location slug is not one Facebook recognises."
      : "The Facebook page had no embedded data to read (unexpected page format).",
    "facebook",
  );
}

function limited(listings: ScrapedListing[], query: SearchQuery): ScrapedListing[] {
  return query.limit !== undefined && query.limit > 0 ? listings.slice(0, query.limit) : listings;
}

/** Doc id of the "load more" query, from the page's public JS bundles (fetched without cookies), cached. */
async function paginationDocId(ctx: AdapterContext, bundles: string[]): Promise<string | null> {
  const known = cache.__flipwatchFbPaginationDocId;
  const now = Date.now();
  if (known && now - known.at < (known.id ? DOC_ID_TTL_MS : DOC_ID_RETRY_MS)) return known.id;
  let id: string | null = null;
  for (const url of bundles.slice(0, MAX_BUNDLES)) {
    try {
      const res = await ctx.fetch(url, { signal: ctx.signal });
      if (!res.ok) continue;
      id = findOperationDocId(await res.text(), PAGINATION_QUERY);
      if (id) break;
    } catch {
      // try the next bundle
    }
  }
  cache.__flipwatchFbPaginationDocId = { id, at: now };
  if (!id) ctx.log?.("facebook: couldn't find the Marketplace pagination query; searches return one page");
  return id;
}

/** Search through the GraphQL endpoint: our location, radius, sort and price range, `query.pages` pages. */
async function searchViaGraphql(query: SearchQuery, ctx: AdapterContext, account: FacebookAccount, cached: CachedSession): Promise<ScrapedListing[]> {
  const currency = currencyForCountry(query.location.countryCode);
  const pages = Math.max(1, Math.min(Math.floor(query.pages ?? 1), MAX_PAGES));
  const found = new Map<string, ScrapedListing>();
  let cursor: string | null = null;
  for (let page = 0; page < pages; page++) {
    const operation = page === 0 ? CONTAINER_QUERY : PAGINATION_QUERY;
    const docId = page === 0 ? cached.session.containerDocId : await paginationDocId(ctx, cached.bundles);
    if (!docId) break;
    // Space follow-up pages like someone scrolling, not a burst.
    if (page > 0) await sleep(1_500 + Math.random() * 2_000, ctx.signal);

    try {
      takeFacebookRequest(account, query.interactive === true);
    } catch (err) {
      // Out of budget mid-search: keep the pages we have rather than failing the whole search.
      if (page > 0 && err instanceof RateLimitedError) break;
      throw err;
    }
    const res = await request(ctx, "facebook", GRAPHQL_URL, {
      method: "POST",
      headers: facebookGraphqlHeaders(account.cookies, cached.session.lsd, operation, cached.referer),
      body: graphqlBody(cached.session, operation, docId, buildSearchVariables(cached.session.variables, query, cursor)),
    });
    const parsed = parseGraphqlResponse(await res.text());
    if (parsed.errors.some(isRateLimitMessage)) throw new AccountRateLimited(startFacebookCooldown(account));
    const { listings, sawSearchFeed } = extractFacebookListings(parsed.blobs, currency);
    if (!sawSearchFeed) {
      if (page === 0) throw new ParseError(`Facebook's search API returned no results feed${parsed.errors[0] ? `: ${parsed.errors[0]}` : ""}`, "facebook");
      break; // a later page failing still leaves the pages we have
    }
    for (const listing of listings) if (!found.has(listing.externalId)) found.set(listing.externalId, listing);
    if (!parsed.hasNextPage || !parsed.endCursor) break;
    cursor = parsed.endCursor;
  }
  ctx.log?.(`facebook: ${found.size} listings from ${query.location.label} within ${Math.round(query.location.radiusKm)} km (${account.label})`);
  return limited([...found.values()], query);
}

/** Facebook rate-limited the account a search was using (it is now resting): try another account. */
class AccountRateLimited extends Error {
  constructor(readonly cause: RateLimitedError) {
    super(cause.message);
  }
}

/** One search on one account: its cached session (or a fresh page load), the search API, the page as fallback. */
async function searchWithAccount(query: SearchQuery, ctx: AdapterContext, account: FacebookAccount): Promise<ScrapedListing[]> {
  if (!isSendableCookieHeader(account.cookies)) throw new NotConfiguredError(`${account.label}: ${INVALID_COOKIES_MESSAGE}`, "facebook");

  // A search page loaded now provides both a fresh session and a fallback result.
  let loadedPage: { html: string; url: string } | null = null;
  let cached = sessions.get(account.cookies);
  if (!cached || Date.now() - cached.at > SESSION_TTL_MS) {
    loadedPage = await loadSearchPage(query, ctx, account);
    const session = extractGraphqlSession(loadedPage.html, account.cookies);
    if (!session) {
      sessions.delete(account.cookies);
      return listingsFromPage(loadedPage.html, query);
    }
    cached = { session, at: Date.now(), referer: loadedPage.url, bundles: bundleUrls(loadedPage.html) };
    sessions.set(account.cookies, cached);
  }

  try {
    return await searchViaGraphql(query, ctx, account, cached);
  } catch (err) {
    sessions.delete(account.cookies);
    // Blocks and rate limits apply to the whole account: back off rather than hit the page as well.
    if (err instanceof AccountRateLimited || err instanceof BlockedError || err instanceof RateLimitedError || ctx.signal?.aborted) throw err;
    ctx.log?.(`facebook: search API failed (${err instanceof Error ? err.message : String(err)}); using the search page instead`);
    const page = loadedPage ?? (await loadSearchPage(query, ctx, account));
    return listingsFromPage(page.html, query);
  }
}

async function searchFacebook(query: SearchQuery, ctx: AdapterContext): Promise<ScrapedListing[]> {
  if (!config.facebookEnabled) throw new NotConfiguredError(DISABLED_MESSAGE, "facebook");
  const accounts = facebookAccounts(ctx);
  if (accounts.length === 0) throw new NotConfiguredError(MISSING_COOKIES_MESSAGE, "facebook");

  // Each search runs on one account (sessions belong to an account), chosen by traffic share. If Facebook
  // rate-limits it mid-search, that account rests and the search moves to the next one with room.
  const tried = new Set<string>();
  for (;;) {
    const account = pickFacebookAccount(accounts, query.interactive === true, Date.now(), tried);
    tried.add(account.key);
    try {
      return await searchWithAccount(query, ctx, account);
    } catch (err) {
      if (!(err instanceof AccountRateLimited)) throw err;
      ctx.log?.(`facebook: ${err.message}`);
      if (tried.size >= accounts.length) throw err.cause;
    }
  }
}

/** request() classifies HTTP failures, but reading a multi-megabyte page can still time out or reset. */
function asMarketplaceError(err: unknown): MarketplaceError {
  if (err instanceof MarketplaceError) return err;
  return new MarketplaceError(`Facebook request failed: ${err instanceof Error ? err.message : String(err)}`, "facebook");
}

/** One listing's item page (a logged-in page load, counted against an account's budget like a search). */
async function fetchFacebookDescription(url: string, ctx: AdapterContext, interactive: boolean): Promise<string | null> {
  if (!config.facebookEnabled) throw new NotConfiguredError(DISABLED_MESSAGE, "facebook");
  if (!isListingUrlFor("facebook", url)) return null;
  const accounts = facebookAccounts(ctx).filter((a) => isSendableCookieHeader(a.cookies));
  if (accounts.length === 0) throw new NotConfiguredError(MISSING_COOKIES_MESSAGE, "facebook");
  const account = pickFacebookAccount(accounts, interactive);
  takeFacebookRequest(account, interactive);
  const res = await request(ctx, "facebook", url, { headers: facebookNavigationHeaders(account.cookies) });
  const redirect = loginRedirectReason(res.url || url);
  if (redirect) throw loginWall(redirect);
  const html = await res.text();
  const description = parseFacebookDescription(html);
  if (description) return description;
  if (/"Rate limit exceeded"|You(?:'|\\u2019)re Temporarily Blocked/i.test(html)) throw startFacebookCooldown(account);
  const wall = loginWallReason(html);
  if (wall) throw loginWall(wall);
  return null;
}

const adapter: MarketplaceAdapter = {
  id: "facebook",
  displayName: "Facebook Marketplace",
  countries: ["US", "CA"],
  // Every poll is a logged-in request on a real account: keep it slow to limit ban risk.
  minIntervalSec: 600,
  // At most this many of a search's OR alternatives per poll (rotating), to keep traffic per account low.
  maxAlternativesPerRun: 2,
  // Marketplace search treats "a | b" as fuzzy text (one blended result page), not as OR.
  supportsOrQueries: false,

  status: facebookStatus,

  buildSearchUrl: buildFacebookSearchUrl,

  search(query, ctx) {
    return searchFacebook(query, ctx).catch((err: unknown) => {
      throw asMarketplaceError(err);
    });
  },

  fetchDescription(url, ctx, opts) {
    return fetchFacebookDescription(url, ctx, opts?.interactive ?? true).catch((err: unknown) => {
      throw asMarketplaceError(err);
    });
  },
};

export { PAGE_SIZE as FACEBOOK_PAGE_SIZE };
export default adapter;
