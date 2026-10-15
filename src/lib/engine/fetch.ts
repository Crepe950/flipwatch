/** Querying marketplace adapters: eligibility checks, politeness gate, timeouts. Shared by runs and previews. */
import { config } from "../config";
import { createAdapterContext, getAdapter } from "../marketplaces/registry";
import type { MarketplaceAdapter } from "../marketplaces/types";
import { ParseError } from "../marketplaces/types";
import { isMarketplaceId, type CategoryId, type MarketplaceId, type ScrapedListing, type SearchLocation, type SearchQuery } from "../types";
import { withTimeout } from "./async";
import type { ParsedQuery } from "./filters";
import { defaultGate } from "./gate";
import { errorMessage } from "./log";
import { safeHttpUrl } from "./sanitize";
import type { AdapterOverrides, FetchOptions } from "./types";

/** Results requested from each marketplace per run. */
export const RESULT_LIMIT = 60;

export function resolveAdapter(id: MarketplaceId, overrides?: AdapterOverrides): MarketplaceAdapter | undefined {
  return overrides?.[id] ?? getAdapter(id);
}

/** Valid, de-duplicated marketplace ids in their original order (the column is untyped JSON). */
export function uniqueMarketplaces(values: readonly unknown[] | null | undefined): MarketplaceId[] {
  return [...new Set((values ?? []).filter(isMarketplaceId))];
}

/** Why an adapter can't serve this search right now, or null when it can. */
export function adapterUnavailableReason(adapter: MarketplaceAdapter, countryCode: string | null | undefined): string | null {
  let status;
  try {
    status = adapter.status();
  } catch (err) {
    return `${adapter.displayName} status check failed: ${errorMessage(err)}`;
  }
  if (!status.ok) return status.message || `${adapter.displayName} is not configured`;
  const country = (countryCode ?? "").trim().toUpperCase();
  if (adapter.countries.length > 0 && !adapter.countries.includes(country)) {
    return `${adapter.displayName} does not serve ${country || "this country"}`;
  }
  return null;
}

export interface QueryableSearch {
  minPriceCents?: number | null;
  maxPriceCents?: number | null;
  location: SearchLocation;
  category?: CategoryId | null;
}

export function buildSearchQuery(search: QueryableSearch, parsed: ParsedQuery): SearchQuery {
  // Not every marketplace has a "free" category, but all of them filter on price.
  const free = search.category === "free";
  return {
    keywords: parsed.marketplaceQuery,
    minPriceCents: free ? null : (search.minPriceCents ?? null),
    maxPriceCents: free ? 0 : (search.maxPriceCents ?? null),
    location: search.location,
    category: search.category && search.category !== "any" ? search.category : null,
    limit: RESULT_LIMIT,
    alternatives: parsed.requiredGroups.length > 1 ? parsed.requiredGroups.map((group) => group.join(" ")) : undefined,
  };
}

export function searchUrlFor(adapter: MarketplaceAdapter, query: SearchQuery): string | undefined {
  try {
    return safeHttpUrl(adapter.buildSearchUrl(query)) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Adapters may make several requests (auth + search), so allow a few request timeouts in total. */
export function defaultSearchTimeoutMs(): number {
  return config.scraperTimeoutMs * 2 + 5_000;
}

/**
 * Query a marketplace for a search. The adapter's own result cap (maxResults) replaces the default, and
 * an OR query goes to a marketplace without OR syntax as one request per alternative (each through the
 * gate, so they are spaced like any other requests), merged in order and de-duplicated. The first failing
 * request aborts the rest, so a block or rate limit is not followed by more requests.
 * `onStart` runs once the gate admits the first request (i.e. excluding queueing time); throwing from it
 * cancels the request.
 */
export async function fetchMarketplace(
  adapter: MarketplaceAdapter,
  query: SearchQuery,
  opts: FetchOptions,
  onStart?: () => void | Promise<void>,
): Promise<ScrapedListing[]> {
  const limit = adapter.maxResults ?? query.limit;
  const alternatives =
    adapter.supportsOrQueries === false && (query.alternatives?.length ?? 0) > 1
      ? rotateAlternatives(query.alternatives!, adapter.maxAlternativesPerRun, Date.now())
      : null;
  if (!alternatives) return fetchOnce(adapter, { ...query, limit }, opts, onStart);

  const merged = new Map<string, ScrapedListing>();
  for (const [i, keywords] of alternatives.entries()) {
    const results = await fetchOnce(adapter, { ...query, keywords, alternatives: undefined, limit }, opts, i === 0 ? onStart : undefined);
    for (const listing of results) if (!merged.has(listing.externalId)) merged.set(listing.externalId, listing);
  }
  return [...merged.values()];
}

/** How long one set of rotated alternatives stays current (see rotateAlternatives). */
export const ALTERNATIVE_ROTATION_MS = 10 * 60_000;

/**
 * At most `max` of a query's alternatives, a different window of them each ALTERNATIVE_ROTATION_MS, so
 * every alternative still gets searched regularly (well within GONE_AFTER_MS) without searching all of
 * them on every run. No max: all of them.
 */
export function rotateAlternatives(all: readonly string[], max: number | undefined, now: number): string[] {
  if (!max || max <= 0 || all.length <= max) return [...all];
  const start = (Math.floor(now / ALTERNATIVE_ROTATION_MS) * max) % all.length;
  return Array.from({ length: max }, (_, i) => all[(start + i) % all.length]);
}

/** One adapter.search() call through the per-marketplace gate with a hard timeout. */
async function fetchOnce(
  adapter: MarketplaceAdapter,
  query: SearchQuery,
  opts: FetchOptions,
  onStart?: () => void | Promise<void>,
): Promise<ScrapedListing[]> {
  const gate = opts.gate ?? defaultGate();
  const timeoutMs = opts.timeoutMs ?? defaultSearchTimeoutMs();
  const baseContext = opts.adapterContext ?? createAdapterContext();

  return gate.run(
    adapter.id,
    async () => {
      await onStart?.();
      return withTimeout(
        async (signal) => {
          const signals = [signal, baseContext.signal].filter((s): s is AbortSignal => s !== undefined);
          const ctx = { ...baseContext, signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals) };
          const results: unknown = await adapter.search(query, ctx);
          if (!Array.isArray(results)) throw new ParseError(`${adapter.displayName} returned an invalid result`, adapter.id);
          return results as ScrapedListing[];
        },
        timeoutMs,
        opts.signal,
      );
    },
    opts.signal,
  );
}
