/**
 * Maps eBay Browse API `item_summary/search` responses to ScrapedListings.
 *
 * Shape follows https://developer.ebay.com/api-docs/buy/browse/resources/item_summary/methods/search
 * (ItemSummary). The test fixtures are hand-written from those docs — re-verify field names against a
 * live response whenever eBay versions the API or results start coming back empty.
 */
import type { ScrapedListing } from "../../types";
import { parsePriceToCents } from "../http";
import { ParseError } from "../types";
import type { JsonObject } from "../json";
import { asArray, asDate, asHttpUrl, asObject, asString, collapseWhitespace, plausibleCents } from "../json";

interface Price {
  cents: number | null;
  currency?: string;
}

function readAmount(value: unknown): Price | undefined {
  const amount = asObject(value);
  if (!amount) return undefined;
  const cents = plausibleCents(parsePriceToCents(asString(amount.value) ?? null));
  if (cents === null) return undefined;
  const currency = asString(amount.currency)?.toUpperCase();
  return { cents, currency: currency && /^[A-Z]{3}$/.test(currency) ? currency : undefined };
}

/**
 * The price a flipper can pay right now: `price` (Buy It Now) for fixed-price listings and for auctions
 * that also offer Buy It Now. Auction-only listings have none — a bid only goes up and a new auction's
 * is its opening bid, which would score as a huge deal and report false price drops — so they are
 * unpriced (bids stay in `raw`), including an auction whose Buy It Now went away with the first bid.
 */
function selectPrice(item: JsonObject): Price {
  const options = asArray(item.buyingOptions);
  if (options.includes("AUCTION") && !options.includes("FIXED_PRICE")) {
    return { cents: null, currency: (readAmount(item.currentBidPrice) ?? readAmount(item.price))?.currency };
  }
  return readAmount(item.price) ?? { cents: null };
}

/** An eBay website host (www.ebay.com, www.ebay.co.uk, …); anything else is not trusted for links. */
const EBAY_HOST = /^(?:www\.)?ebay\.(?:com|ca|co\.uk|com\.au|de|fr|it|es|ie)$/i;

/**
 * `https://{host}/itm/{legacyItemId}`: itemWebUrl carries tracking parameters that change between
 * responses, so the listing URL is rebuilt from the id, on the host eBay linked to (and keeping the
 * variation). Falls back to itemWebUrl when there is no usable legacy id.
 */
function itemUrl(item: JsonObject): string | undefined {
  const webUrl = asHttpUrl(item.itemWebUrl);
  const legacyId = asString(item.legacyItemId);
  if (!legacyId || !/^\d+$/.test(legacyId)) return webUrl;
  const webHost = webUrl ? new URL(webUrl).hostname : "";
  const host = EBAY_HOST.test(webHost) ? webHost : "www.ebay.com";
  // RESTful item ids are "v1|<legacy item id>|<variation id or 0>".
  const variation = asString(item.itemId)?.split("|")[2];
  const query = variation && /^\d+$/.test(variation) && variation !== "0" ? `?var=${variation}` : "";
  return `https://${host}/itm/${legacyId}${query}`;
}

function imageUrls(item: JsonObject): string[] {
  const candidates = [
    asObject(item.image)?.imageUrl,
    ...asArray(item.additionalImages).map((img) => asObject(img)?.imageUrl),
  ];
  if (!candidates.some(Boolean)) {
    candidates.push(...asArray(item.thumbnailImages).map((img) => asObject(img)?.imageUrl));
  }
  const urls = candidates.map(asHttpUrl).filter((url): url is string => Boolean(url));
  return [...new Set(urls)];
}

/** "Seattle, WA, US"; search results often only carry a masked postal code ("981**") and country. */
function locationText(item: JsonObject): string | null {
  const loc = asObject(item.itemLocation);
  if (!loc) return null;
  const city = asString(loc.city);
  const region = asString(loc.stateOrProvince);
  const postal = city || region ? undefined : asString(loc.postalCode);
  const parts = [city, region, postal, asString(loc.country)].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

function rawSnapshot(item: JsonObject): JsonObject {
  const seller = asObject(item.seller);
  return {
    itemId: item.itemId,
    legacyItemId: item.legacyItemId,
    buyingOptions: item.buyingOptions,
    currentBidPrice: item.currentBidPrice,
    bidCount: item.bidCount,
    itemEndDate: item.itemEndDate,
    conditionId: item.conditionId,
    categoryIds: asArray(item.categories).map((c) => asObject(c)?.categoryId),
    sellerFeedbackPercentage: seller?.feedbackPercentage,
    sellerFeedbackScore: seller?.feedbackScore,
    itemLocation: item.itemLocation,
    distanceFromPickupLocation: item.distanceFromPickupLocation,
  };
}

/** One ItemSummary → ScrapedListing, or null when it lacks an id, title or URL. */
export function mapItemSummary(value: unknown, fallbackCurrency: string): ScrapedListing | null {
  const item = asObject(value);
  if (!item) return null;
  const externalId = asString(item.itemId);
  const title = asString(item.title);
  const url = itemUrl(item);
  if (!externalId || !title || !url) return null;

  const price = selectPrice(item);
  const seller = asObject(item.seller);
  return {
    marketplace: "ebay",
    externalId,
    url,
    title: collapseWhitespace(title),
    priceCents: price.cents,
    currency: price.currency ?? fallbackCurrency,
    description: asString(item.shortDescription) ?? null,
    imageUrls: imageUrls(item),
    locationText: locationText(item),
    lat: null,
    lng: null,
    postedAt: asDate(item.itemCreationDate) ?? asDate(item.itemOriginDate),
    sellerName: asString(seller?.username) ?? null,
    condition: asString(item.condition) ?? null,
    raw: rawSnapshot(item),
  };
}

/** Whole search response → listings in eBay's order (newest first), deduplicated by itemId. */
export function parseBrowseSearchResponse(body: unknown, fallbackCurrency: string): ScrapedListing[] {
  const root = asObject(body);
  if (!root) throw new ParseError("eBay Browse API returned an unexpected (non-object) response", "ebay");
  // eBay omits itemSummaries entirely when nothing matches.
  if (root.itemSummaries === undefined || root.itemSummaries === null) return [];
  if (!Array.isArray(root.itemSummaries)) {
    throw new ParseError("eBay Browse API response has a non-array itemSummaries", "ebay");
  }
  const seen = new Set<string>();
  const listings: ScrapedListing[] = [];
  for (const summary of root.itemSummaries) {
    const listing = mapItemSummary(summary, fallbackCurrency);
    if (!listing || seen.has(listing.externalId)) continue;
    seen.add(listing.externalId);
    listings.push(listing);
  }
  // Results none of which can be read mean the item shape changed; [] would read as "no results".
  if (listings.length === 0 && root.itemSummaries.length > 0) {
    throw new ParseError(
      `eBay Browse API returned ${root.itemSummaries.length} item summaries but none could be read (response format changed?)`,
      "ebay",
    );
  }
  return listings;
}

/** Non-fatal warnings eBay attaches to a 200 response (e.g. an ignored filter). */
export function readWarnings(body: unknown): string[] {
  return asArray(asObject(body)?.warnings)
    .map((w) => {
      const warning = asObject(w);
      return warning && (asString(warning.longMessage) ?? asString(warning.message));
    })
    .filter((message): message is string => Boolean(message));
}
