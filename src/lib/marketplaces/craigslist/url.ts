import { currencyForCountry } from "../../locations";
import type { CategoryId, SearchLocation, SearchQuery } from "../../types";
import { kmToMiles } from "../http";
import { NotConfiguredError } from "../types";
import { findCraigslistSite, MAX_SITE_DISTANCE_KM, nearestCraigslistSite } from "./sites";

/** Craigslist "for sale" category codes (the path segment after /search/). */
export const CRAIGSLIST_CATEGORY_CODES: Record<CategoryId, string> = {
  any: "sss",
  electronics: "ela",
  computers: "sya",
  phones: "moa",
  video_games: "vga",
  furniture: "fua",
  appliances: "ppa",
  tools: "tla",
  bikes: "bia",
  sporting_goods: "sga",
  cars_trucks: "cta",
  motorcycles: "mca",
  boats: "boo",
  rvs_campers: "rva",
  trailers: "tra",
  free: "zip",
};

/** Where to send people when no Craigslist site covers their location. */
export const CRAIGSLIST_SITE_DIRECTORY_URL = "https://www.craigslist.org/about/sites";

const SITE_PATTERN = /^[a-z0-9-]+$/;

export interface ResolvedCraigslistSite {
  site: string;
  /** e.g. https://vancouver.craigslist.org */
  origin: string;
  /** Currency listings on this site are priced in. */
  currency: string;
}

/**
 * Pick the Craigslist site for a location: the explicit `craigslistSite` when set, otherwise the
 * nearest known site, preferring one in the location's country. Throws NotConfiguredError when
 * nothing is within MAX_SITE_DISTANCE_KM.
 */
export function resolveCraigslistSite(location: SearchLocation): ResolvedCraigslistSite {
  const explicit = location.craigslistSite?.trim().toLowerCase();
  if (explicit) {
    if (!SITE_PATTERN.test(explicit)) {
      throw new NotConfiguredError(`Invalid Craigslist site "${explicit}" (expected a subdomain like "vancouver")`, "craigslist");
    }
    const known = findCraigslistSite(explicit);
    return withOrigin(explicit, known?.countryCode ?? location.countryCode);
  }

  const nearest = nearestCraigslistSite(location);
  if (!nearest || nearest.distanceKm > MAX_SITE_DISTANCE_KM) {
    throw new NotConfiguredError(
      `No known Craigslist site within ${MAX_SITE_DISTANCE_KM} km of ${location.label}; set the Craigslist site on the search location`,
      "craigslist",
    );
  }
  return withOrigin(nearest.site.site, nearest.site.countryCode);
}

function withOrigin(site: string, countryCode: string): ResolvedCraigslistSite {
  return { site, origin: `https://${site}.craigslist.org`, currency: currencyForCountry(countryCode || "US") };
}

/**
 * Search URL for a query on `site` (resolved from the query's location by default).
 * Throws NotConfiguredError when no Craigslist site covers the location.
 */
export function buildCraigslistSearchUrl(query: SearchQuery, site: ResolvedCraigslistSite = resolveCraigslistSite(query.location)): string {
  const { origin } = site;
  const category = CRAIGSLIST_CATEGORY_CODES[query.category ?? "any"] ?? CRAIGSLIST_CATEGORY_CODES.any;
  const params = new URLSearchParams();

  const keywords = query.keywords.trim().replace(/\s+/g, " ");
  if (keywords) params.set("query", keywords);
  params.set("sort", "date");
  params.set("bundleDuplicates", "1");

  // Craigslist filters on whole dollars; round outward so the bounds stay inclusive. The native
  // free category ("zip") has no prices, so a price bound there would only hide posts.
  const nativeFree = query.category === "free";
  if (!nativeFree && query.minPriceCents != null && query.minPriceCents > 0) {
    params.set("min_price", String(Math.floor(query.minPriceCents / 100)));
  }
  if (!nativeFree && query.maxPriceCents != null && query.maxPriceCents >= 0) {
    params.set("max_price", String(Math.ceil(query.maxPriceCents / 100)));
  }

  const { radiusKm, postalCode, lat, lng } = query.location;
  if (Number.isFinite(radiusKm) && radiusKm > 0) {
    params.set("search_distance", String(Math.max(1, Math.round(kmToMiles(radiusKm)))));
    const postal = postalCode?.replace(/\s+/g, "").toUpperCase();
    if (postal) {
      params.set("postal", postal);
    } else if (Number.isFinite(lat) && Number.isFinite(lng)) {
      // Without a postal code the radius is centred on the map point instead.
      params.set("lat", lat.toFixed(4));
      params.set("lon", lng.toFixed(4));
    }
  }

  return `${origin}/search/${category}?${params.toString()}`;
}
