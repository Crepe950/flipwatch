/**
 * Listing extraction for Facebook Marketplace search pages. Marketplace has no public API; these field
 * names come from the Relay data embedded in logged-in search pages (GroupCommerceProductItem nodes
 * under marketplace_search.feed_units.edges) and were reconstructed by hand — re-verify against a live
 * page whenever results dry up. We walk for listing-shaped objects instead of following a fixed path, so
 * wrapper changes don't break parsing: inside `marketplace_search` when the page has one (so "recently
 * viewed" and suggestion rails don't leak in), otherwise across every embedded blob.
 */
import type { ScrapedListing } from "../../types";
import { parsePriceToCents, walkObjects } from "../http";
import type { JsonObject } from "../json";
import { asArray, asDate, asHttpUrl, asObject, asString, collapseWhitespace, plausibleCents } from "../json";
import { facebookListingUrl } from "./url";

export interface FacebookParseResult {
  listings: ScrapedListing[];
  /** A marketplace search feed was present (possibly empty) — distinguishes "no results" from "page changed". */
  sawSearchFeed: boolean;
  /** Listing objects in the feed's edges that are not listing-shaped; with no listings, the item shape changed. */
  unreadableFeedListings: number;
}

function listingTitle(node: JsonObject): string | undefined {
  return asString(node.marketplace_listing_title) ?? asString(node.custom_title);
}

export function isFacebookListingNode(node: JsonObject): boolean {
  return asString(node.id) !== undefined && listingTitle(node) !== undefined && asObject(node.listing_price) !== undefined;
}

/**
 * `amount` is a decimal string ("450.00"); `amount_with_offset_in_currency` is minor units ("45000");
 * `formatted_amount` is display text ("CA$450", "Free").
 */
export function facebookPriceCents(listingPrice: JsonObject): number | null {
  const amount = asString(listingPrice.amount);
  if (amount && /^\d+(\.\d+)?$/.test(amount)) return plausibleCents(Math.round(Number(amount) * 100));
  const minorUnits = asString(listingPrice.amount_with_offset_in_currency);
  if (minorUnits && /^\d+$/.test(minorUnits)) return plausibleCents(Number(minorUnits));
  return plausibleCents(parsePriceToCents(asString(listingPrice.formatted_amount) ?? null));
}

function currencyOf(listingPrice: JsonObject, fallback: string): string {
  const currency = asString(listingPrice.currency)?.toUpperCase();
  return currency && /^[A-Z]{3}$/.test(currency) ? currency : fallback;
}

function imageUrls(node: JsonObject): string[] {
  const primary = asObject(node.primary_listing_photo);
  const candidates: unknown[] = [asObject(primary?.image)?.uri, asObject(primary?.listing_image)?.uri];
  for (const photo of asArray(node.listing_photos)) candidates.push(asObject(asObject(photo)?.image)?.uri);
  const urls = candidates.map(asHttpUrl).filter((url): url is string => Boolean(url));
  return [...new Set(urls)];
}

function locationText(node: JsonObject): string | null {
  const geocode = asObject(asObject(node.location)?.reverse_geocode);
  if (!geocode) return null;
  const display = asString(asObject(geocode.city_page)?.display_name);
  if (display) return display;
  const parts = [asString(geocode.city), asString(geocode.state)].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

function rawSnapshot(node: JsonObject): JsonObject {
  return {
    id: node.id,
    listing_price: node.listing_price,
    is_live: node.is_live,
    delivery_types: node.delivery_types,
    marketplace_listing_category_id: node.marketplace_listing_category_id,
    subtitles: asArray(node.custom_sub_titles_with_rendering_flags).map((s) => asObject(s)?.subtitle),
  };
}

export function isUnavailable(node: JsonObject): boolean {
  return node.is_sold === true || node.is_pending === true || node.is_hidden === true;
}

export function mapFacebookListing(node: JsonObject, fallbackCurrency: string): ScrapedListing | null {
  const externalId = asString(node.id);
  const title = listingTitle(node);
  const listingPrice = asObject(node.listing_price);
  if (!externalId || !title || !listingPrice) return null;
  return {
    marketplace: "facebook",
    externalId,
    url: facebookListingUrl(externalId),
    title: collapseWhitespace(title),
    priceCents: facebookPriceCents(listingPrice),
    currency: currencyOf(listingPrice, fallbackCurrency),
    description: null,
    imageUrls: imageUrls(node),
    locationText: locationText(node),
    lat: null,
    lng: null,
    postedAt: asDate(node.creation_time),
    sellerName: asString(asObject(node.marketplace_listing_seller)?.name) ?? null,
    condition: null,
    raw: rawSnapshot(node),
  };
}

/** `marketplace_search` objects: the search feed proper, as opposed to suggestions elsewhere on the page. */
function searchFeedRoots(blobs: unknown[]): JsonObject[] {
  const roots: JsonObject[] = [];
  for (const blob of blobs) {
    for (const node of walkObjects(blob)) {
      const feed = asObject(node.marketplace_search);
      if (feed) roots.push(feed);
    }
  }
  return roots;
}

/**
 * Available listings in page order, deduplicated by id. When the search feed is recognisable only its
 * listings count; otherwise every listing-shaped object on the page does (survives a feed rename).
 */
export function extractFacebookListings(blobs: unknown[], fallbackCurrency: string): FacebookParseResult {
  const roots = searchFeedRoots(blobs);
  const scope: unknown[] = roots.length ? roots : blobs;
  const byId = new Map<string, ScrapedListing>();
  const unavailable = new Set<string>();
  let sawSearchFeed = roots.length > 0;
  let unreadableFeedListings = 0;
  for (const blob of scope) {
    for (const node of walkObjects(blob)) {
      if ("feed_units" in node) {
        sawSearchFeed = true;
        for (const edge of asArray(asObject(node.feed_units)?.edges)) {
          const listing = asObject(asObject(asObject(edge)?.node)?.listing);
          if (listing && !isFacebookListingNode(listing)) unreadableFeedListings++;
        }
      }
      const id = asString(node.id);
      if (!id || !isFacebookListingNode(node)) continue;
      if (isUnavailable(node)) {
        // A copy marked sold/pending/hidden (e.g. in a later streamed chunk) wins over a stale "available" one.
        unavailable.add(id);
        byId.delete(id);
        continue;
      }
      if (byId.has(id) || unavailable.has(id)) continue;
      const listing = mapFacebookListing(node, fallbackCurrency);
      if (listing) byId.set(id, listing);
    }
  }
  return { listings: [...byId.values()], sawSearchFeed, unreadableFeedListings };
}
