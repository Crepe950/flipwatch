/**
 * Serializable views of engine results for the client ("Run now" toast, "Test search" panel).
 * Engine results carry Dates and raw marketplace payloads; these keep only what the UI renders.
 */
import type { PreviewResult, RunSearchResult } from "@/lib/engine";
import type { MarketplaceId } from "@/lib/types";
import { safeHttpUrl } from "./describe";
import type { SkipReasons } from "./run-messages";

export interface RunMarketplaceView {
  marketplace: MarketplaceId;
  resultCount: number;
  matchedCount: number;
  newCount: number;
  priceDropCount: number;
  durationMs: number;
  error?: string;
  skipped?: string;
}

export interface RunSummary {
  searchId: number;
  searchName: string;
  durationMs: number;
  resultCount: number;
  newCount: number;
  priceDropCount: number;
  errorCount: number;
  skippedCount: number;
  marketplaces: RunMarketplaceView[];
}

/** `skipReasons` swaps the engine's long explanations of why a marketplace was skipped for short ones. */
export function summarizeRun(result: RunSearchResult, searchName: string, skipReasons: SkipReasons = new Map()): RunSummary {
  const shortSkip = (m: MarketplaceId, reason: string) => {
    const known = skipReasons.get(m);
    return known && known.reason === reason ? known.short : reason;
  };
  const marketplaces = result.marketplaces.map((m) => ({
    marketplace: m.marketplace,
    resultCount: m.resultCount,
    matchedCount: m.matchedCount,
    newCount: m.newCount,
    priceDropCount: m.priceDropCount,
    durationMs: m.durationMs,
    ...(m.error ? { error: m.error } : {}),
    ...(m.skipped ? { skipped: shortSkip(m.marketplace, m.skipped) } : {}),
  }));
  const sum = (pick: (m: RunMarketplaceView) => number) => marketplaces.reduce((total, m) => total + pick(m), 0);
  return {
    searchId: result.searchId,
    searchName,
    durationMs: Math.max(0, new Date(result.finishedAt).getTime() - new Date(result.startedAt).getTime()),
    resultCount: sum((m) => m.resultCount),
    newCount: sum((m) => m.newCount),
    priceDropCount: sum((m) => m.priceDropCount),
    errorCount: marketplaces.filter((m) => m.error).length,
    skippedCount: marketplaces.filter((m) => m.skipped && !m.error).length,
    marketplaces,
  };
}

/** One-line headline, e.g. "3 new · 1 price drop · 42 results". */
export function runHeadline(summary: RunSummary): string {
  if (summary.marketplaces.length === 0) return "No marketplaces were queried";
  const parts = [`${summary.newCount} new`];
  if (summary.priceDropCount) parts.push(`${summary.priceDropCount} price drop${summary.priceDropCount === 1 ? "" : "s"}`);
  parts.push(`${summary.resultCount} result${summary.resultCount === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

export interface PreviewListingView {
  key: string;
  title: string;
  url: string | null;
  imageUrl: string | null;
  priceCents: number | null;
  currency: string;
  locationText: string | null;
  postedAt: string | null;
  passesFilters: boolean;
  rejectReason: string | null;
}

export interface PreviewMarketplaceView {
  marketplace: MarketplaceId;
  total: number;
  passing: number;
  failing: number;
  error: string | null;
  /** Why the marketplace wasn't queried (not set up, doesn't serve the country), shown like "Run now" does. */
  skipped: string | null;
  searchUrl: string | null;
  listings: PreviewListingView[];
}

function isoOrNull(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** `skipReasons`: marketplaces that can't run for this search, so their "error" is a skip, not a failure. */
export function toPreviewView(
  results: PreviewResult[],
  { perMarketplace = 10, skipReasons = new Map() }: { perMarketplace?: number; skipReasons?: SkipReasons } = {},
): PreviewMarketplaceView[] {
  return results.map((r) => {
    const passing = r.listings.filter((l) => l.passesFilters).length;
    const skip = skipReasons.get(r.marketplace);
    const skipped = r.error && skip && r.error === skip.reason ? skip.short : null;
    return {
      marketplace: r.marketplace,
      total: r.listings.length,
      passing,
      failing: r.listings.length - passing,
      error: skipped ? null : (r.error ?? null),
      skipped,
      searchUrl: safeHttpUrl(r.searchUrl),
      listings: r.listings.slice(0, perMarketplace).map((l, index) => ({
        key: `${l.externalId || "listing"}-${index}`,
        title: (l.title || "Untitled listing").slice(0, 300),
        url: safeHttpUrl(l.url),
        imageUrl: safeHttpUrl(l.imageUrls?.[0]),
        priceCents: l.priceCents,
        currency: l.currency || "USD",
        locationText: l.locationText ? l.locationText.slice(0, 120) : null,
        postedAt: isoOrNull(l.postedAt),
        passesFilters: l.passesFilters,
        rejectReason: l.passesFilters ? null : (l.rejectReason ?? "Filtered out"),
      })),
    };
  });
}
