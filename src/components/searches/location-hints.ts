/**
 * Marketplace hints of a custom location (postal code, Craigslist site, Facebook/Kijiji location)
 * pin a search to one city on those marketplaces. They must follow the coordinates: hints copied from
 * a preset or left over from old coordinates make a "Kelowna" search poll Vancouver. Pure helpers,
 * client-safe.
 */
import type { LocationFormValues } from "./form-values";

export const HINT_KEYS = ["postalCode", "craigslistSite", "facebookLocation", "kijijiLocationId", "kijijiLocationSlug"] as const;

export function hasHints(location: LocationFormValues): boolean {
  return HINT_KEYS.some((key) => location[key].trim() !== "");
}

export function withoutHints(location: LocationFormValues): LocationFormValues {
  return { ...location, postalCode: "", craigslistSite: "", facebookLocation: "", kijijiLocationId: "", kijijiLocationSlug: "" };
}

export interface CraigslistSiteOption {
  site: string;
  label: string;
  countryCode: string;
  lat: number;
  lng: number;
}

/** Great-circle distance in km. */
function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(s)));
}

function coordinates(location: LocationFormValues): { lat: number; lng: number } | null {
  if (!location.lat.trim() || !location.lng.trim()) return null;
  const lat = Number(location.lat);
  const lng = Number(location.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

export interface CraigslistSiteMismatch {
  /** The chosen site (its main entry). */
  site: CraigslistSiteOption;
  distanceKm: number;
  /** The site the engine would pick for these coordinates instead, when there is one nearby. */
  nearest: CraigslistSiteOption | null;
}

/**
 * The typed Craigslist site when it is a known site further than `maxDistanceKm` from the
 * coordinates (results would come from somewhere else), else null. `sites` may list a sprawling site
 * more than once (extra points); its first entry is the main one. The suggested replacement follows
 * the engine's rule: the nearest site in the location's own country when one is in range.
 */
export function craigslistSiteMismatch(
  location: LocationFormValues,
  sites: readonly CraigslistSiteOption[],
  maxDistanceKm: number,
): CraigslistSiteMismatch | null {
  const point = coordinates(location);
  const typed = location.craigslistSite.trim().toLowerCase();
  if (!point || !typed) return null;
  const entries = sites.filter((s) => s.site === typed);
  if (entries.length === 0) return null;
  const distanceKm = Math.min(...entries.map((s) => haversineKm(point, s)));
  if (distanceKm <= maxDistanceKm) return null;

  const country = location.countryCode.trim().toUpperCase();
  let nearest: { site: CraigslistSiteOption; km: number } | null = null;
  for (const s of sites) {
    if (s.countryCode !== country) continue;
    const km = haversineKm(point, s);
    if (!nearest || km < nearest.km) nearest = { site: s, km };
  }
  const suggestion = nearest && nearest.km <= maxDistanceKm ? (sites.find((s) => s.site === nearest.site.site) ?? null) : null;
  return { site: entries[0], distanceKm, nearest: suggestion };
}
