/**
 * Defensive cleanup of adapter output before it touches the database or the UI.
 * Marketplace data is untrusted: bound every string, keep only http(s) URLs, and drop values
 * Postgres would reject (NUL bytes, out-of-range integers) so one bad listing can't fail a batch.
 */
import type { MarketplaceId, ScrapedListing } from "../types";

export const LIMITS = {
  externalId: 256,
  url: 2_048,
  title: 300,
  description: 20_000,
  locationText: 200,
  sellerName: 120,
  condition: 80,
  images: 20,
  rawJsonChars: 8_192,
  /** Postgres integer max is 2 147 483 647; anything near it is garbage for a listing price. */
  priceCents: 2_000_000_000,
} as const;

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const LONE_SURROGATES = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  // Slice by code points so an emoji is never cut in half.
  return Array.from(value).slice(0, max - 1).join("").trimEnd() + "…";
}

export function cleanText(value: unknown, max: number, opts: { multiline?: boolean } = {}): string | null {
  if (typeof value !== "string") return null;
  let s = value.replace(CONTROL_CHARS, "").replace(LONE_SURROGATES, "�");
  s = opts.multiline ? s.replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n") : s.replace(/\s+/g, " ");
  s = s.trim();
  return s ? truncate(s, max) : null;
}

export function safeHttpUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > LIMITS.url) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function cleanPrice(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  const cents = Math.round(value);
  return cents <= LIMITS.priceCents ? cents : null;
}

function cleanCoord(value: unknown, limit: number): number | null {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= limit ? value : null;
}

function cleanDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : typeof value === "string" || typeof value === "number" ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

function cleanRaw(raw: unknown): unknown {
  if (raw === undefined || raw === null) return null;
  try {
    const json = JSON.stringify(raw);
    // jsonb rejects \u0000; oversized snapshots are just noise.
    if (!json || json.length > LIMITS.rawJsonChars || json.includes("\\u0000")) return null;
    return JSON.parse(json.replace(LONE_SURROGATES, "�"));
  } catch {
    return null;
  }
}

/**
 * Normalize one adapter result. Returns null when the listing is unusable (no id or no safe URL).
 * `marketplace` always wins over whatever the adapter put in the record.
 */
export function sanitizeScrapedListing(
  input: ScrapedListing,
  marketplace: MarketplaceId,
  fallbackCurrency: string,
): ScrapedListing | null {
  const externalId = typeof input.externalId === "number" ? String(input.externalId) : cleanText(input.externalId, Infinity);
  if (!externalId || externalId.length > LIMITS.externalId) return null;
  const url = safeHttpUrl(input.url);
  if (!url) return null;

  const currency = typeof input.currency === "string" ? input.currency.trim().toUpperCase() : "";
  const images = Array.isArray(input.imageUrls) ? input.imageUrls.map(safeHttpUrl).filter((u): u is string => u !== null) : [];

  return {
    marketplace,
    externalId,
    url,
    title: cleanText(input.title, LIMITS.title) ?? "Untitled listing",
    priceCents: cleanPrice(input.priceCents),
    currency: /^[A-Z]{3}$/.test(currency) ? currency : fallbackCurrency,
    description: cleanText(input.description, LIMITS.description, { multiline: true }),
    imageUrls: [...new Set(images)].slice(0, LIMITS.images),
    locationText: cleanText(input.locationText, LIMITS.locationText),
    lat: cleanCoord(input.lat, 90),
    lng: cleanCoord(input.lng, 180),
    postedAt: cleanDate(input.postedAt),
    sellerName: cleanText(input.sellerName, LIMITS.sellerName),
    condition: cleanText(input.condition, LIMITS.condition),
    raw: cleanRaw(input.raw),
  };
}

/** Sanitize a whole result set and keep only the first occurrence of each externalId. */
export function sanitizeResults(
  results: readonly ScrapedListing[],
  marketplace: MarketplaceId,
  fallbackCurrency: string,
): ScrapedListing[] {
  const seen = new Set<string>();
  const out: ScrapedListing[] = [];
  for (const item of results) {
    if (!item || typeof item !== "object") continue;
    const clean = sanitizeScrapedListing(item, marketplace, fallbackCurrency);
    if (!clean || seen.has(clean.externalId)) continue;
    seen.add(clean.externalId);
    out.push(clean);
  }
  return out;
}
