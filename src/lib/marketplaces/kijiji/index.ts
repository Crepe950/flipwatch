import type { ScrapedListing, SearchQuery } from "../../types";
import { isListingUrlFor, parseKijijiDescription } from "../description";
import { fetchText, request } from "../http";
import { MarketplaceError, type AdapterContext, type MarketplaceAdapter } from "../types";
import { parseKijijiSearch } from "./parse";
import { buildKijijiSearchUrl } from "./url";

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

const adapter: MarketplaceAdapter = {
  id: "kijiji",
  displayName: "Kijiji",
  countries: ["CA"],
  minIntervalSec: 60,
  // No OR syntax: a long "a | b | c" query returns nothing.
  supportsOrQueries: false,

  status: () => ({ ok: true, message: "No account needed. Listings are read from Kijiji's public search pages (Canada only)." }),

  buildSearchUrl: (query) => buildKijijiSearchUrl(query),

  async search(query: SearchQuery, ctx: AdapterContext): Promise<ScrapedListing[]> {
    const url = buildKijijiSearchUrl(query);
    if (query.location.countryCode.toUpperCase() !== "CA") {
      ctx.log?.(`kijiji: search location ${query.location.label} is outside Canada; results may be empty`);
    }
    const res = await request(ctx, "kijiji", url);

    let html: string;
    try {
      html = await res.text();
    } catch (err) {
      throw new MarketplaceError(`Failed reading the Kijiji response: ${(err as Error).message}`, "kijiji");
    }

    const listings = parseKijijiSearch(html);
    const results = finalizeListings(listings, query);
    ctx.log?.(`kijiji: parsed ${listings.length}, returned ${results.length}`);
    return results;
  },

  async fetchDescription(url: string, ctx: AdapterContext): Promise<string | null> {
    if (!isListingUrlFor("kijiji", url)) return null;
    return parseKijijiDescription(await fetchText(ctx, "kijiji", url));
  },
};

export default adapter;
