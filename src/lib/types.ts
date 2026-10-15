/**
 * Core domain types shared by every FlipWatch module.
 *
 * Conventions:
 * - Money is always an integer number of cents (`...Cents`) plus an ISO currency code.
 * - Distances are kilometres.
 * - Timestamps are `Date` objects in code and `timestamptz` in the database.
 */

export const MARKETPLACES = ["craigslist", "kijiji", "ebay", "offerup", "facebook"] as const;
export type MarketplaceId = (typeof MARKETPLACES)[number];

export function isMarketplaceId(value: unknown): value is MarketplaceId {
  return typeof value === "string" && (MARKETPLACES as readonly string[]).includes(value);
}

/** Where a search looks. Per-marketplace hints are optional overrides. */
export interface SearchLocation {
  /** Human label, e.g. "Vancouver, BC". */
  label: string;
  lat: number;
  lng: number;
  radiusKm: number;
  /** ISO 3166-1 alpha-2, e.g. "CA" or "US". */
  countryCode: string;
  postalCode?: string | null;
  /** Craigslist subdomain, e.g. "vancouver" → https://vancouver.craigslist.org */
  craigslistSite?: string | null;
  /** Facebook Marketplace location slug or numeric id, e.g. "vancouver" or "108187565878869". */
  facebookLocation?: string | null;
  /** Kijiji location id, e.g. "1700287" (Vancouver). */
  kijijiLocationId?: string | null;
  /** Kijiji location slug used in URLs, e.g. "vancouver". */
  kijijiLocationSlug?: string | null;
}

/** What a marketplace adapter is asked to fetch. */
export interface SearchQuery {
  /** Free-text query sent to the marketplace. */
  keywords: string;
  minPriceCents?: number | null;
  maxPriceCents?: number | null;
  location: SearchLocation;
  /** Optional marketplace-agnostic category hint (see CATEGORIES). */
  category?: CategoryId | null;
  /** Soft cap on results the adapter should return (adapters may return fewer). */
  limit?: number;
  /**
   * The alternatives of an OR query ("laptop | macbook" → ["laptop", "macbook"]); unset for plain queries.
   * Marketplaces without OR syntax are searched once per alternative (see fetchMarketplace).
   */
  alternatives?: string[];
  /**
   * Result order where the marketplace supports it: "newest" (default; what polling needs) or "relevance"
   * (best match first — surfaces more of the right items for one-off searches such as Deal Hunt).
   */
  sort?: "newest" | "relevance";
  /**
   * How many result pages to fetch where the marketplace pages (Facebook: 24 per page). Default 1 — polling
   * only needs the newest page; one-off searches such as Deal Hunt ask for more.
   */
  pages?: number;
  /** A search the user is waiting on (Deal Hunt, price check) rather than scheduled polling. */
  interactive?: boolean;
}

/** A listing as returned by a marketplace adapter, before it is persisted. */
export interface ScrapedListing {
  marketplace: MarketplaceId;
  /** Stable id on the marketplace; together with `marketplace` it is the listing's identity. */
  externalId: string;
  url: string;
  title: string;
  /** null when the listing has no price / "contact for price". 0 for "free". */
  priceCents: number | null;
  currency: string;
  description?: string | null;
  imageUrls: string[];
  locationText?: string | null;
  lat?: number | null;
  lng?: number | null;
  postedAt?: Date | null;
  sellerName?: string | null;
  condition?: string | null;
  /** Small, JSON-serialisable snapshot of the source record for debugging. Keep it under ~4 KB. */
  raw?: unknown;
}

export const CATEGORIES = [
  "any",
  "electronics",
  "computers",
  "phones",
  "video_games",
  "furniture",
  "appliances",
  "tools",
  "bikes",
  "sporting_goods",
  "cars_trucks",
  "motorcycles",
  "boats",
  "rvs_campers",
  "trailers",
  "free",
] as const;
export type CategoryId = (typeof CATEGORIES)[number];

export const CATEGORY_LABELS: Record<CategoryId, string> = {
  any: "Any category",
  electronics: "Electronics",
  computers: "Computers",
  phones: "Cell phones",
  video_games: "Video games",
  furniture: "Furniture",
  appliances: "Appliances",
  tools: "Tools",
  bikes: "Bikes",
  sporting_goods: "Sporting goods",
  cars_trucks: "Cars & trucks",
  motorcycles: "Motorcycles",
  boats: "Boats",
  rvs_campers: "RVs & campers",
  trailers: "Trailers",
  free: "Free stuff",
};

/** Why a listing surfaced for a search. */
export type MatchEventType = "new" | "price_drop";

/** Pipeline (CRM) stages for a potential flip. */
export const DEAL_STAGES = [
  "lead",
  "contacted",
  "negotiating",
  "purchased",
  "listed",
  "sold",
  "passed",
] as const;
export type DealStage = (typeof DEAL_STAGES)[number];

export const DEAL_STAGE_LABELS: Record<DealStage, string> = {
  lead: "Lead",
  contacted: "Contacted",
  negotiating: "Negotiating",
  purchased: "Purchased",
  listed: "Listed for resale",
  sold: "Sold",
  passed: "Passed",
};

export const NOTIFICATION_CHANNEL_TYPES = [
  "ntfy",
  "discord",
  "discord_bot",
  "slack",
  "telegram",
  "pushover",
  "email",
  "webpush",
  "webhook",
] as const;
export type NotificationChannelType = (typeof NOTIFICATION_CHANNEL_TYPES)[number];

export type AiVerdict = "great" | "good" | "fair" | "pass";
