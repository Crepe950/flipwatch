import type { ScrapedListing, SearchQuery } from "../../types";
import { fetchJson } from "../http";
import type { AdapterContext, MarketplaceAdapter } from "../types";
import { BlockedError, MarketplaceError, NotConfiguredError } from "../types";
import { getEbayAccessToken, invalidateEbayAccessToken } from "./auth";
import { buildBrowseHeaders, buildBrowseSearchUrl } from "./browse-request";
import {
  ebaySearchOptions,
  ebayStatus,
  invalidMarketplaceIdMessage,
  marketplaceIdOverride,
  missingCredentialsMessage,
  resolveEbayCredentials,
} from "./credentials";
import { defaultMarketplaceId, ebayCategoryId, marketplaceCurrency, normalizeMarketplaceId } from "./marketplace";
import { parseBrowseSearchResponse, readWarnings } from "./parse";
import { buildEbayPublicSearchUrl } from "./public-url";
import { withDetail, withResponseTrace } from "./traced-fetch";

export { resetEbayTokenCache } from "./auth";

const UNAUTHORIZED = Symbol("unauthorized");

/** The configured marketplace id, or the search country's default. Throws on a malformed override. */
function resolveMarketplaceId(query: SearchQuery, ctx: AdapterContext): string {
  const override = marketplaceIdOverride(ctx);
  if (!override) return defaultMarketplaceId(query.location.countryCode);
  const id = normalizeMarketplaceId(override);
  if (!id) throw new NotConfiguredError(invalidMarketplaceIdMessage(override), "ebay");
  return id;
}

/** One Browse call; resolves to UNAUTHORIZED on 401 so the caller can refresh the token once. */
async function callBrowse(ctx: AdapterContext, url: string, headers: Record<string, string>): Promise<unknown> {
  const { ctx: traced, trace } = withResponseTrace(ctx);
  try {
    return await fetchJson(traced, "ebay", url, { headers });
  } catch (err) {
    if (trace.status === 401) return UNAUTHORIZED;
    throw withDetail(err, trace);
  }
}

async function searchEbay(query: SearchQuery, ctx: AdapterContext): Promise<ScrapedListing[]> {
  const creds = resolveEbayCredentials(ctx);
  if (!creds) {
    const hasId = Boolean(ctx.credentials.ebayClientId?.trim());
    const hasSecret = Boolean(ctx.credentials.ebayClientSecret?.trim());
    throw new NotConfiguredError(missingCredentialsMessage(hasId, hasSecret), "ebay");
  }
  const marketplaceId = resolveMarketplaceId(query, ctx);
  if (!query.keywords.trim() && !ebayCategoryId(query.category, marketplaceId)) {
    throw new MarketplaceError("eBay search needs keywords (or a category eBay supports)", "ebay", false);
  }
  const currency = marketplaceCurrency(marketplaceId, query.location.countryCode);
  const url = buildBrowseSearchUrl(query, marketplaceId, currency, ebaySearchOptions());

  let token = await getEbayAccessToken(ctx, creds);
  let body = await callBrowse(ctx, url, buildBrowseHeaders(token, marketplaceId, query.location));
  if (body === UNAUTHORIZED) {
    // Revoked or expired early: mint a fresh token and try exactly once more.
    ctx.log?.("eBay rejected the cached access token (401); refreshing it");
    invalidateEbayAccessToken(creds, token);
    token = await getEbayAccessToken(ctx, creds);
    body = await callBrowse(ctx, url, buildBrowseHeaders(token, marketplaceId, query.location));
    if (body === UNAUTHORIZED) {
      invalidateEbayAccessToken(creds, token);
      throw new BlockedError(
        "eBay rejected a freshly issued access token (401). Check that your keyset is a Production keyset with Browse API access.",
        "ebay",
      );
    }
  }

  for (const warning of readWarnings(body)) ctx.log?.(`eBay warning: ${warning}`);
  return parseBrowseSearchResponse(body, currency);
}

/** request() classifies HTTP failures, but reading a body can still time out or reset mid-stream. */
function asMarketplaceError(err: unknown): MarketplaceError {
  if (err instanceof MarketplaceError) return err;
  return new MarketplaceError(`eBay request failed: ${err instanceof Error ? err.message : String(err)}`, "ebay");
}

const adapter: MarketplaceAdapter = {
  id: "ebay",
  displayName: "eBay",
  countries: ["US", "CA"],
  // The Browse API allows 5,000 calls/day by default; one search every 60 s already uses ~1,440.
  minIntervalSec: 60,

  status: ebayStatus,

  buildSearchUrl(query) {
    const marketplaceId =
      normalizeMarketplaceId(marketplaceIdOverride()) ?? defaultMarketplaceId(query.location.countryCode);
    return buildEbayPublicSearchUrl(query, marketplaceId, ebaySearchOptions());
  },

  search(query, ctx) {
    return searchEbay(query, ctx).catch((err: unknown) => {
      throw asMarketplaceError(err);
    });
  },
};

export default adapter;
