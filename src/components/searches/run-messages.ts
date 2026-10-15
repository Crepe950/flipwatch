/**
 * Display wording for why a marketplace didn't run or failed, shared by the search cards (the stored
 * `lastError`), "Run now" and "Test search". The engine words these for logs ("Backing off until
 * <ISO> (…)", an adapter's whole setup paragraph); users need a short reason and a relative time.
 * Pure and client-safe.
 */
import { MARKETPLACES, isMarketplaceId, type MarketplaceId } from "@/lib/types";

/** Marketplaces that can't run right now: the engine's reason → a short one for display. */
export type SkipReasons = ReadonlyMap<MarketplaceId, { reason: string; short: string }>;

/** Short text for a marketplace that isn't set up (disabled, missing API keys…). */
export const NOT_SET_UP = "not set up (see Settings → Marketplaces)";

export type RunIssue =
  | { marketplace: MarketplaceId | null; kind: "error"; text: string }
  /** Skipped because the marketplace can't serve this search (not set up, wrong country…). */
  | { marketplace: MarketplaceId | null; kind: "skipped"; text: string }
  /** Skipped while the marketplace backs off after failures; `until` is an ISO time. */
  | { marketplace: MarketplaceId | null; kind: "backoff"; text: string; until: string };

// "Backing off until 2026-09-28T22:15:17.730Z (Blocked (403) by craigslist)", possibly cut short by
// the engine's length cap.
const BACKOFF = /^Backing off until (\d{4}-\d\d-\d\dT[\d:.]+Z)(?: \(([\s\S]*?)\)?)?$/;
const SEGMENT_SPLIT = new RegExp(`;\\s+(?=(?:${MARKETPLACES.join("|")}): )`);

function isSkipReason(message: string, reasons: SkipReasons, marketplace: MarketplaceId | null): string | null {
  if (!marketplace) return null;
  const skip = reasons.get(marketplace);
  if (!skip) return null;
  // The stored text may have been truncated ("…") to fit the column.
  const text = message.endsWith("…") ? message.slice(0, -1) : message;
  return text.length > 0 && (skip.reason === text || (text.length >= 20 && skip.reason.startsWith(text))) ? skip.short : null;
}

/** One marketplace's problem, from the engine's message. */
export function describeRunMessage(marketplace: MarketplaceId | null, message: string, reasons: SkipReasons = new Map()): RunIssue {
  const text = message.trim();
  const backoff = BACKOFF.exec(text);
  if (backoff) {
    const detail = backoff[2]?.trim();
    return { marketplace, kind: "backoff", text: detail || "Paused after repeated failures", until: backoff[1] };
  }
  const skipped = isSkipReason(text, reasons, marketplace);
  if (skipped) return { marketplace, kind: "skipped", text: skipped };
  return { marketplace, kind: "error", text };
}

/** Split a search's stored `lastError` ("craigslist: …; kijiji: …") into per-marketplace issues. */
export function describeLastError(lastError: string, reasons: SkipReasons = new Map()): RunIssue[] {
  return lastError
    .split(SEGMENT_SPLIT)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => {
      const colon = segment.indexOf(": ");
      const id = colon > 0 ? segment.slice(0, colon) : "";
      return isMarketplaceId(id) ? describeRunMessage(id, segment.slice(colon + 2), reasons) : describeRunMessage(null, segment, reasons);
    });
}
