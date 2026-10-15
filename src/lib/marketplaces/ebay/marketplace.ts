import { currencyForCountry } from "../../locations";
import type { CategoryId } from "../../types";

/**
 * eBay site ids we know the public host, home country, currency and website distance unit for. Other
 * valid ids still work against the API.
 */
const SITES: Record<string, { host: string; country: string; currency: string; distanceUnit: "mi" | "km" }> = {
  EBAY_US: { host: "www.ebay.com", country: "US", currency: "USD", distanceUnit: "mi" },
  EBAY_MOTORS_US: { host: "www.ebay.com", country: "US", currency: "USD", distanceUnit: "mi" },
  EBAY_CA: { host: "www.ebay.ca", country: "CA", currency: "CAD", distanceUnit: "km" },
  EBAY_GB: { host: "www.ebay.co.uk", country: "GB", currency: "GBP", distanceUnit: "mi" },
  EBAY_AU: { host: "www.ebay.com.au", country: "AU", currency: "AUD", distanceUnit: "km" },
  EBAY_DE: { host: "www.ebay.de", country: "DE", currency: "EUR", distanceUnit: "km" },
  EBAY_FR: { host: "www.ebay.fr", country: "FR", currency: "EUR", distanceUnit: "km" },
  EBAY_IT: { host: "www.ebay.it", country: "IT", currency: "EUR", distanceUnit: "km" },
  EBAY_ES: { host: "www.ebay.es", country: "ES", currency: "EUR", distanceUnit: "km" },
  EBAY_IE: { host: "www.ebay.ie", country: "IE", currency: "EUR", distanceUnit: "km" },
};

const MARKETPLACE_ID_PATTERN = /^EBAY_[A-Z]{2}(?:_[A-Z]{2})?$|^EBAY_MOTORS_US$/;

/** Upper-cased marketplace id, or null when it is not shaped like an eBay marketplace id. */
export function normalizeMarketplaceId(raw: string | null | undefined): string | null {
  const id = raw?.trim().toUpperCase();
  return id && MARKETPLACE_ID_PATTERN.test(id) ? id : null;
}

export function defaultMarketplaceId(countryCode: string): string {
  return countryCode.toUpperCase() === "CA" ? "EBAY_CA" : "EBAY_US";
}

export function marketplaceHost(marketplaceId: string): string {
  return SITES[marketplaceId]?.host ?? "www.ebay.com";
}

/** The site's home country, when known. */
export function marketplaceCountry(marketplaceId: string): string | undefined {
  return SITES[marketplaceId]?.country;
}

/** Unit of the website's distance filter (`_sadis`); unknown sites fall back to www.ebay.com's miles. */
export function marketplaceDistanceUnit(marketplaceId: string): "mi" | "km" {
  return SITES[marketplaceId]?.distanceUnit ?? "mi";
}

/** eBay only accepts the marketplace's own currency in the price filter, and prices come back in it. */
export function marketplaceCurrency(marketplaceId: string, countryCode: string): string {
  return SITES[marketplaceId]?.currency ?? currencyForCountry(countryCode);
}

/**
 * eBay leaf/branch category ids from the US category tree (id 0). The EBAY_CA tree (id 2) shares these
 * top-level ids; for any other marketplace we omit category_ids rather than risk an invalid-category error.
 * Re-verify with the Taxonomy API (getCategoryTree) if a category search starts returning nothing.
 */
const CATEGORY_IDS: Partial<Record<CategoryId, string>> = {
  electronics: "293", // Consumer Electronics
  computers: "58058", // Computers/Tablets & Networking
  phones: "9355", // Cell Phones & Smartphones
  video_games: "1249", // Video Games & Consoles
  furniture: "3197", // Home & Garden > Furniture
  appliances: "20710", // Home & Garden > Major Appliances
  tools: "631", // Home & Garden > Tools & Workshop Equipment
  bikes: "177831", // Sporting Goods > Cycling > Bikes
  sporting_goods: "888", // Sporting Goods
  cars_trucks: "6001", // eBay Motors > Cars & Trucks
  motorcycles: "6024", // eBay Motors > Motorcycles
  boats: "26429", // eBay Motors > Boats
  rvs_campers: "50054", // eBay Motors > RVs & Campers
  trailers: "66466", // eBay Motors > Trailers
};

const CATEGORY_MARKETPLACES = new Set(["EBAY_US", "EBAY_MOTORS_US", "EBAY_CA"]);

export function ebayCategoryId(category: CategoryId | null | undefined, marketplaceId: string): string | undefined {
  if (!category || !CATEGORY_MARKETPLACES.has(marketplaceId)) return undefined;
  return CATEGORY_IDS[category];
}
