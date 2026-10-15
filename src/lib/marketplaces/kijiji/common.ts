/** Small, pure helpers shared by the Kijiji parsers. */
import type { ScrapedListing } from "../../types";

export const KIJIJI_ORIGIN = "https://www.kijiji.ca";

export type Json = Record<string, unknown>;

export function asRecord(value: unknown): Json | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined;
}

export function asString(value: unknown): string | undefined {
  if (typeof value === "string") return cleanText(value) || undefined;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

export function cleanText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

export function asCoordinate(value: unknown, limit: number): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(n) && Math.abs(n) <= limit ? n : null;
}

/** ISO timestamps from embedded JSON; anything unparseable (or yearless) is null. */
export function isoDate(value: unknown): Date | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(value.trim())) return null;
  const time = Date.parse(value.trim());
  return Number.isNaN(time) ? null : new Date(time);
}

function isKijijiHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "kijiji.ca" || host.endsWith(".kijiji.ca");
}

/** Absolute Kijiji listing URL, or null for anything that is not an http(s) kijiji.ca link. */
export function kijijiUrl(href: string | null | undefined): URL | null {
  if (!href?.trim()) return null;
  try {
    const url = new URL(href.trim(), KIJIJI_ORIGIN);
    return (url.protocol === "https:" || url.protocol === "http:") && isKijijiHost(url.hostname) ? url : null;
  } catch {
    return null;
  }
}

/** Listing id from a VIP URL: ".../v-bikes/city-of-toronto/trek-marlin/1712345678" or "?adId=1712345678". */
export function idFromUrl(url: URL | null): string | undefined {
  if (!url) return undefined;
  const adId = url.searchParams.get("adId");
  if (adId && /^\d+$/.test(adId)) return adId;
  return url.pathname.match(/\/(\d{6,})\/?$/)?.[1];
}

/** Fallback listing URL when the source record has no usable link. */
export function viewUrl(id: string): string {
  return `${KIJIJI_ORIGIN}/v-view-details.html?adId=${encodeURIComponent(id)}`;
}

/** Resolve and keep http(s) image URLs (minus "no photo" placeholders), de-duplicated, in order. */
export function imageUrls(values: unknown[]): string[] {
  const urls: string[] = [];
  for (const value of values) {
    if (typeof value !== "string" || !value.trim() || value.startsWith("data:") || /placeholder/i.test(value)) continue;
    try {
      const url = new URL(value.trim(), KIJIJI_ORIGIN);
      if (url.protocol === "https:" || url.protocol === "http:") urls.push(url.href);
    } catch {
      // ignore unparseable src
    }
  }
  return [...new Set(urls)];
}

export interface Candidate {
  listing: ScrapedListing;
  /** Top ad / featured placement: loses to an organic copy of the same listing. */
  featured: boolean;
  /** Epoch ms Kijiji sorts by (bump date), when known. */
  sortTime?: number;
}

/**
 * De-duplicate by externalId. A featured copy is replaced by a later organic copy, which then takes
 * the organic copy's position; otherwise the first copy wins.
 */
export function dedupeCandidates(candidates: Candidate[]): Candidate[] {
  const byId = new Map<string, Candidate>();
  for (const candidate of candidates) {
    const id = candidate.listing.externalId;
    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, candidate);
    } else if (existing.featured && !candidate.featured) {
      byId.delete(id);
      byId.set(id, candidate);
    }
  }
  return [...byId.values()];
}
