/**
 * Listing extraction for OfferUp, which has no public API. The shapes are reconstructed by hand from the
 * web app's embedded state (__NEXT_DATA__ / Apollo cache) and its GraphQL `GetModularFeed` responses —
 * re-verify against live responses whenever results dry up. Rather than hard-coding a path, we walk any
 * JSON blob for objects that look like listings, so moved or renamed wrappers don't break parsing.
 */
import type { ScrapedListing } from "../../types";
import { parsePriceToCents, walkObjects } from "../http";
import { ParseError } from "../types";
import type { JsonObject } from "../json";
import { asArray, asDate, asHttpUrl, asObject, asString, collapseWhitespace, plausibleCents } from "../json";
import { offerUpListingUrl } from "./url";

export function isOfferUpListingNode(node: JsonObject): boolean {
  return asString(node.listingId) !== undefined && asString(node.title) !== undefined && "price" in node;
}

/** `image: {url}` on feed tiles; `images[]` / legacy `photos[].images.detail` on richer listing objects. */
function imageUrls(node: JsonObject): string[] {
  const candidates: unknown[] = [asObject(node.image)?.url];
  for (const image of asArray(node.images)) {
    const obj = asObject(image);
    candidates.push(obj ? (obj.url ?? asObject(obj.detailFull)?.url ?? asObject(obj.detail)?.url) : image);
  }
  for (const photo of asArray(node.photos)) {
    const sizes = asObject(asObject(photo)?.images);
    candidates.push(asObject(sizes?.detailFull)?.url ?? asObject(sizes?.detail)?.url ?? asObject(sizes?.list)?.url);
  }
  const urls = candidates.map(asHttpUrl).filter((url): url is string => Boolean(url));
  return [...new Set(urls)];
}

/** `price` is whole dollars as a string ("380", "1,150.00") or a number; "0" means free. */
function priceCents(price: unknown): number | null {
  return typeof price === "number" || typeof price === "string" ? plausibleCents(parsePriceToCents(price)) : null;
}

function rawSnapshot(node: JsonObject): JsonObject {
  return {
    listingId: node.listingId,
    price: node.price,
    isFirmPrice: node.isFirmPrice,
    flags: node.flags,
    vehicleMiles: node.vehicleMiles,
  };
}

export function mapOfferUpListing(node: JsonObject): ScrapedListing | null {
  const externalId = asString(node.listingId);
  const title = asString(node.title);
  if (!externalId || !title) return null;
  return {
    marketplace: "offerup",
    externalId,
    url: offerUpListingUrl(externalId),
    title: collapseWhitespace(title),
    priceCents: priceCents(node.price),
    currency: "USD",
    description: null,
    imageUrls: imageUrls(node),
    locationText: asString(node.locationName) ?? null,
    lat: null,
    lng: null,
    postedAt: asDate(node.postedAt) ?? asDate(node.postDate),
    sellerName: null,
    condition: asString(node.conditionText) ?? null,
    raw: rawSnapshot(node),
  };
}

/** Every listing found anywhere in the given JSON values, in document order, deduplicated by listingId. */
export function extractOfferUpListings(...blobs: unknown[]): ScrapedListing[] {
  const byId = new Map<string, ScrapedListing>();
  for (const blob of blobs) {
    for (const node of walkObjects(blob)) {
      if (!isOfferUpListingNode(node)) continue;
      const listing = mapOfferUpListing(node);
      if (!listing) continue;
      const existing = byId.get(listing.externalId);
      if (!existing) {
        byId.set(listing.externalId, listing);
      } else {
        // The same listing can appear as a feed tile and as a cache entry; keep the first, fill its gaps.
        if (existing.imageUrls.length === 0) existing.imageUrls = listing.imageUrls;
        existing.postedAt ??= listing.postedAt;
        existing.locationText ??= listing.locationText;
      }
    }
  }
  return [...byId.values()];
}

/** Feed tiles meant to hold a listing (`ModularFeedTileListing`), whether or not the listing could be read. */
export function countListingTiles(...blobs: unknown[]): number {
  let count = 0;
  for (const blob of blobs) {
    for (const node of walkObjects(blob)) {
      if (asString(node.__typename)?.endsWith("TileListing")) count++;
    }
  }
  return count;
}

/**
 * GraphQL `GetModularFeed` response → listings. A response without a feed, or with listing tiles none
 * of which can be read (the listing shape changed — not "no results"), is a hard error.
 */
export function parseModularFeedResponse(body: unknown): ScrapedListing[] {
  const root = asObject(body);
  const feed = asObject(asObject(root?.data)?.modularFeed);
  if (!feed) {
    const message = asString(asObject(asArray(root?.errors)[0])?.message);
    throw new ParseError(
      message ? `OfferUp GraphQL error: ${message.slice(0, 200)}` : "OfferUp GraphQL response has no modularFeed",
      "offerup",
    );
  }
  const listings = extractOfferUpListings(feed);
  const tiles = listings.length === 0 ? countListingTiles(feed) : 0;
  if (tiles > 0) {
    throw new ParseError(`OfferUp GraphQL feed has ${tiles} listing tiles but none could be read (response format changed?)`, "offerup");
  }
  return listings;
}
