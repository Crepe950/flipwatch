/** Listings from the Next.js page state: script#__NEXT_DATA__ → props.pageProps.__APOLLO_STATE__. */
import type { CheerioAPI } from "cheerio";
import type { ScrapedListing } from "../../types";
import { walkObjects } from "../http";
import {
  asCoordinate,
  asRecord,
  asString,
  cleanText,
  idFromUrl,
  imageUrls,
  isoDate,
  kijijiUrl,
  viewUrl,
  type Candidate,
  type Json,
} from "./common";

export function readNextData($: CheerioAPI): unknown {
  const text = $("script#__NEXT_DATA__").first().text().trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const FREE_PRICE_TYPES = new Set(["FREE", "GIVE_AWAY"]);
const NO_PRICE_TYPES = new Set(["CONTACT", "PLEASE_CONTACT", "SWAP_TRADE", "SWAP", "TRADE"]);

/** Apollo prices are integer cents plus a type; only amounts of priced types count. */
export function apolloPriceCents(price: Json | undefined): number | null {
  if (!price) return null;
  const type = typeof price.type === "string" ? price.type.trim().toUpperCase() : "";
  if (FREE_PRICE_TYPES.has(type)) return 0;
  if (NO_PRICE_TYPES.has(type)) return null;
  const raw = price.amount;
  const amount = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : Number.NaN;
  return Number.isFinite(amount) && amount >= 0 ? Math.round(amount) : null;
}

function isListingEntity(obj: Json): boolean {
  const { id, title } = obj;
  const hasId = (typeof id === "string" && id.trim() !== "") || (typeof id === "number" && Number.isFinite(id));
  if (!hasId || typeof title !== "string") return false;
  const typename = typeof obj.__typename === "string" ? obj.__typename : "";
  if (typename) return typename.endsWith("Listing");
  return "price" in obj && ("url" in obj || "imageUrls" in obj);
}

function toCandidate(obj: Json, deref: (value: unknown) => Json | undefined): Candidate | null {
  const id = String(obj.id).trim();
  const title = cleanText(obj.title as string);
  if (!/^[\w-]{1,64}$/.test(id) || !title) return null;

  const link = kijijiUrl(asString(obj.url) ?? asString(obj.seoUrl));
  const linkId = idFromUrl(link);
  const url = link && (!linkId || linkId === id) ? link.href : viewUrl(id);

  const typename = typeof obj.__typename === "string" ? obj.__typename : "";
  const price = deref(obj.price);
  const location = deref(obj.location);
  const coordinates = deref(location?.coordinates);
  const flags = deref(obj.flags);
  const adSource = asString(obj.adSource);
  const featured = flags?.topAd === true || /top.?ad/i.test(typename) || /top.?ad/i.test(adSource ?? "");

  const lat = asCoordinate(coordinates?.latitude, 90);
  const lng = asCoordinate(coordinates?.longitude, 180);
  const hasGeo = lat !== null && lng !== null && !(lat === 0 && lng === 0);
  const postedAt = isoDate(obj.activationDate) ?? isoDate(obj.sortingDate);
  const sortDate = isoDate(obj.sortingDate) ?? postedAt;
  const images = Array.isArray(obj.imageUrls) ? obj.imageUrls : [];

  const listing: ScrapedListing = {
    marketplace: "kijiji",
    externalId: id,
    url,
    title,
    priceCents: apolloPriceCents(price),
    currency: "CAD",
    description: asString(obj.description) ?? null,
    imageUrls: imageUrls(images),
    locationText: asString(location?.address) ?? asString(location?.name) ?? null,
    lat: hasGeo ? lat : null,
    lng: hasGeo ? lng : null,
    postedAt,
    raw: {
      source: "apollo",
      id,
      typename: typename || null,
      priceType: asString(price?.type) ?? null,
      priceAmount: typeof price?.amount === "number" ? price.amount : null,
      adSource: adSource ?? null,
      topAd: featured,
    },
  };
  return { listing, featured, sortTime: sortDate?.getTime() };
}

export interface ApolloResult {
  candidates: Candidate[];
  /** The state holds a search-results object, so no candidates means "no results". */
  isSearchPage: boolean;
  /**
   * How many results the search-results object says it has: entries in its `…Listings` arrays, or
   * its `totalCount` when larger. Non-zero without candidates means the listing shape changed.
   */
  advertisedCount: number;
}

/** Root fields such as `searchResultsPageByUrl({"url":…})` or `searchResults`. */
const SEARCH_RESULTS_KEY = /^searchResults/i;

/** Like walkObjects, but `{ __ref: "Type:id" }` pointers are followed into the normalised cache. */
function* walkResolved(value: unknown, cache: Json): Generator<Json> {
  const stack: unknown[] = [value];
  const seen = new Set<unknown>();
  while (stack.length > 0) {
    const v = stack.pop();
    if (v === null || typeof v !== "object" || seen.has(v)) continue;
    seen.add(v);
    if (Array.isArray(v)) {
      for (let i = v.length - 1; i >= 0; i--) stack.push(v[i]);
      continue;
    }
    const obj = v as Json;
    if (typeof obj.__ref === "string") {
      stack.push(cache[obj.__ref]);
      continue;
    }
    yield obj;
    const values = Object.values(obj);
    for (let i = values.length - 1; i >= 0; i--) stack.push(values[i]);
  }
}

/**
 * Collect listings from the page state. The nesting changes between Kijiji releases, so the state
 * is walked rather than addressed by path: every object shaped like a listing (…Listing typename,
 * id + title) counts. When a search-results object exists, only listings reachable from it are
 * taken (the cache can also hold recommendations and recently viewed ads); otherwise the whole
 * state is searched.
 */
export function parseApolloState(nextData: unknown): ApolloResult {
  const pageProps = asRecord(asRecord(asRecord(nextData)?.props)?.pageProps);
  const cache = asRecord(pageProps?.__APOLLO_STATE__) ?? asRecord(pageProps?.apolloState) ?? {};
  const deref = (value: unknown): Json | undefined => {
    const record = asRecord(value);
    const ref = record?.__ref;
    return typeof ref === "string" ? asRecord(cache[ref]) : record;
  };
  const state = Object.keys(cache).length > 0 ? cache : nextData;

  const roots: Json[] = [];
  for (const obj of walkObjects(state)) {
    for (const [key, value] of Object.entries(obj)) {
      const root = SEARCH_RESULTS_KEY.test(key) ? deref(value) : undefined;
      if (root) roots.push(root);
    }
  }

  const candidates: Candidate[] = [];
  for (const obj of walkResolved(roots.length > 0 ? roots : state, cache)) {
    if (!isListingEntity(obj)) continue;
    const candidate = toCandidate(obj, deref);
    if (candidate) candidates.push(candidate);
  }
  return { candidates, isSearchPage: roots.length > 0, advertisedCount: advertisedCount(roots, cache) };
}

/** See ApolloResult.advertisedCount. Counts entries, not ids, so it works whatever shape they have. */
function advertisedCount(roots: Json[], cache: Json): number {
  let listed = 0;
  let total = 0;
  for (const obj of walkResolved(roots, cache)) {
    for (const [key, value] of Object.entries(obj)) {
      if (/listings$/i.test(key) && Array.isArray(value)) listed += value.length;
      else if (key === "totalCount" && typeof value === "number" && Number.isFinite(value)) total = Math.max(total, value);
    }
  }
  return Math.max(listed, total);
}
