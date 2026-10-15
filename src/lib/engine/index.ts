/**
 * Engine public API: running searches, previews, scheduling, plus the pure filter/scoring helpers.
 * Everything here is plain Node (no Next.js imports) so the standalone worker can use it too.
 */
export type {
  AdapterOverrides,
  FetchOptions,
  MarketplaceRunResult,
  PreviewListing,
  PreviewOptions,
  PreviewResult,
  RunSearchOptions,
  RunSearchResult,
  Scheduler,
  TickOptions,
  TickResult,
} from "./types";

export { previewSearch, runSearch } from "./runner";
export {
  claimDueSearches,
  countEnabledEbaySearches,
  ebayConfigured,
  effectiveIntervalSec,
  loadEbayQuotaFloorSec,
  startScheduler,
  tick,
} from "./scheduler";
export type { Claim, IntervalFloors, SchedulerOptions } from "./scheduler";
export { EBAY_DAILY_CALL_BUDGET, ebayQuotaFloorSec } from "./ebay-quota";

export { createListingFilter, evaluateListing, normalizeText, parseQuery } from "./filters";
export type { FilterableListing, FilterableSearch, FilterResult, ParsedQuery } from "./filters";
export { computeDealScore } from "./scoring";
export type { DealScore, DealScoreInput } from "./scoring";
export { backoffDelayMs } from "./backoff";
export { MarketplaceGate } from "./gate";

export { aiQueueIdle } from "./ai-queue";
export { getHealthSummary } from "./health";
export type { HealthSummary, MarketplaceHealthSummary } from "./health";
export { HEARTBEAT_KEY, readHeartbeat, writeHeartbeat } from "./heartbeat";
export type { Heartbeat } from "./heartbeat";
export { runRetention, runRetentionIfDue } from "./retention";
export type { RetentionResult } from "./retention";
export { isAuthorizedCronRequest } from "./cron-auth";
