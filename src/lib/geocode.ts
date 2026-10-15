/**
 * Place search for the area picker, through OpenStreetMap's Nominatim service (free, no key). FlipWatch's
 * marketplaces only cover Canada and the United States, so results are limited to those. Nominatim's usage
 * policy asks for an identifying User-Agent and at most one request per second: requests are spaced out
 * and answers cached, and the area picker only searches when the user asks.
 */
import { nearestCraigslistSite } from "./marketplaces/craigslist/sites";
import type { SearchLocation } from "./types";

const NOMINATIM = "https://nominatim.openstreetmap.org";
const USER_AGENT = "FlipWatch/1.0 (self-hosted marketplace deal finder; https://www.openstreetmap.org/copyright)";
const MIN_GAP_MS = 1_100;
const CACHE_MAX = 200;

export interface Place {
  /** Short name used as the search location's label, e.g. "Kelowna, BC". */
  label: string;
  /** Longer description to tell similar places apart, e.g. "Kelowna, Regional District of Central Okanagan, BC, Canada". */
  detail: string;
  lat: number;
  lng: number;
  countryCode: "CA" | "US";
  postalCode: string | null;
}

interface NominatimResult {
  lat: string;
  lon: string;
  display_name?: string;
  name?: string;
  address?: Record<string, string | undefined>;
}

const state = globalThis as unknown as { __flipwatchGeocode?: { last: number; cache: Map<string, Place[]> } };
const geo = () => (state.__flipwatchGeocode ??= { last: 0, cache: new Map() });

async function politeFetch(url: string, fetchImpl: typeof fetch): Promise<unknown> {
  const g = geo();
  const wait = g.last + MIN_GAP_MS - Date.now();
  g.last = Math.max(Date.now(), g.last + MIN_GAP_MS);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  const res = await fetchImpl(url, { headers: { "User-Agent": USER_AGENT, "Accept-Language": "en" }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Place search failed (HTTP ${res.status}). Try again in a moment.`);
  return res.json();
}

/** "BC" from "CA-BC"; else the state/province name. */
function regionCode(address: Record<string, string | undefined>): string | null {
  const iso = address["ISO3166-2-lvl4"];
  if (iso && /^[A-Z]{2}-[A-Z0-9]{1,3}$/.test(iso)) return iso.split("-")[1];
  return address.state ?? address.province ?? null;
}

export function toPlace(r: NominatimResult): Place | null {
  const lat = Number(r.lat);
  const lng = Number(r.lon);
  const address = r.address ?? {};
  const country = address.country_code?.toUpperCase();
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || (country !== "CA" && country !== "US")) return null;
  const locality =
    address.city ?? address.town ?? address.village ?? address.hamlet ?? address.municipality ?? address.suburb ?? address.county ?? r.name ?? null;
  const region = regionCode(address);
  const label = [locality, region].filter(Boolean).join(", ") || (r.display_name ?? "").split(",").slice(0, 2).join(",").trim();
  if (!label) return null;
  return { label, detail: r.display_name ?? label, lat, lng, countryCode: country, postalCode: address.postcode ?? null };
}

/** Towns, cities, neighbourhoods or addresses matching `query` in Canada and the US (at most 6). */
export async function searchPlaces(query: string, fetchImpl: typeof fetch = fetch): Promise<Place[]> {
  const q = query.trim().slice(0, 120);
  if (q.length < 2) return [];
  const key = `s:${q.toLowerCase()}`;
  const cached = geo().cache.get(key);
  if (cached) return cached;
  const params = new URLSearchParams({ q, format: "jsonv2", addressdetails: "1", limit: "6", countrycodes: "ca,us" });
  const results = (await politeFetch(`${NOMINATIM}/search?${params}`, fetchImpl)) as NominatimResult[];
  const places: Place[] = [];
  const seen = new Set<string>();
  for (const r of Array.isArray(results) ? results : []) {
    const place = toPlace(r);
    if (place && !seen.has(place.detail)) {
      seen.add(place.detail);
      places.push(place);
    }
  }
  remember(key, places);
  return places;
}

/** The town nearest a point the user clicked on the map. */
export async function placeAt(lat: number, lng: number, fetchImpl: typeof fetch = fetch): Promise<Place | null> {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const key = `r:${lat.toFixed(3)},${lng.toFixed(3)}`;
  const cached = geo().cache.get(key);
  if (cached) return cached[0] ?? null;
  const params = new URLSearchParams({ lat: String(lat), lon: String(lng), format: "jsonv2", addressdetails: "1", zoom: "12" });
  const result = (await politeFetch(`${NOMINATIM}/reverse?${params}`, fetchImpl)) as NominatimResult;
  const place = result && typeof result === "object" ? toPlace({ ...result, lat: String(lat), lon: String(lng) }) : null;
  remember(key, place ? [place] : []);
  return place;
}

function remember(key: string, places: Place[]): void {
  const cache = geo().cache;
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(key, places);
}

/**
 * The search location for a picked place: its coordinates and radius (Facebook, Kijiji and eBay search by
 * those) plus the Craigslist site that covers it, when one is close enough.
 */
export function locationFromPlace(place: Pick<Place, "label" | "lat" | "lng" | "countryCode" | "postalCode">, radiusKm: number): SearchLocation {
  const nearest = nearestCraigslistSite({ lat: place.lat, lng: place.lng, countryCode: place.countryCode });
  return {
    label: place.label,
    lat: place.lat,
    lng: place.lng,
    radiusKm: Math.min(500, Math.max(1, Math.round(radiusKm))),
    countryCode: place.countryCode,
    postalCode: place.postalCode ?? null,
    craigslistSite: nearest && nearest.distanceKm <= 150 ? nearest.site.site : null,
  };
}

/** Test hook. */
export function resetGeocodeCache(): void {
  geo().cache.clear();
  geo().last = 0;
}
