/**
 * The search editor's form model and its conversion to `SearchInput`. Shared by the client form
 * (initial values) and the server actions (validation), so it must stay free of server-only imports.
 */
import { z } from "zod";
import type { Search } from "@/lib/db/schema";
import { centsToDollarsInput, dollarsToCents } from "@/lib/format";
import { findPreset } from "@/lib/locations";
import { searchInputSchema, type SearchInput } from "@/lib/search-schema";
import { CATEGORIES, isMarketplaceId, type CategoryId, type MarketplaceId, type SearchLocation } from "@/lib/types";

export const CUSTOM_LOCATION = "custom";

/** Offered poll intervals. No marketplace allows more than one check a minute (see their `minIntervalSec`). */
export const POLL_INTERVALS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 60, label: "Every minute" },
  { value: 120, label: "Every 2 minutes" },
  { value: 300, label: "Every 5 minutes" },
  { value: 600, label: "Every 10 minutes" },
  { value: 1800, label: "Every 30 minutes" },
  { value: 3600, label: "Every hour" },
];

/**
 * How often a search is really polled â€” the scheduler's rule: the chosen interval, raised to the
 * server floor (MIN_POLL_INTERVAL_SEC), to every selected marketplace's minimum spacing and, for a
 * search that uses eBay, to the eBay daily-quota floor (`ebayQuota`: that floor and how many searches
 * share the quota). `limitedBy` names the marketplaces that force a longer interval than the one
 * chosen; `ebayQuotaSearches` is set instead when the eBay quota does.
 */
export function effectivePollInterval(
  intervalSec: number,
  marketplaces: ReadonlyArray<{ displayName: string; minIntervalSec: number }>,
  minPollIntervalSec: number,
  ebayQuota?: { floorSec: number; searches: number },
): { seconds: number; limitedBy: string[]; ebayQuotaSearches?: number } {
  const requested = Math.max(intervalSec, minPollIntervalSec);
  const seconds = Math.max(requested, ebayQuota?.floorSec ?? 0, ...marketplaces.map((m) => m.minIntervalSec));
  if (seconds === requested) return { seconds, limitedBy: [] };
  if (ebayQuota?.floorSec === seconds) return { seconds, limitedBy: [], ebayQuotaSearches: ebayQuota.searches };
  return { seconds, limitedBy: marketplaces.filter((m) => m.minIntervalSec === seconds).map((m) => m.displayName) };
}

export interface LocationFormValues {
  label: string;
  lat: string;
  lng: string;
  countryCode: string;
  postalCode: string;
  craigslistSite: string;
  facebookLocation: string;
  kijijiLocationId: string;
  kijijiLocationSlug: string;
}

/** Everything the editor holds, as the user typed it (numbers stay strings until submit). */
export interface SearchFormValues {
  name: string;
  query: string;
  excludeTerms: string[];
  titleMustMatch: boolean;
  minPrice: string;
  maxPrice: string;
  expectedResale: string;
  marketplaces: MarketplaceId[];
  /** A LOCATION_PRESETS label, or CUSTOM_LOCATION. */
  locationPreset: string;
  location: LocationFormValues;
  radiusKm: string;
  /** "" = any category. */
  category: string;
  pollIntervalSec: string;
  maxListingAgeHours: string;
  /** Empty = every enabled channel. */
  notifyChannelIds: number[];
  notifyMinDealScore: string;
  notifyMinAiScore: string;
  notifyMinProfitPct: string;
  aiInstructions: string;
  notifyPriceDrops: boolean;
  aiEvaluate: boolean;
  enabled: boolean;
}

/** Field key (e.g. "maxPrice", "location.lat", "form") â†’ message. */
export type SearchFormErrors = Record<string, string>;

export type ParseSearchFormResult = { ok: true; input: SearchInput } | { ok: false; errors: SearchFormErrors };

// ---- initial values -------------------------------------------------------

function str(value: string | number | null | undefined): string {
  return value === null || value === undefined ? "" : String(value);
}

export function locationToFormValues(location: SearchLocation): LocationFormValues {
  return {
    label: location.label,
    lat: str(location.lat),
    lng: str(location.lng),
    countryCode: location.countryCode,
    postalCode: str(location.postalCode),
    craigslistSite: str(location.craigslistSite),
    facebookLocation: str(location.facebookLocation),
    kijijiLocationId: str(location.kijijiLocationId),
    kijijiLocationSlug: str(location.kijijiLocationSlug),
  };
}

function sameHint(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a || null) === (b || null);
}

/** The preset a stored location came from, if it still matches it exactly (radius aside). */
export function matchPreset(location: SearchLocation): SearchLocation | undefined {
  const preset = findPreset(location.label);
  if (!preset) return undefined;
  const same =
    Math.abs(preset.lat - location.lat) < 1e-6 &&
    Math.abs(preset.lng - location.lng) < 1e-6 &&
    preset.countryCode === location.countryCode &&
    sameHint(preset.postalCode, location.postalCode) &&
    sameHint(preset.craigslistSite, location.craigslistSite) &&
    sameHint(preset.facebookLocation, location.facebookLocation) &&
    sameHint(preset.kijijiLocationId, location.kijijiLocationId) &&
    sameHint(preset.kijijiLocationSlug, location.kijijiLocationSlug);
  return same ? preset : undefined;
}

export function defaultFormValues(location: SearchLocation, marketplaces: MarketplaceId[] = []): SearchFormValues {
  return {
    name: "",
    query: "",
    excludeTerms: [],
    titleMustMatch: false,
    minPrice: "",
    maxPrice: "",
    expectedResale: "",
    marketplaces,
    locationPreset: matchPreset(location)?.label ?? CUSTOM_LOCATION,
    location: locationToFormValues(location),
    radiusKm: str(location.radiusKm),
    category: "",
    pollIntervalSec: "120",
    maxListingAgeHours: "24",
    notifyChannelIds: [],
    notifyMinDealScore: "",
    notifyMinAiScore: "",
    notifyMinProfitPct: "",
    aiInstructions: "",
    notifyPriceDrops: true,
    aiEvaluate: false,
    enabled: true,
  };
}

export function searchToFormValues(search: Search): SearchFormValues {
  return {
    name: search.name,
    query: search.query,
    excludeTerms: [...search.excludeTerms],
    titleMustMatch: search.titleMustMatch,
    minPrice: centsToDollarsInput(search.minPriceCents),
    maxPrice: centsToDollarsInput(search.maxPriceCents),
    expectedResale: centsToDollarsInput(search.expectedResaleCents),
    marketplaces: search.marketplaces.filter(isMarketplaceId),
    locationPreset: matchPreset(search.location)?.label ?? CUSTOM_LOCATION,
    location: locationToFormValues(search.location),
    radiusKm: str(search.location.radiusKm),
    category: search.category && search.category !== "any" ? search.category : "",
    pollIntervalSec: str(search.pollIntervalSec),
    maxListingAgeHours: str(search.maxListingAgeHours),
    notifyChannelIds: search.notifyChannelIds ?? [],
    notifyMinDealScore: str(search.notifyMinDealScore),
    notifyMinAiScore: str(search.notifyMinAiScore),
    notifyMinProfitPct: str(search.notifyMinProfitPct),
    aiInstructions: search.aiInstructions ?? "",
    notifyPriceDrops: search.notifyPriceDrops,
    aiEvaluate: search.aiEvaluate,
    enabled: search.enabled,
  };
}

/** Normalize chips: trim, drop a leading "-" or wrapping quotes, collapse spaces, dedupe case-insensitively. */
export function normalizeTerms(terms: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of terms) {
    const term = raw
      .trim()
      .replace(/^-+/, "")
      .replace(/^"(.*)"$/, "$1")
      .replace(/\s+/g, " ")
      .trim();
    const key = term.toLowerCase();
    if (!term || seen.has(key)) continue;
    seen.add(key);
    out.push(term);
  }
  return out;
}

/** Split chip-input text on commas (Enter is handled by the input itself). */
export function splitTerms(text: string): string[] {
  return text
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

const MONEY_PATTERN = /^\$?\s*(\d{1,3}(,\d{3})+|\d+)?(\.\d{0,2})?$/;

/** "" â†’ null, "1,250.50" â†’ 125050, garbage â†’ "invalid". */
export function parseMoney(input: string): number | null | "invalid" {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (!MONEY_PATTERN.test(trimmed) || !/\d/.test(trimmed)) return "invalid";
  return dollarsToCents(trimmed);
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Prefill for /searches/new?name=â€¦&q=â€¦&min=â€¦&max=â€¦&resale=â€¦&category=â€¦&exclude=a,b&marketplaces=a,b&strict=1
 * (used by the quick-start templates). Unknown or invalid values are ignored.
 */
export function prefillFromSearchParams(params: Record<string, string | string[] | undefined>): Partial<SearchFormValues> {
  const out: Partial<SearchFormValues> = {};
  const name = first(params.name)?.trim();
  if (name) out.name = name.slice(0, 80);
  const query = first(params.q)?.trim();
  if (query) out.query = query.slice(0, 200);
  for (const [param, key] of [
    ["min", "minPrice"],
    ["max", "maxPrice"],
    ["resale", "expectedResale"],
  ] as const) {
    const value = first(params[param])?.trim();
    if (value && parseMoney(value) !== "invalid") out[key] = value;
  }
  const category = first(params.category);
  if (category && (CATEGORIES as readonly string[]).includes(category) && category !== "any") out.category = category;
  const exclude = first(params.exclude);
  if (exclude)
    out.excludeTerms = normalizeTerms(splitTerms(exclude))
      .filter((t) => t.length <= 60)
      .slice(0, 50);
  const marketplaces = first(params.marketplaces);
  if (marketplaces) {
    const ids = [...new Set(splitTerms(marketplaces).filter(isMarketplaceId))];
    if (ids.length) out.marketplaces = ids;
  }
  const strict = first(params.strict);
  if (strict === "1" || strict === "true") out.titleMustMatch = true;
  return out;
}

// ---- submit-time parsing --------------------------------------------------

const text = z.string().max(2_000);

/** Shape check for the untrusted payload a client sends to the server action. */
const formValuesSchema = z.object({
  name: text,
  query: text,
  excludeTerms: z.array(text).max(200),
  titleMustMatch: z.boolean(),
  minPrice: text,
  maxPrice: text,
  expectedResale: text,
  marketplaces: z.array(text).max(20),
  locationPreset: text,
  location: z.object({
    label: text,
    lat: text,
    lng: text,
    countryCode: text,
    postalCode: text,
    craigslistSite: text,
    facebookLocation: text,
    kijijiLocationId: text,
    kijijiLocationSlug: text,
  }),
  radiusKm: text,
  category: text,
  pollIntervalSec: text,
  maxListingAgeHours: text,
  notifyChannelIds: z.array(z.number().int()).max(200),
  notifyMinDealScore: text,
  notifyMinAiScore: text,
  notifyMinProfitPct: text,
  aiInstructions: z.string().max(2000),
  notifyPriceDrops: z.boolean(),
  aiEvaluate: z.boolean(),
  enabled: z.boolean(),
});

const COLUMN_TO_FIELD: Record<string, string> = {
  minPriceCents: "minPrice",
  maxPriceCents: "maxPrice",
  expectedResaleCents: "expectedResale",
};

/** Map a searchInputSchema issue path to the form field that shows it. */
export function fieldForIssuePath(path: ReadonlyArray<PropertyKey>): string {
  const [head, sub] = path;
  if (head === "location") {
    if (sub === "radiusKm") return "radiusKm";
    return typeof sub === "string" ? `location.${sub}` : "locationPreset";
  }
  if (typeof head !== "string") return "form";
  return COLUMN_TO_FIELD[head] ?? head;
}

/** Friendlier wording than zod's defaults for the fields users actually get wrong. */
const MESSAGES: Record<string, string> = {
  name: "Give the search a name (up to 80 characters)",
  query: "Enter what to search for (up to 200 characters)",
  excludeTerms: "Exclude terms must be 1â€“60 characters each, 50 at most",
  "location.label": "Give the location a name",
  "location.lat": "Latitude must be a number between -90 and 90",
  "location.lng": "Longitude must be a number between -180 and 180",
  "location.countryCode": "Use a 2-letter country code such as CA or US",
  "location.postalCode": "Postal code is too long",
  "location.facebookLocation": "Facebook location is too long",
  "location.kijijiLocationId": "Kijiji location id must be numeric, e.g. 1700287",
  "location.kijijiLocationSlug": "Kijiji location slug is too long",
  radiusKm: "Radius must be between 1 and 500 km",
  category: "Choose a category from the list",
  pollIntervalSec: "Poll interval must be between 30 seconds and 24 hours",
  maxListingAgeHours: "Use whole hours between 1 and 720",
  notifyMinDealScore: "Use a whole number from 0 to 100, or leave blank",
  notifyMinAiScore: "Use a whole number from 0 to 100, or leave blank",
  notifyMinProfitPct: "Use a whole percentage from 1 to 300, or leave blank",
  aiInstructions: "Keep the buying strategy under 1,000 characters",
  notifyChannelIds: "Pick channels from the list",
};

/** Keep the schema's own messages where it has hand-written ones (refinements, custom text). */
function messageFor(field: string, issue: z.core.$ZodIssue): string {
  if (issue.code === "custom") return issue.message;
  if (field === "marketplaces" || field === "location.craigslistSite") return issue.message;
  if (field === "minPrice" || field === "maxPrice" || field === "expectedResale") return "Enter an amount up to $1,000,000";
  return MESSAGES[field] ?? issue.message;
}

function blankToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/**
 * Validate what the editor submitted and convert it to a SearchInput: dollars â†’ cents, chips â†’
 * normalized exclude terms, preset/custom location â†’ SearchLocation. Presets are resolved on the
 * server by label so clients can't smuggle different coordinates under a preset's name.
 */
export function parseSearchForm(raw: unknown): ParseSearchFormResult {
  const shape = formValuesSchema.safeParse(raw);
  if (!shape.success) return { ok: false, errors: { form: "The form data was malformed. Reload the page and try again." } };
  const v = shape.data;
  const errors: SearchFormErrors = {};

  const money = (field: string, value: string): number | null => {
    const cents = parseMoney(value);
    if (cents === "invalid") {
      errors[field] = "Enter an amount like 400 or 49.99";
      return null;
    }
    return cents;
  };
  const number = (field: string, value: string, { optional = false } = {}): number | null => {
    const trimmed = value.trim();
    if (!trimmed) {
      if (!optional) errors[field] = MESSAGES[field] ?? "Required";
      return null;
    }
    const n = Number(trimmed);
    if (!Number.isFinite(n)) {
      errors[field] = MESSAGES[field] ?? "Enter a number";
      return null;
    }
    return n;
  };

  const radiusKm = number("radiusKm", v.radiusKm);
  let location: Record<string, unknown> | undefined;
  if (v.locationPreset === CUSTOM_LOCATION) {
    const l = v.location;
    location = {
      label: l.label,
      lat: number("location.lat", l.lat),
      lng: number("location.lng", l.lng),
      radiusKm,
      countryCode: l.countryCode,
      postalCode: blankToNull(l.postalCode),
      craigslistSite: blankToNull(l.craigslistSite)?.toLowerCase() ?? null,
      facebookLocation: blankToNull(l.facebookLocation),
      kijijiLocationId: blankToNull(l.kijijiLocationId),
      kijijiLocationSlug: blankToNull(l.kijijiLocationSlug),
    };
  } else {
    const preset = findPreset(v.locationPreset);
    if (preset) location = { ...preset, radiusKm };
    else errors.locationPreset = "Choose a location";
  }

  const category = v.category.trim();
  const candidate = {
    name: v.name,
    query: v.query,
    excludeTerms: normalizeTerms(v.excludeTerms),
    titleMustMatch: v.titleMustMatch,
    minPriceCents: money("minPrice", v.minPrice),
    maxPriceCents: money("maxPrice", v.maxPrice),
    expectedResaleCents: money("expectedResale", v.expectedResale),
    marketplaces: [...new Set(v.marketplaces)],
    location,
    category: category ? (category as CategoryId) : null,
    pollIntervalSec: number("pollIntervalSec", v.pollIntervalSec),
    maxListingAgeHours: number("maxListingAgeHours", v.maxListingAgeHours),
    notifyChannelIds: v.notifyChannelIds.length ? [...new Set(v.notifyChannelIds)] : null,
    notifyMinDealScore: number("notifyMinDealScore", v.notifyMinDealScore, { optional: true }),
    notifyMinAiScore: number("notifyMinAiScore", v.notifyMinAiScore, { optional: true }),
    notifyMinProfitPct: number("notifyMinProfitPct", v.notifyMinProfitPct, { optional: true }),
    aiInstructions: blankToNull(v.aiInstructions),
    notifyPriceDrops: v.notifyPriceDrops,
    aiEvaluate: v.aiEvaluate,
    enabled: v.enabled,
  };

  const result = searchInputSchema.safeParse(candidate);
  if (!result.success) {
    for (const issue of result.error.issues) {
      const field = fieldForIssuePath(issue.path);
      // A location we couldn't build was already reported against the preset select.
      if (field === "locationPreset" && errors.locationPreset) continue;
      errors[field] ??= messageFor(field, issue);
    }
  }
  if (Object.keys(errors).length > 0 || !result.success) return { ok: false, errors };
  return { ok: true, input: result.data };
}
