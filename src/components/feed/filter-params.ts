/**
 * URL ⇄ FeedFilters. Shared by the feed page (lenient: bad values are ignored), the JSON API
 * (strict: bad values are a 400) and the client filter bar. Client-safe: no database imports.
 */
import { z } from "zod";
import type { FeedFilters } from "@/lib/queries/feed";
import { MARKETPLACES } from "@/lib/types";

const flag = z.enum(["0", "1", "false", "true"]).transform((v) => v === "1" || v === "true");

export const feedQuerySchema = z.object({
  search: z.coerce.number().int().positive().max(2_147_483_647).optional(),
  marketplace: z.enum(MARKETPLACES).optional(),
  event: z.enum(["new", "price_drop"]).optional(),
  score: z.coerce.number().int().min(0).max(100).optional(),
  initial: flag.optional(),
  dismissed: flag.optional(),
  q: z.string().trim().max(100).optional(),
  cursor: z.string().max(40).optional(),
  since: z.iso.datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export type FeedQuery = z.infer<typeof feedQuerySchema>;

type RawParams = URLSearchParams | Record<string, string | string[] | undefined>;

/** Flatten to first values and drop blanks (an empty <select> means "any"). */
function toRecord(input: RawParams): Record<string, string> {
  const out: Record<string, string> = {};
  const entries: Array<[string, string | string[] | undefined]> =
    input instanceof URLSearchParams ? [...input.entries()] : Object.entries(input);
  for (const [key, raw] of entries) {
    if (key in out) continue;
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value === "string" && value.trim() !== "") out[key] = value;
  }
  return out;
}

export function parseFeedQueryStrict(input: RawParams) {
  return feedQuerySchema.safeParse(toRecord(input));
}

/** Parse, dropping any parameter that fails validation instead of failing the whole request. */
export function parseFeedQueryLenient(input: RawParams): FeedQuery {
  const record = toRecord(input);
  const first = feedQuerySchema.safeParse(record);
  if (first.success) return first.data;
  for (const issue of first.error.issues) {
    const key = issue.path[0];
    if (typeof key === "string") delete record[key];
  }
  const second = feedQuerySchema.safeParse(record);
  return second.success ? second.data : {};
}

export function queryToFilters(query: FeedQuery): FeedFilters {
  return {
    searchId: query.search,
    marketplace: query.marketplace,
    event: query.event,
    minScore: query.score,
    includeInitial: query.initial ?? true,
    includeDismissed: query.dismissed ?? false,
    q: query.q || undefined,
  };
}

/** Canonical query string for filters (defaults omitted), used for links, the API and list keys. */
export function filtersToSearchParams(filters: FeedFilters): URLSearchParams {
  const p = new URLSearchParams();
  if (filters.searchId !== undefined) p.set("search", String(filters.searchId));
  if (filters.marketplace) p.set("marketplace", filters.marketplace);
  if (filters.event) p.set("event", filters.event);
  if (filters.minScore !== undefined) p.set("score", String(filters.minScore));
  if (!filters.includeInitial) p.set("initial", "0");
  if (filters.includeDismissed) p.set("dismissed", "1");
  if (filters.q) p.set("q", filters.q);
  return p;
}

/**
 * The title search box's typed text after the URL's `q` changed to `urlQ` (null: show `urlQ`). Typed
 * text survives only when this navigation is the debounced search for it; Back, the Feed link or a
 * search chip replace it, so the box never pushes a stale query back into the URL.
 */
export function typedAfterNavigation(typed: string | null, urlQ: string): string | null {
  return typed !== null && typed.trim() === urlQ ? typed : null;
}

export function hasActiveFilters(filters: FeedFilters): boolean {
  return filtersToSearchParams(filters).size > 0;
}
