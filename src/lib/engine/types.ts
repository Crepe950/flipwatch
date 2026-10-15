import type { MatchEvent } from "../events";
import type { AdapterContext, MarketplaceAdapter } from "../marketplaces/types";
import type { MarketplaceId, ScrapedListing } from "../types";
import type { MarketplaceGate } from "./gate";

export interface MarketplaceRunResult {
  marketplace: MarketplaceId;
  resultCount: number;
  matchedCount: number;
  newCount: number;
  priceDropCount: number;
  durationMs: number;
  error?: string;
  /** Set when the marketplace was not queried (backoff, not configured, interval not elapsed…). */
  skipped?: string;
}

export interface RunSearchResult {
  searchId: number;
  startedAt: Date;
  finishedAt: Date;
  marketplaces: MarketplaceRunResult[];
  events: MatchEvent[];
}

/** Adapter overrides, mainly for tests. Missing entries fall back to the registry. */
export type AdapterOverrides = Partial<Record<MarketplaceId, MarketplaceAdapter>>;

/** Options shared by everything that queries marketplaces. */
export interface FetchOptions {
  adapterContext?: AdapterContext;
  adapters?: AdapterOverrides;
  /** Per-marketplace politeness gate; defaults to the process-wide one. */
  gate?: MarketplaceGate;
  /** Hard cap for one adapter.search() call (default: 2 × SCRAPER_TIMEOUT_MS + 5 s). */
  timeoutMs?: number;
  /** Cancels waiting and in-flight marketplace requests (used on shutdown). */
  signal?: AbortSignal;
}

export interface RunSearchOptions extends FetchOptions {
  now?: Date;
  /** Send notifications for non-silent events (default true). */
  notify?: boolean;
  /** Ignore marketplace backoff (manual "Run now"). */
  force?: boolean;
}

export interface PreviewListing extends ScrapedListing {
  passesFilters: boolean;
  rejectReason?: string;
  /** Posted longer ago than the search's max listing age (would be stored silently). */
  stale?: boolean;
}

export interface PreviewResult {
  marketplace: MarketplaceId;
  listings: PreviewListing[];
  error?: string;
  searchUrl?: string;
}

export interface PreviewOptions extends FetchOptions {
  now?: Date;
}

export interface TickResult {
  ranSearchIds: number[];
  errors: Array<{ searchId: number; error: string }>;
}

export interface TickOptions extends FetchOptions {
  now?: Date;
  /** How many searches run at once (default 3). */
  concurrency?: number;
  /** Max searches claimed per tick (default 10); the rest are picked up by later ticks. */
  limit?: number;
}

export interface Scheduler {
  stop(): Promise<void>;
}
