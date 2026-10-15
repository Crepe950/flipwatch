import type { SearchLocation, SearchQuery } from "../../types";
import { ebayCategoryId } from "./marketplace";

export const EBAY_BROWSE_SEARCH_URL = "https://api.ebay.com/buy/browse/v1/item_summary/search";
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

export interface EbaySearchOptions {
  /** Also return auctions; by default only Buy It Now / Best Offer listings, which have a price you can pay now. */
  includeAuctions?: boolean;
  /** Only items offered for local pickup within the radius of the search's postal code. */
  localPickupOnly?: boolean;
}

export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

/** Postal codes go inside eBay's filter grammar, so keep only characters that can't break it. */
export function normalizePostalCode(postalCode: string | null | undefined): string | null {
  const cleaned = (postalCode ?? "").toUpperCase().replace(/[^A-Z0-9-]/g, "");
  return cleaned || null;
}

/**
 * eBay price range in whole currency units: `price:[10..50]`, open-ended `price:[10..]` / `price:[..50]`.
 * The minimum rounds down and the maximum up so rounding never excludes a listing the user asked for.
 */
export function buildPriceFilter(
  minPriceCents: number | null | undefined,
  maxPriceCents: number | null | undefined,
  currency: string,
): string[] {
  const min = minPriceCents != null && minPriceCents > 0 ? Math.floor(minPriceCents / 100) : null;
  const max = maxPriceCents != null && maxPriceCents >= 0 ? Math.ceil(maxPriceCents / 100) : null;
  if (min === null && max === null) return [];
  return [`price:[${min ?? ""}..${max ?? ""}]`, `priceCurrency:${currency}`];
}

function normalizeCountry(countryCode: string): string {
  return countryCode.toUpperCase().replace(/[^A-Z]/g, "");
}

/**
 * Items located in the search's country; with `localPickupOnly` (and a postal code), items offered for
 * local pickup within the search radius instead. Pickup-only results are sparse: most eBay sellers ship.
 */
export function buildLocationFilter(location: SearchLocation, localPickupOnly = false): string[] {
  const country = normalizeCountry(location.countryCode);
  const postalCode = localPickupOnly ? normalizePostalCode(location.postalCode) : null;
  if (!postalCode) return [`itemLocationCountry:${country}`];
  return [
    "deliveryOptions:{SELLER_ARRANGED_LOCAL_PICKUP}",
    `pickupCountry:${country}`,
    `pickupPostalCode:${postalCode}`,
    `pickupRadius:${Math.max(1, Math.round(location.radiusKm) || 1)}`,
    "pickupRadiusUnit:km",
  ];
}

/**
 * Auctions are opt-in: their price is a bid that only goes up (a new one's is its opening bid), which
 * would score as a huge deal and report false price drops.
 */
export function buildBuyingOptionsFilter(includeAuctions = false): string {
  return includeAuctions ? "buyingOptions:{FIXED_PRICE|BEST_OFFER|AUCTION}" : "buyingOptions:{FIXED_PRICE|BEST_OFFER}";
}

/** The comma-joined `filter` parameter value (unencoded). */
export function buildBrowseFilter(query: SearchQuery, currency: string, options: EbaySearchOptions = {}): string {
  return [
    ...buildPriceFilter(query.minPriceCents, query.maxPriceCents, currency),
    buildBuyingOptionsFilter(options.includeAuctions),
    ...buildLocationFilter(query.location, options.localPickupOnly),
  ].join(",");
}

/**
 * item_summary/search URL. Values are percent-encoded with encodeURIComponent (space → %20, `|` → %7C,
 * brackets/braces encoded) which is what eBay's docs ask for; eBay decodes before parsing the filter grammar.
 */
export function buildBrowseSearchUrl(query: SearchQuery, marketplaceId: string, currency: string, options: EbaySearchOptions = {}): string {
  const params: Array<[string, string]> = [];
  const keywords = query.keywords.trim();
  if (keywords) params.push(["q", keywords]);
  params.push(["limit", String(clampLimit(query.limit))], ["sort", "newlyListed"]);
  const categoryId = ebayCategoryId(query.category, marketplaceId);
  if (categoryId) params.push(["category_ids", categoryId]);
  params.push(["filter", buildBrowseFilter(query, currency, options)]);
  const search = params.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&");
  return `${EBAY_BROWSE_SEARCH_URL}?${search}`;
}

/** X-EBAY-C-ENDUSERCTX value, e.g. `contextualLocation=country%3DUS%2Czip%3D98101` (value URL-encoded per eBay docs). */
export function buildEndUserContext(location: SearchLocation): string {
  const postalCode = normalizePostalCode(location.postalCode);
  const parts = [`country=${normalizeCountry(location.countryCode)}`];
  if (postalCode) parts.push(`zip=${postalCode}`);
  return `contextualLocation=${encodeURIComponent(parts.join(","))}`;
}

export function buildBrowseHeaders(accessToken: string, marketplaceId: string, location: SearchLocation): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    "X-EBAY-C-MARKETPLACE-ID": marketplaceId,
    "X-EBAY-C-ENDUSERCTX": buildEndUserContext(location),
  };
}
