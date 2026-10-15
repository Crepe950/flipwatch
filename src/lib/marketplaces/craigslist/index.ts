import type { ScrapedListing, SearchQuery } from "../../types";
import { isListingUrlFor, parseCraigslistDescription } from "../description";
import { fetchText, request } from "../http";
import { MarketplaceError, NotConfiguredError, type AdapterContext, type MarketplaceAdapter } from "../types";
import { parseCraigslistSearch } from "./parse";
import { buildCraigslistSearchUrl, CRAIGSLIST_SITE_DIRECTORY_URL, resolveCraigslistSite } from "./url";

/** Drop listings priced outside the query's bounds (unpriced ones are kept) and apply the soft limit. */
function finalizeListings(listings: ScrapedListing[], query: SearchQuery): ScrapedListing[] {
  const { minPriceCents: min, maxPriceCents: max } = query;
  const limit = query.limit !== undefined && query.limit > 0 ? Math.floor(query.limit) : Number.POSITIVE_INFINITY;
  const out: ScrapedListing[] = [];
  for (const listing of listings) {
    const price = listing.priceCents;
    if (price !== null && ((min != null && price < min) || (max != null && price > max))) continue;
    out.push(listing);
    if (out.length >= limit) break;
  }
  return out;
}

function parseUrl(value: string): URL | null {
  try {
    return value ? new URL(value) : null;
  } catch {
    return null;
  }
}

const adapter: MarketplaceAdapter = {
  id: "craigslist",
  displayName: "Craigslist",
  countries: ["US", "CA"],
  minIntervalSec: 60,
  // One search page carries up to ~350 results, so a bigger cap costs no extra requests.
  maxResults: 300,

  status: () => ({ ok: true, message: "No account needed. Listings are read from Craigslist's public search pages." }),

  buildSearchUrl(query) {
    try {
      return buildCraigslistSearchUrl(query);
    } catch (err) {
      // "Open on Craigslist" should still lead somewhere useful for locations no site covers.
      if (err instanceof NotConfiguredError) return CRAIGSLIST_SITE_DIRECTORY_URL;
      throw err;
    }
  },

  async search(query: SearchQuery, ctx: AdapterContext): Promise<ScrapedListing[]> {
    const site = resolveCraigslistSite(query.location);
    const res = await request(ctx, "craigslist", buildCraigslistSearchUrl(query, site));

    // Unknown subdomains redirect to the site directory instead of answering 404.
    const finalUrl = parseUrl(res.url);
    if (finalUrl?.pathname.startsWith("/about/sites")) {
      await res.body?.cancel().catch(() => undefined);
      throw new NotConfiguredError(`"${site.site}" is not a Craigslist site`, "craigslist");
    }

    let html: string;
    try {
      html = await res.text();
    } catch (err) {
      throw new MarketplaceError(`Failed reading the Craigslist response: ${(err as Error).message}`, "craigslist");
    }

    const origin = finalUrl?.hostname.endsWith(".craigslist.org") ? finalUrl.origin : site.origin;
    const listings = parseCraigslistSearch(html, { origin, currency: site.currency });
    const results = finalizeListings(listings, query);
    ctx.log?.(`craigslist/${site.site}: parsed ${listings.length}, returned ${results.length}`);
    return results;
  },

  async fetchDescription(url: string, ctx: AdapterContext): Promise<string | null> {
    if (!isListingUrlFor("craigslist", url)) return null;
    return parseCraigslistDescription(await fetchText(ctx, "craigslist", url));
  },
};

export default adapter;
