import type { CheerioAPI } from "cheerio";
import { parsePriceToCents } from "../http";
import { cleanText, titleKey } from "./text";

/** What the search page's JSON-LD (script#ld_searchpage_results) knows about one result. */
export interface CraigslistLdItem {
  name: string;
  priceCents: number | null;
  currency: string | null;
  imageUrls: string[];
  locationText: string | null;
  lat: number | null;
  lng: number | null;
}

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined;
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string") return cleanText(value) || undefined;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function asCoordinate(value: unknown, limit: number): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(n) && Math.abs(n) <= limit ? n : null;
}

function imageList(value: unknown): string[] {
  const values = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  const urls = values
    .map((v) => (typeof v === "string" ? v : asString(asRecord(v)?.url)))
    .filter((v): v is string => typeof v === "string" && /^https?:\/\//i.test(v.trim()))
    .map((v) => v.trim());
  return [...new Set(urls)];
}

function toLdItem(element: unknown): CraigslistLdItem | null {
  const el = asRecord(element);
  const item = asRecord(el?.item) ?? el;
  const name = asString(item?.name);
  if (!item || !name) return null;

  const offersValue = item.offers;
  const offers = asRecord(Array.isArray(offersValue) ? offersValue[0] : offersValue);
  const place = asRecord(offers?.availableAtOrFrom);
  const address = asRecord(place?.address);
  const geo = asRecord(place?.geo);
  const currency = asString(offers?.priceCurrency)?.toUpperCase();
  const locality = [asString(address?.addressLocality), asString(address?.addressRegion)].filter(Boolean).join(", ");

  const lat = asCoordinate(geo?.latitude, 90);
  const lng = asCoordinate(geo?.longitude, 180);
  const hasGeo = lat !== null && lng !== null && !(lat === 0 && lng === 0);

  return {
    name,
    priceCents: parsePriceToCents(asString(offers?.price) ?? null),
    currency: currency && /^[A-Z]{3}$/.test(currency) ? currency : null,
    imageUrls: imageList(item.image),
    locationText: locality || null,
    lat: hasGeo ? lat : null,
    lng: hasGeo ? lng : null,
  };
}

/**
 * Parse script#ld_searchpage_results, in list order. Entries that cannot be read stay as null so
 * positions keep lining up with the HTML rows. Malformed or missing JSON-LD yields [] (it is only
 * enrichment).
 */
export function readSearchJsonLd($: CheerioAPI): Array<CraigslistLdItem | null> {
  const text = $("script#ld_searchpage_results").first().text().trim();
  if (!text) return [];
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const elements = asRecord(data)?.itemListElement;
  if (!Array.isArray(elements)) return [];

  const positioned = elements.map((element, index) => {
    const position = Number(asRecord(element)?.position);
    return { element, order: Number.isFinite(position) ? position : index };
  });
  // Array.prototype.sort is stable, so equal/absent positions keep document order.
  positioned.sort((a, b) => a.order - b.order);
  return positioned.map((p) => toLdItem(p.element));
}

/**
 * Pair each HTML row with its JSON-LD entry: by position when the counts line up and most titles
 * agree (the normal case; a few may differ in escaping), otherwise by exact title, each JSON-LD
 * entry being used at most once. Pairing a reordered list by position would attach another
 * listing's photos and coordinates, so a mostly-disagreeing positional pairing is rejected.
 */
export function matchJsonLd(
  rows: ReadonlyArray<{ title: string }>,
  items: ReadonlyArray<CraigslistLdItem | null>,
): Array<CraigslistLdItem | undefined> {
  if (items.length === rows.length) {
    const agreeing = rows.filter((row, i) => items[i] && titleKey(row.title) === titleKey(items[i].name)).length;
    if (agreeing * 2 > rows.length) return items.map((item) => item ?? undefined);
  }

  const byTitle = new Map<string, CraigslistLdItem[]>();
  for (const item of items) {
    if (!item) continue;
    const key = titleKey(item.name);
    const bucket = byTitle.get(key);
    if (bucket) bucket.push(item);
    else byTitle.set(key, [item]);
  }
  return rows.map((row) => byTitle.get(titleKey(row.title))?.shift());
}
