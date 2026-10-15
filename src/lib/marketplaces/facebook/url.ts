import type { SearchLocation, SearchQuery } from "../../types";

export const FACEBOOK_ORIGIN = "https://www.facebook.com";

/**
 * Marketplace location path segment: the explicit slug/numeric id when set, else the city part of the
 * label squashed the way Facebook's city slugs are ("San Francisco, CA" → "sanfrancisco").
 */
export function facebookLocationSlug(location: SearchLocation): string | null {
  const explicit = location.facebookLocation?.trim().toLowerCase();
  if (explicit) return explicit;
  const city = location.label.split(",")[0] ?? "";
  const slug = city
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  return slug || null;
}

/**
 * Newest-first Marketplace keyword search. Without a location slug Facebook falls back to the account's
 * saved Marketplace location.
 *
 * Only `query` and `sortBy` are sent. Verified against live pages (Sep 2026): adding `minPrice`/`maxPrice`
 * or `daysSinceListed` makes the server-rendered feed drop the keyword and fill up with unrelated
 * "suggested" listings (a "road bike" search returned apartments and ski boots). The engine applies the
 * search's price bounds and max listing age itself.
 *
 * Always the keyword `/search` page, never a category page such as `/vehicles`: it is unverified whether
 * category pages honour `?query=`, and one that ignored it would alert on every new vehicle nearby.
 */
export function buildFacebookSearchUrl(query: SearchQuery): string {
  const slug = facebookLocationSlug(query.location);
  const base = slug ? `${FACEBOOK_ORIGIN}/marketplace/${encodeURIComponent(slug)}` : `${FACEBOOK_ORIGIN}/marketplace`;

  const params = new URLSearchParams();
  const keywords = query.keywords.trim();
  if (keywords) params.set("query", keywords);
  // "best_match" returns fewer but far more relevant items; the first page of each order differs, so a
  // one-off search can run both. Price-ordered pages were mostly $0–$10 junk, so they aren't offered.
  params.set("sortBy", query.sort === "relevance" ? "best_match" : "creation_time_descend");
  return `${base}/search?${params.toString()}`;
}

export function facebookListingUrl(id: string): string {
  return `${FACEBOOK_ORIGIN}/marketplace/item/${encodeURIComponent(id)}/`;
}
