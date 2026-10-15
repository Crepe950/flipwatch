/**
 * eBay's Browse API allows 5,000 calls per day per application, shared by every search that includes
 * eBay (one call per run). Dependency-free so the search editor and Settings can show the floor too.
 */

/** eBay calls per day we plan for: the 5,000/day quota minus headroom for "Test search" and "Run now". */
export const EBAY_DAILY_CALL_BUDGET = 4_500;

/**
 * Shortest interval (seconds) at which `enabledEbaySearches` searches can each poll eBay without
 * exhausting the daily quota: ceil(86,400 × searches / 4,500). 0 when no search uses eBay.
 */
export function ebayQuotaFloorSec(enabledEbaySearches: number): number {
  const n = Math.max(0, Math.floor(enabledEbaySearches) || 0);
  return n === 0 ? 0 : Math.ceil((86_400 * n) / EBAY_DAILY_CALL_BUDGET);
}
