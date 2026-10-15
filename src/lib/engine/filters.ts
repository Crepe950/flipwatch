/**
 * Pure listing filters: query parsing, exclude terms, price bounds, title matching, distance, staleness.
 * Marketplaces return fuzzy results; these rules decide what actually counts as a match for a search.
 */
import { formatPrice } from "../format";
import { haversineKm } from "../marketplaces/http";
import type { SearchLocation } from "../types";

/** Lowercase, strip diacritics and apostrophes, turn every other non-alphanumeric run into one space. */
export function normalizeText(input: string | null | undefined): string {
  if (!input) return "";
  return input
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/['’ʼ`]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export interface ParsedQuery {
  /** The query to send to marketplaces: negative terms removed, phrases kept quoted. */
  marketplaceQuery: string;
  /**
   * What `titleMustMatch` requires: normalized positive words/phrases, one group per `OR` / `|`
   * alternative. A title matches when it contains every term of at least one group.
   */
  requiredGroups: string[][];
  /** Normalized words/phrases from `-word` / `-"a phrase"` tokens. */
  excludeTerms: string[];
}

interface QueryToken {
  text: string;
  phrase: boolean;
  negative: boolean;
}

const QUOTES = new Set(['"', "“", "”", "„"]);
/** Boolean operators some marketplaces understand; passed through but never required in titles. */
const OPERATORS = new Set(["OR", "|", "AND"]);
/** Filler words that would make `titleMustMatch` needlessly strict ("table and chairs"). */
const STOP_WORDS = new Set(["a", "an", "and", "or", "the", "of", "for", "with", "in", "on", "to"]);

function tokenizeQuery(query: string): QueryToken[] {
  const tokens: QueryToken[] = [];
  let i = 0;
  const isSpace = (c: string | undefined) => c === undefined || /\s/.test(c);
  while (i < query.length) {
    if (isSpace(query[i])) {
      i++;
      continue;
    }
    let negative = false;
    if (query[i] === "-" && !isSpace(query[i + 1])) {
      negative = true;
      i++;
    }
    if (QUOTES.has(query[i])) {
      let end = i + 1;
      while (end < query.length && !QUOTES.has(query[end])) end++;
      tokens.push({ text: query.slice(i + 1, end).trim(), phrase: true, negative });
      i = end + 1;
    } else {
      let end = i;
      while (end < query.length && !isSpace(query[end])) end++;
      tokens.push({ text: query.slice(i, end), phrase: false, negative });
      i = end;
    }
  }
  return tokens.filter((t) => t.text !== "");
}

/**
 * Split a user query into what marketplaces receive and what the filters enforce.
 * `ps5 -broken -"for parts"` → marketplaceQuery "ps5", requiredGroups [["ps5"]], excludeTerms ["broken", "for parts"].
 * `ps5 OR xbox`, `ps5 | xbox` and `ps5|xbox` → requiredGroups [["ps5"], ["xbox"]].
 */
export function parseQuery(query: string): ParsedQuery {
  const marketplaceParts: string[] = [];
  const groups: Array<Set<string>> = [new Set()];
  const excluded = new Set<string>();
  const alternative = () => {
    if (groups[groups.length - 1].size > 0) groups.push(new Set());
  };
  const require = (normalized: string, phrase: boolean) => {
    const group = groups[groups.length - 1];
    if (phrase) group.add(normalized);
    else for (const word of words(normalized)) if (!STOP_WORDS.has(word)) group.add(word);
  };

  for (const token of tokenizeQuery(query ?? "")) {
    const normalized = normalizeText(token.text);
    if (token.negative) {
      if (normalized) excluded.add(normalized);
      continue;
    }
    if (OPERATORS.has(token.text)) {
      marketplaceParts.push(token.text);
      if (token.text !== "AND") alternative();
      continue;
    }
    if (!normalized) continue;
    marketplaceParts.push(token.phrase ? `"${token.text}"` : token.text);
    if (token.phrase) {
      require(normalized, true);
      continue;
    }
    // "ps5|xbox": alternatives without spaces around the bar.
    token.text.split("|").forEach((part, i) => {
      if (i > 0) alternative();
      require(normalizeText(part), false);
    });
  }

  return {
    marketplaceQuery: marketplaceParts.join(" "),
    requiredGroups: groups.filter((g) => g.size > 0).map((g) => [...g]),
    excludeTerms: [...excluded],
  };
}

// --- word matching -----------------------------------------------------------------------------

const ES_PLURAL_ENDINGS = ["s", "x", "z", "ch", "sh", "o"];

function isPluralOf(plural: string, singular: string): boolean {
  if (plural === `${singular}s`) return true;
  if (plural === `${singular}es`) return ES_PLURAL_ENDINGS.some((end) => singular.endsWith(end));
  return singular.length > 2 && singular.endsWith("y") && plural === `${singular.slice(0, -1)}ies`;
}

/** Plural tolerance only for plain words: "iphone 4" must not match "iphone 4s". */
function isPlainWord(word: string): boolean {
  return word.length >= 2 && /^\p{L}+$/u.test(word);
}

function wordMatches(textWord: string, termWord: string): boolean {
  if (textWord === termWord) return true;
  if (!isPlainWord(textWord) || !isPlainWord(termWord)) return false;
  return isPluralOf(textWord, termWord) || isPluralOf(termWord, textWord);
}

/** Exclude terms written "title:…" only apply to the listing title. */
const TITLE_ONLY_PREFIX = /^\s*title\s*:\s*/i;
export function isTitleOnlyTerm(term: string): boolean {
  return TITLE_ONLY_PREFIX.test(term);
}

function words(normalized: string): string[] {
  return normalized ? normalized.split(" ") : [];
}

/** Whether `term` (normalized word or phrase) occurs as whole consecutive words in `textWords`. */
export function containsTerm(textWords: readonly string[], term: string): boolean {
  const termWords = words(term);
  if (termWords.length === 0) return false;
  for (let start = 0; start + termWords.length <= textWords.length; start++) {
    if (termWords.every((w, k) => wordMatches(textWords[start + k], w))) return true;
  }
  return false;
}

// --- listing evaluation ------------------------------------------------------------------------

export interface FilterableListing {
  title: string;
  description?: string | null;
  priceCents: number | null;
  currency?: string | null;
  lat?: number | null;
  lng?: number | null;
  postedAt?: Date | null;
}

export interface FilterableSearch {
  query: string;
  /** "free" only passes listings priced $0 (or unpriced), whatever the marketplace returned. */
  category?: string | null;
  excludeTerms?: readonly string[] | null;
  titleMustMatch?: boolean | null;
  minPriceCents?: number | null;
  maxPriceCents?: number | null;
  location?: Pick<SearchLocation, "lat" | "lng" | "radiusKm"> | null;
  maxListingAgeHours?: number | null;
}

export interface FilterResult {
  pass: boolean;
  /** Why the listing was rejected (only when `pass` is false). */
  reason?: string;
  /** Posted longer ago than the search's max listing age. Stale listings still pass. */
  stale: boolean;
}

/** Listings further than radius × this are dropped (marketplaces are loose about radius). */
export const DISTANCE_TOLERANCE = 1.25;

function validCoords(lat: number | null | undefined, lng: number | null | undefined): { lat: number; lng: number } | null {
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  // (0, 0) is what several sites send for "unknown".
  if (lat === 0 && lng === 0) return null;
  return { lat, lng };
}

function isStale(postedAt: Date | null | undefined, maxAgeHours: number | null | undefined, now: Date): boolean {
  if (!(postedAt instanceof Date) || Number.isNaN(postedAt.getTime())) return false;
  if (maxAgeHours == null || !Number.isFinite(maxAgeHours) || maxAgeHours <= 0) return false;
  return now.getTime() - postedAt.getTime() > maxAgeHours * 3_600_000;
}

export type ListingFilter = (listing: FilterableListing, now: Date) => FilterResult;

/** Precompile a search's filter rules once, then evaluate many listings. */
export function createListingFilter(search: FilterableSearch): ListingFilter {
  const parsed = parseQuery(search.query);
  // "title:pc" only checks the title: it keeps whole PCs out of a GPU search without rejecting every card
  // whose description says "pulled from my PC". Plain terms check the title and the description.
  const raw = search.excludeTerms ?? [];
  const titleOnly = [...new Set(raw.filter(isTitleOnlyTerm).map((t) => normalizeText(t.replace(TITLE_ONLY_PREFIX, ""))).filter(Boolean))];
  const excludeTerms = [
    ...new Set([...raw.filter((t) => !isTitleOnlyTerm(t)).map((t) => normalizeText(t)), ...parsed.excludeTerms].filter(Boolean)),
  ];
  const requiredGroups = search.titleMustMatch ? parsed.requiredGroups : [];
  const freeOnly = search.category === "free";
  const { minPriceCents: min, maxPriceCents: max } = search;
  const hasPriceBound = min != null || max != null;
  const origin = search.location ? validCoords(search.location.lat, search.location.lng) : null;
  const radiusKm = search.location?.radiusKm;

  return (listing, now) => {
    const stale = isStale(listing.postedAt, search.maxListingAgeHours, now);
    const reject = (reason: string): FilterResult => ({ pass: false, reason, stale });
    const price = listing.priceCents;
    const money = (cents: number) => formatPrice(cents, listing.currency ?? "USD");

    // Free-category posts often carry no price at all; treat those as free rather than unpriced.
    if (hasPriceBound && !(freeOnly && price == null)) {
      if (price == null) return reject("No price listed");
      if (min != null && price < min) return reject(`Price ${money(price)} is below the minimum ${money(min)}`);
      if (max != null && price > max) return reject(`Price ${money(price)} is above the maximum ${money(max)}`);
    }
    if (freeOnly && price != null && price > 0) return reject(`Not free (${money(price)})`);

    const at = validCoords(listing.lat, listing.lng);
    if (origin && at && radiusKm != null && radiusKm > 0) {
      const km = haversineKm(origin, at);
      if (km > radiusKm * DISTANCE_TOLERANCE) {
        return reject(`${Math.round(km)} km away (search radius ${radiusKm} km)`);
      }
    }

    if (titleOnly.length > 0) {
      const titleWords = words(normalizeText(listing.title));
      const hit = titleOnly.find((term) => containsTerm(titleWords, term));
      if (hit) return reject(`Title contains excluded term "${hit}"`);
    }
    if (excludeTerms.length > 0) {
      const text = words(`${normalizeText(listing.title)} ${normalizeText(listing.description)}`.trim());
      const hit = excludeTerms.find((term) => containsTerm(text, term));
      if (hit) return reject(`Contains excluded term "${hit}"`);
    }

    if (requiredGroups.length > 0) {
      const title = words(normalizeText(listing.title));
      const missing = requiredGroups.map((group) => group.find((term) => !containsTerm(title, term)));
      if (missing.every((term) => term !== undefined)) {
        return reject(
          requiredGroups.length === 1
            ? `Title is missing "${missing[0]}"`
            : `Title matches none of ${requiredGroups.map((group) => `"${group.join(" ")}"`).join(", ")}`,
        );
      }
    }

    return { pass: true, stale };
  };
}

/** Evaluate one listing against a search's filters. */
export function evaluateListing(listing: FilterableListing, search: FilterableSearch, now: Date): FilterResult {
  return createListingFilter(search)(listing, now);
}
