import type { SearchQuery } from "../../types";
import { kmToMiles } from "../http";
import { normalizePostalCode, type EbaySearchOptions } from "./browse-request";
import { ebayCategoryId, marketplaceCountry, marketplaceDistanceUnit, marketplaceHost } from "./marketplace";

/**
 * The equivalent search on the eBay website, newest first ("Open on eBay"), filtered like the API
 * search: Buy It Now unless auctions are included, and local pickup around the postal code in
 * pickup mode, otherwise items located in the site's country.
 */
export function buildEbayPublicSearchUrl(query: SearchQuery, marketplaceId: string, options: EbaySearchOptions = {}): string {
  const params = new URLSearchParams({ _nkw: query.keywords.trim(), _sop: "10" });
  if (query.minPriceCents != null && query.minPriceCents > 0) {
    params.set("_udlo", String(Math.floor(query.minPriceCents / 100)));
  }
  if (query.maxPriceCents != null && query.maxPriceCents >= 0) {
    params.set("_udhi", String(Math.ceil(query.maxPriceCents / 100)));
  }
  const categoryId = ebayCategoryId(query.category, marketplaceId);
  if (categoryId) params.set("_sacat", categoryId);
  if (!options.includeAuctions) params.set("LH_BIN", "1");

  const { location } = query;
  const postalCode = options.localPickupOnly ? normalizePostalCode(location.postalCode) : null;
  if (postalCode) {
    const radiusKm = Number.isFinite(location.radiusKm) ? location.radiusKm : 0;
    const distance = marketplaceDistanceUnit(marketplaceId) === "mi" ? kmToMiles(radiusKm) : radiusKm;
    params.set("LH_LPickup", "1");
    params.set("_stpos", postalCode);
    params.set("_sadis", String(Math.max(1, Math.round(distance))));
  } else if (marketplaceCountry(marketplaceId) === location.countryCode.toUpperCase()) {
    // "<country> only": the website's counterpart of itemLocationCountry.
    params.set("LH_PrefLoc", "1");
  }
  return `https://${marketplaceHost(marketplaceId)}/sch/i.html?${params.toString()}`;
}
