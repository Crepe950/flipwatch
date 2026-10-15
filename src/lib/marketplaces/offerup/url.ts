import type { SearchQuery } from "../../types";
import { kmToMiles } from "../http";

export const OFFERUP_ORIGIN = "https://offerup.com";

/** The radius choices OfferUp's own search UI offers, in miles. */
const DISTANCE_OPTIONS_MILES = [5, 10, 20, 30, 50];
const MAX_DISTANCE_MILES = 50;

/**
 * Smallest UI radius that covers the search radius, capped at the largest option. Sticking to the
 * values the site itself sends keeps us from tripping validation on an undocumented endpoint.
 */
export function offerUpDistanceMiles(radiusKm: number): number {
  const miles = Math.round(kmToMiles(radiusKm));
  return DISTANCE_OPTIONS_MILES.find((option) => option >= miles) ?? MAX_DISTANCE_MILES;
}

/** Whole-dollar bounds: the minimum rounds down and the maximum up so rounding never hides a match. */
export function offerUpPriceBounds(query: SearchQuery): { min?: string; max?: string } {
  return {
    min: query.minPriceCents != null && query.minPriceCents > 0 ? String(Math.floor(query.minPriceCents / 100)) : undefined,
    max: query.maxPriceCents != null && query.maxPriceCents >= 0 ? String(Math.ceil(query.maxPriceCents / 100)) : undefined,
  };
}

/** Four decimals (~11 m) is plenty for a search centre and keeps URLs stable across polls. */
export function offerUpCoordinate(value: number): string {
  return value.toFixed(4);
}

/**
 * The web search page, newest first. The page's feed query forwards URL parameters as its search
 * params, so `lat`/`lon` (the GraphQL keys) are sent as location hints; if OfferUp ignores them it
 * falls back to the requester's IP location. Re-verify against a live page.
 */
export function buildOfferUpSearchUrl(query: SearchQuery): string {
  const params = new URLSearchParams({ q: query.keywords.trim(), SORT: "-posted" });
  const { min, max } = offerUpPriceBounds(query);
  if (min) params.set("PRICE_MIN", min);
  if (max) params.set("PRICE_MAX", max);
  params.set("DISTANCE", String(offerUpDistanceMiles(query.location.radiusKm)));
  params.set("lat", offerUpCoordinate(query.location.lat));
  params.set("lon", offerUpCoordinate(query.location.lng));
  return `${OFFERUP_ORIGIN}/search?${params.toString()}`;
}

export function offerUpListingUrl(listingId: string): string {
  return `${OFFERUP_ORIGIN}/item/detail/${encodeURIComponent(listingId)}`;
}
