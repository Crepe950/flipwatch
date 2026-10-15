import type { CategoryId, SearchLocation, SearchQuery } from "../../types";
import { KIJIJI_ORIGIN } from "./common";

export interface KijijiCategory {
  /** Path slug after "b-". Kijiji routes on the numeric code and redirects to its canonical slug. */
  slug: string;
  id: number;
}

/** null = all categories (the /b-{location}/… URL form without a c-code). */
export const KIJIJI_CATEGORIES: Record<CategoryId, KijijiCategory | null> = {
  any: null,
  electronics: { slug: "electronics", id: 15 },
  computers: { slug: "computer", id: 16 },
  phones: { slug: "cell-phone", id: 760 },
  video_games: { slug: "video-games-consoles", id: 141 },
  furniture: { slug: "furniture", id: 235 },
  appliances: { slug: "appliance", id: 107 },
  tools: { slug: "tool", id: 110 },
  bikes: { slug: "bikes", id: 644 },
  sporting_goods: { slug: "sporting-goods-exercise", id: 111 },
  cars_trucks: { slug: "cars-trucks", id: 174 },
  motorcycles: { slug: "motorcycles", id: 30 },
  boats: { slug: "boats-watercraft", id: 29 },
  rvs_campers: { slug: "rv-camper-trailer", id: 301 },
  // Kijiji files travel and utility trailers under "RVs, Campers & Trailers".
  trailers: { slug: "rv-camper-trailer", id: 301 },
  free: { slug: "free-stuff", id: 17220001 },
};

export const CANADA_WIDE = { slug: "canada", id: "0" } as const;

/**
 * URL-safe slug: accents folded, lowercase, runs of anything but letters/digits → "-".
 * Non-Latin letters survive (percent-encoded) so e.g. Chinese keywords still search.
 */
export function kijijiSlug(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return encodeURIComponent(slug);
}

/** Kijiji location (slug + numeric id); Canada-wide when the location has no Kijiji id. */
export function kijijiLocation(location: SearchLocation): { slug: string; id: string } {
  const id = location.kijijiLocationId?.trim();
  if (!id || !/^\d+$/.test(id)) return { ...CANADA_WIDE };
  const slug = kijijiSlug(location.kijijiLocationSlug ?? "") || kijijiSlug(location.label) || CANADA_WIDE.slug;
  return { slug, id };
}

function formatCoordinate(value: number): string {
  return String(Number(value.toFixed(6)));
}

/**
 * https://www.kijiji.ca/b-{category}/{location}/{keywords}/k0c{categoryId}l{locationId}?sort=dateDesc&…
 * or, for any category, https://www.kijiji.ca/b-{location}/{keywords}/k0l{locationId}?…
 */
export function buildKijijiSearchUrl(query: SearchQuery): string {
  const category = KIJIJI_CATEGORIES[query.category ?? "any"] ?? null;
  const location = kijijiLocation(query.location);
  const keywords = kijijiSlug(query.keywords);

  const segments = category ? [`b-${category.slug}`, location.slug] : [`b-${location.slug}`];
  if (keywords) segments.push(keywords);
  segments.push(`${keywords ? "k0" : ""}${category ? `c${category.id}` : ""}l${location.id}`);

  const params = new URLSearchParams({ sort: "dateDesc" });
  const { radiusKm, label, lat, lng } = query.location;
  if (Number.isFinite(radiusKm) && radiusKm > 0) params.set("radius", String(Math.round(radiusKm * 10) / 10));
  if (label?.trim()) params.set("address", label.trim());
  if (Number.isFinite(lat) && Number.isFinite(lng)) params.set("ll", `${formatCoordinate(lat)},${formatCoordinate(lng)}`);

  // Whole dollars, rounded outward so the bounds stay inclusive; an open bound is left empty. The
  // native free-stuff category needs no price bound (many free posts have no price at all).
  if (query.category !== "free") {
    const min = query.minPriceCents != null && query.minPriceCents > 0 ? String(Math.floor(query.minPriceCents / 100)) : "";
    const max = query.maxPriceCents != null && query.maxPriceCents >= 0 ? String(Math.ceil(query.maxPriceCents / 100)) : "";
    if (min || max) params.set("price", `${min}__${max}`);
  }

  return `${KIJIJI_ORIGIN}/${segments.join("/")}?${params.toString()}`;
}
