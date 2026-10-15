import type { Db } from "../db";
import type { AiVerdict, MarketplaceId } from "../types";

/** What an alert is about. A digest bundles the overflow of one search's run into a single message. */
export type AlertKind = "new" | "price_drop" | "digest";

/** A labelled fact, rendered as a Discord field / "Label: value" line elsewhere. */
export interface AlertField {
  label: string;
  value: string;
}

/** One listing inside a digest. */
export interface AlertItem {
  matchId: number;
  listingId: number;
  title: string;
  /** Marketplace listing URL (validated http/https) or null when unusable. */
  url: string | null;
  /** Absolute FlipWatch URL for the listing. */
  appUrl: string;
}

export interface AlertListingData {
  id: number;
  marketplace: MarketplaceId;
  externalId: string;
  title: string;
  url: string | null;
  priceCents: number | null;
  previousPriceCents: number | null;
  originalPriceCents: number | null;
  currency: string;
  locationText: string | null;
  postedAt: string | null;
  imageUrls: string[];
  sellerName: string | null;
  condition: string | null;
}

export interface AlertMatchData {
  id: number;
  event: "new" | "price_drop";
  dealScore: number | null;
  dealScoreReason: string | null;
  estimatedProfitCents: number | null;
  firstMatchedAt: string;
  lastEventAt: string;
}

export interface AlertAiData {
  verdict: AiVerdict;
  dealScore: number;
  summary: string;
  suggestedOfferCents: number | null;
  estimatedResaleLowCents: number | null;
  estimatedResaleHighCents: number | null;
}

/**
 * A channel-agnostic alert. Text fields are plain, unescaped text (they may contain hostile
 * marketplace content); every channel escapes for its own format.
 */
export interface Alert {
  kind: AlertKind;
  /** True for "Send test" alerts. */
  test: boolean;
  title: string;
  /** Short context line, e.g. "Craigslist · Vancouver, BC · posted 5m ago". */
  context: string | null;
  fields: AlertField[];
  /** Plain-text body: the context line followed by the fields as "Label: value". */
  lines: string[];
  /** Listings bundled in a digest (empty otherwise). */
  items: AlertItem[];
  /** Primary click target: the marketplace listing, or the FlipWatch page for digests. */
  url: string;
  /** Absolute FlipWatch URL for this alert. */
  appUrl: string;
  /** Same page as `appUrl`, relative to the app origin (browser push resolves it itself). */
  appPath: string;
  imageUrl: string | null;
  dealScore: number | null;
  /** Stable id for replacing notifications, e.g. "match-12". */
  tag: string;
  timestamp: Date;
  search: { id: number; name: string } | null;
  /** search_matches ids this alert covers. */
  matchIds: number[];
  listing: AlertListingData | null;
  match: AlertMatchData | null;
  ai: AlertAiData | null;
}

/** Runtime dependencies handed to every channel sender. */
export interface SendContext {
  db: Db;
  /** Aborted when the per-send timeout elapses. */
  signal: AbortSignal;
  /** Epoch ms after which the send counts as timed out (used to decide whether a 429 retry fits). */
  deadline: number;
  /** Injectable for tests; defaults to an abortable setTimeout. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** Delivers one alert through one channel. Resolves on success, throws on failure. */
export type ChannelSender = (alert: Alert, config: Record<string, string>, ctx: SendContext) => Promise<void>;
