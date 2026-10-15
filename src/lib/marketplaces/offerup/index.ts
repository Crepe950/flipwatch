import type { ScrapedListing, SearchQuery } from "../../types";
import { fetchText, request, userAgent } from "../http";
import type { AdapterContext, MarketplaceAdapter } from "../types";
import { BlockedError, MarketplaceError, ParseError, RateLimitedError } from "../types";
import { looksLikeBotChallenge } from "./challenge";
import { buildModularFeedBody, OFFERUP_GRAPHQL_URL } from "./graphql";
import { readOfferUpPageData } from "./page-data";
import { countListingTiles, extractOfferUpListings, parseModularFeedResponse } from "./parse";
import { buildOfferUpSearchUrl, OFFERUP_ORIGIN } from "./url";

const STATUS_MESSAGE =
  "Uses OfferUp's undocumented web endpoints (there is no official API), so it can break when OfferUp " +
  "changes its site, and frequent polling may trigger bot checks. US listings only. The search's " +
  "coordinates are sent with every request, but if OfferUp ignores them on the search page, results " +
  "follow this server's IP location.";

const BLOCKED_MESSAGE = "OfferUp served a bot-check page instead of results; backing off.";

const NAVIGATION_HEADERS: Record<string, string> = {
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
};

/** Session cookies from the page response, replayed on the GraphQL call like a browser would. */
function cookiesFrom(headers: Headers): string | undefined {
  if (typeof headers.getSetCookie !== "function") return undefined;
  const pairs = headers
    .getSetCookie()
    .map((cookie) => cookie.split(";", 1)[0].trim())
    .filter((pair) => /^[^=\s]+=/.test(pair));
  return pairs.length ? pairs.join("; ") : undefined;
}

function capped(listings: ScrapedListing[], limit: number | undefined): ScrapedListing[] {
  return limit !== undefined && limit > 0 ? listings.slice(0, limit) : listings;
}

interface PageResult {
  listings: ScrapedListing[];
  cookies?: string;
}

async function searchPage(ctx: AdapterContext, url: string, ua: string): Promise<PageResult> {
  const res = await request(ctx, "offerup", url, { headers: { "User-Agent": ua, ...NAVIGATION_HEADERS } });
  const cookies = cookiesFrom(res.headers);
  const html = await res.text();
  const blobs = readOfferUpPageData(html);
  if (blobs.length === 0) {
    if (looksLikeBotChallenge(html)) throw new BlockedError(BLOCKED_MESSAGE, "offerup");
    ctx.log?.("OfferUp search page had no embedded app data; trying GraphQL");
  }
  const listings = extractOfferUpListings(...blobs);
  const tiles = listings.length === 0 ? countListingTiles(...blobs) : 0;
  // GraphQL is tried next and fails loudly if its tiles are unreadable too.
  if (tiles > 0) ctx.log?.(`OfferUp search page has ${tiles} listing tiles but none could be read; trying GraphQL`);
  return { listings, cookies };
}

async function searchGraphql(
  query: SearchQuery,
  ctx: AdapterContext,
  referer: string,
  ua: string,
  cookies: string | undefined,
): Promise<ScrapedListing[]> {
  const text = await fetchText(ctx, "offerup", OFFERUP_GRAPHQL_URL, {
    method: "POST",
    headers: {
      "User-Agent": ua,
      Accept: "application/json",
      "Content-Type": "application/json",
      Origin: OFFERUP_ORIGIN,
      Referer: referer,
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
      ...(cookies ? { Cookie: cookies } : {}),
    },
    body: buildModularFeedBody(query),
  });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    if (looksLikeBotChallenge(text)) throw new BlockedError(BLOCKED_MESSAGE, "offerup");
    throw new ParseError("OfferUp GraphQL returned something other than JSON", "offerup");
  }
  return parseModularFeedResponse(body);
}

/** request() classifies HTTP failures, but reading a body can still time out or reset mid-stream. */
function asMarketplaceError(err: unknown): MarketplaceError {
  if (err instanceof MarketplaceError) return err;
  return new MarketplaceError(`OfferUp request failed: ${err instanceof Error ? err.message : String(err)}`, "offerup");
}

async function searchOfferUp(query: SearchQuery, ctx: AdapterContext): Promise<ScrapedListing[]> {
  const pageUrl = buildOfferUpSearchUrl(query);
  // One UA for both requests: a session that switches browsers mid-search looks like a bot.
  const ua = userAgent();

  let cookies: string | undefined;
  try {
    const page = await searchPage(ctx, pageUrl, ua);
    if (page.listings.length) return capped(page.listings, query.limit);
    cookies = page.cookies;
  } catch (err) {
    const error = asMarketplaceError(err);
    // Blocks and rate limits apply to the whole site; hammering the API next would only make it worse.
    if (error instanceof BlockedError || error instanceof RateLimitedError) throw error;
    ctx.log?.(`OfferUp search page failed (${error.message}); trying GraphQL`);
  }

  return capped(await searchGraphql(query, ctx, pageUrl, ua, cookies), query.limit);
}

const adapter: MarketplaceAdapter = {
  id: "offerup",
  displayName: "OfferUp",
  countries: ["US"],
  // Undocumented endpoints with bot protection: poll gently.
  minIntervalSec: 90,

  status: () => ({ ok: true, message: STATUS_MESSAGE }),

  buildSearchUrl: buildOfferUpSearchUrl,

  search(query, ctx) {
    return searchOfferUp(query, ctx).catch((err: unknown) => {
      throw asMarketplaceError(err);
    });
  },
};

export default adapter;
