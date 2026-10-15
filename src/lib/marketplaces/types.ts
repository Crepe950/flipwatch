import type { MarketplaceId, ScrapedListing, SearchQuery } from "../types";

/** Things an adapter may need at runtime. Everything is injectable so parsers can be tested offline. */
export interface AdapterContext {
  /** Use this instead of the global fetch (tests replace it with a fixture server). */
  fetch: typeof fetch;
  signal?: AbortSignal;
  log?: (message: string) => void;
  /** Credentials/settings resolved from env (see src/lib/config.ts). */
  credentials: {
    ebayClientId?: string;
    ebayClientSecret?: string;
    ebayMarketplaceId?: string;
    facebookCookies?: string;
  };
}

export interface AdapterStatus {
  /** Whether the adapter can run at all (credentials present, not disabled). */
  ok: boolean;
  /** Why not, or a caveat worth showing in Settings. */
  message?: string;
}

export interface MarketplaceAdapter {
  id: MarketplaceId;
  displayName: string;
  /** ISO country codes the marketplace serves; used to warn about mismatched search locations. */
  countries: string[];
  /** Politeness floor: the scheduler never polls this marketplace for one search more often than this. */
  minIntervalSec: number;
  /** false when the site doesn't understand `a | b` queries: each alternative is then searched separately. Default true. */
  supportsOrQueries?: boolean;
  /** Result cap for this marketplace when one request returns more than the engine's default (RESULT_LIMIT). */
  maxResults?: number;
  /** With supportsOrQueries false: search at most this many alternatives per run, rotating through the rest. */
  maxAlternativesPerRun?: number;
  /** Whether this adapter can run with the current environment. */
  status(): AdapterStatus;
  /** Public URL of the equivalent search on the marketplace website ("open on Craigslist"). */
  buildSearchUrl(query: SearchQuery): string;
  /**
   * Fetch the newest listings for a query, newest first when the marketplace supports sorting.
   * Throw MarketplaceError subclasses on failure; never return partial garbage.
   */
  search(query: SearchQuery, ctx: AdapterContext): Promise<ScrapedListing[]>;
  /**
   * The seller's full description from one listing's page (search results rarely carry it). Null when
   * the page has none; throws MarketplaceError subclasses like search().
   */
  fetchDescription?(url: string, ctx: AdapterContext, opts?: { interactive?: boolean }): Promise<string | null>;
}

export class MarketplaceError extends Error {
  constructor(
    message: string,
    readonly marketplace: MarketplaceId,
    readonly retryable: boolean = true,
  ) {
    super(message);
    this.name = "MarketplaceError";
  }
}

/** HTTP 403, captcha, login wall — back off for a long time. */
export class BlockedError extends MarketplaceError {
  constructor(message: string, marketplace: MarketplaceId) {
    super(message, marketplace, true);
    this.name = "BlockedError";
  }
}

/** HTTP 429 — back off for a while. */
export class RateLimitedError extends MarketplaceError {
  constructor(
    message: string,
    marketplace: MarketplaceId,
    readonly retryAfterSec?: number,
  ) {
    super(message, marketplace, true);
    this.name = "RateLimitedError";
  }
}

/** Missing/invalid credentials or configuration — do not retry until config changes. */
export class NotConfiguredError extends MarketplaceError {
  constructor(message: string, marketplace: MarketplaceId) {
    super(message, marketplace, false);
    this.name = "NotConfiguredError";
  }
}

/** The page/API shape was not what the parser expected (site redesign). */
export class ParseError extends MarketplaceError {
  constructor(message: string, marketplace: MarketplaceId) {
    super(message, marketplace, true);
    this.name = "ParseError";
  }
}
