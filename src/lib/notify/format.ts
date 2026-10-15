import type { CheckedValue } from "../ai/checked-value";
import type { AiEvaluation, Listing, Search, SearchMatch } from "../db/schema";
import type { MatchEvent } from "../events";
import { formatPrice, formatSignedPrice, timeAgo } from "../format";
import type { AiVerdict, MarketplaceId } from "../types";
import { cleanText, truncate } from "./escape";
import type { Alert, AlertAiData, AlertField, AlertItem, AlertListingData, AlertMatchData } from "./types";

export const MARKETPLACE_LABELS: Record<MarketplaceId, string> = {
  craigslist: "Craigslist",
  kijiji: "Kijiji",
  ebay: "eBay",
  offerup: "OfferUp",
  facebook: "Facebook",
};

const VERDICT_LABELS: Record<AiVerdict, string> = {
  great: "Great deal",
  good: "Good deal",
  fair: "Fair price",
  pass: "Pass",
};

const MAX_TITLE = 200;
const MAX_AI_SUMMARY = 280;
/** Digest bodies list at most this many listings; the rest are summarised as "…and N more". */
export const MAX_DIGEST_ITEMS = 10;

export interface MatchAlertInput {
  event: Pick<MatchEvent, "type" | "previousPriceCents">;
  search: Pick<Search, "id" | "name">;
  listing: Listing;
  match: SearchMatch;
  ai: AiEvaluation | null;
  /** From the listing's latest market price check, when it has one. */
  checked?: CheckedValue | null;
}

export interface FormatOptions {
  appUrl: string;
  now: Date;
}

/** Price that never throws on odd currency codes from scrapers. */
export function money(cents: number | null | undefined, currency: string): string {
  try {
    return formatPrice(cents, currency || "USD");
  } catch {
    return cents == null ? "—" : `${(cents / 100).toFixed(2)} ${cleanText(currency)}`;
  }
}

function signedMoney(cents: number, currency: string): string {
  try {
    return formatSignedPrice(cents, currency || "USD");
  } catch {
    return `${cents < 0 ? "−" : "+"}${money(Math.abs(cents), currency)}`;
  }
}

/** Accept only absolute http(s) URLs; protocol-relative CDN URLs are upgraded to https. */
export function safeHttpUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const candidate = value.trim().startsWith("//") ? `https:${value.trim()}` : value.trim();
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Base URL for links back into FlipWatch. Tolerates APP_URL without a scheme or with a path/
 * trailing slash; falls back to localhost when it is unusable (channels reject malformed URLs).
 */
export function normalizeAppUrl(raw: string): string {
  const trimmed = raw.trim();
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const url = safeHttpUrl(candidate);
  return url ? url.replace(/[?#].*$/, "").replace(/\/+$/, "") : "http://localhost:3000";
}

export function listingAppPath(listingId: number): string {
  return `/listings/${listingId}`;
}

export function searchAppPath(searchId: number): string {
  return `/?search=${searchId}`;
}

/** "Price drop $150 → $120 · Title" / "$120 · Title" / "Title" (no price). */
export function alertTitle(input: Pick<MatchAlertInput, "event" | "listing">): string {
  const { event, listing } = input;
  const name = truncate(cleanText(listing.title) || "Untitled listing", MAX_TITLE);
  const price = listing.priceCents;
  if (event.type === "price_drop") {
    const previous = previousPrice(event.previousPriceCents, listing);
    const now = price == null ? "?" : money(price, listing.currency);
    return previous == null ? `Price drop to ${now} · ${name}` : `Price drop ${money(previous, listing.currency)} → ${now} · ${name}`;
  }
  return price == null ? name : `${money(price, listing.currency)} · ${name}`;
}

function previousPrice(fromEvent: number | null | undefined, listing: Listing): number | null {
  if (fromEvent != null) return fromEvent;
  // Engine didn't say; the first-seen price is the next best reference if it is higher.
  if (listing.originalPriceCents != null && listing.priceCents != null && listing.originalPriceCents > listing.priceCents) {
    return listing.originalPriceCents;
  }
  return null;
}

function contextLine(listing: Listing, now: Date): string {
  const parts = [MARKETPLACE_LABELS[listing.marketplace] ?? cleanText(listing.marketplace)];
  const location = cleanText(listing.locationText);
  if (location) parts.push(truncate(location, 80));
  if (listing.postedAt) parts.push(`posted ${timeAgo(listing.postedAt, now)}`);
  return parts.join(" · ");
}

function matchFields(input: MatchAlertInput): AlertField[] {
  const { match, listing, ai, search } = input;
  const fields: AlertField[] = [];
  if (match.dealScore != null) {
    const reason = cleanText(match.dealScoreReason);
    fields.push({ label: "Deal score", value: `${match.dealScore}/100${reason ? ` · ${truncate(reason, 160)}` : ""}` });
  }
  if (match.estimatedProfitCents != null) {
    fields.push({ label: "Est. profit", value: signedMoney(match.estimatedProfitCents, listing.currency) });
  }
  if (input.checked) {
    const { valueCents, partOut, profitCents } = input.checked;
    fields.push({
      label: "Price-checked",
      value: `${partOut ? "parts" : "whole"} ~${money(valueCents, listing.currency)} · profit ${signedMoney(profitCents, listing.currency)} (live comps)`,
    });
  }
  if (ai) {
    const offer = ai.suggestedOfferCents != null ? ` · offer ${money(ai.suggestedOfferCents, listing.currency)}` : "";
    const summary = truncate(cleanText(ai.summary), MAX_AI_SUMMARY);
    fields.push({ label: "AI verdict", value: `${VERDICT_LABELS[ai.verdict] ?? ai.verdict}${offer}${summary ? ` — ${summary}` : ""}` });
  }
  fields.push({ label: "Search", value: truncate(cleanText(search.name), 80) || `#${search.id}` });
  return fields;
}

function imageUrls(listing: Listing): string[] {
  const urls = Array.isArray(listing.imageUrls) ? listing.imageUrls : [];
  return urls.map(safeHttpUrl).filter((u): u is string => u !== null);
}

function toLines(context: string | null, fields: AlertField[]): string[] {
  return [...(context ? [context] : []), ...fields.map((f) => `${f.label}: ${f.value}`)];
}

function listingData(listing: Listing, previousPriceCents: number | null): AlertListingData {
  return {
    id: listing.id,
    marketplace: listing.marketplace,
    externalId: listing.externalId,
    title: listing.title,
    url: safeHttpUrl(listing.url),
    priceCents: listing.priceCents,
    previousPriceCents,
    originalPriceCents: listing.originalPriceCents,
    currency: listing.currency,
    locationText: listing.locationText,
    postedAt: listing.postedAt ? listing.postedAt.toISOString() : null,
    imageUrls: imageUrls(listing),
    sellerName: listing.sellerName,
    condition: listing.condition,
  };
}

function matchData(match: SearchMatch, event: MatchAlertInput["event"]): AlertMatchData {
  return {
    id: match.id,
    event: event.type,
    dealScore: match.dealScore,
    dealScoreReason: match.dealScoreReason,
    estimatedProfitCents: match.estimatedProfitCents,
    firstMatchedAt: match.firstMatchedAt.toISOString(),
    lastEventAt: match.lastEventAt.toISOString(),
  };
}

function aiData(ai: AiEvaluation | null): AlertAiData | null {
  if (!ai) return null;
  return {
    verdict: ai.verdict,
    dealScore: ai.dealScore,
    summary: ai.summary,
    suggestedOfferCents: ai.suggestedOfferCents,
    estimatedResaleLowCents: ai.estimatedResaleLowCents,
    estimatedResaleHighCents: ai.estimatedResaleHighCents,
  };
}

/** One alert for one (match, event). */
export function buildMatchAlert(input: MatchAlertInput, opts: FormatOptions): Alert {
  const { event, listing, match, search } = input;
  const appPath = listingAppPath(listing.id);
  const appUrl = `${opts.appUrl}${appPath}`;
  const context = contextLine(listing, opts.now);
  const fields = matchFields(input);
  const listingUrl = safeHttpUrl(listing.url);
  const imageUrl = imageUrls(listing)[0] ?? null;
  const previous = event.type === "price_drop" ? previousPrice(event.previousPriceCents, listing) : null;
  return {
    kind: event.type,
    test: false,
    title: alertTitle(input),
    context,
    fields,
    lines: toLines(context, fields),
    items: [],
    url: listingUrl ?? appUrl,
    appUrl,
    appPath,
    imageUrl,
    dealScore: match.dealScore,
    tag: `match-${match.id}`,
    timestamp: listing.postedAt && event.type === "new" ? listing.postedAt : opts.now,
    search: { id: search.id, name: search.name },
    matchIds: [match.id],
    listing: listingData(listing, previous),
    match: matchData(match, event),
    ai: aiData(input.ai),
  };
}

/** "+7 more matches for PS5", linking to the search's feed. */
export function buildDigestAlert(search: Pick<Search, "id" | "name">, inputs: MatchAlertInput[], opts: FormatOptions): Alert {
  const appPath = searchAppPath(search.id);
  const appUrl = `${opts.appUrl}${appPath}`;
  const name = truncate(cleanText(search.name), 80) || `search #${search.id}`;
  const count = inputs.length;
  const items: AlertItem[] = inputs.map(({ listing, match, event }) => ({
    matchId: match.id,
    listingId: listing.id,
    title: alertTitle({ event, listing }),
    url: safeHttpUrl(listing.url),
    appUrl: `${opts.appUrl}${listingAppPath(listing.id)}`,
  }));
  const shown = items.slice(0, MAX_DIGEST_ITEMS);
  const lines = shown.map((i) => i.title);
  if (items.length > shown.length) lines.push(`…and ${items.length - shown.length} more`);
  const scores = inputs.map((i) => i.match.dealScore).filter((s): s is number => s != null);
  return {
    kind: "digest",
    test: false,
    title: `+${count} more ${count === 1 ? "match" : "matches"} for ${name}`,
    context: null,
    fields: [],
    lines,
    items,
    url: appUrl,
    appUrl,
    appPath,
    imageUrl: null,
    dealScore: scores.length ? Math.max(...scores) : null,
    tag: `digest-${search.id}`,
    timestamp: opts.now,
    search: { id: search.id, name: search.name },
    matchIds: inputs.map((i) => i.match.id),
    listing: null,
    match: null,
    ai: null,
  };
}

/** A realistic alert for "Send test" that exercises every section of the templates. */
export function buildSampleAlert(opts: FormatOptions): Alert {
  const appPath = "/";
  const appUrl = `${opts.appUrl}${appPath}`;
  const context = "Craigslist · Vancouver, BC · posted just now";
  const fields: AlertField[] = [
    { label: "Deal score", value: "86/100 · 32% below median of 14 comps" },
    { label: "Est. profit", value: "+$95" },
    { label: "AI verdict", value: "Great deal · offer $110 — Clean unit with both controllers; priced well under recent sold comps." },
    { label: "Search", value: "PS5 (test)" },
  ];
  return {
    kind: "new",
    test: true,
    title: "$120 · Sony PS5 Digital Edition + 2 controllers",
    context,
    fields,
    lines: [...toLines(context, fields), "This is a test alert from FlipWatch — your channel works."],
    items: [],
    url: appUrl,
    appUrl,
    appPath,
    imageUrl: null,
    dealScore: 86,
    tag: "flipwatch-test",
    timestamp: opts.now,
    search: null,
    matchIds: [],
    listing: {
      id: 0,
      marketplace: "craigslist",
      externalId: "flipwatch-test",
      title: "Sony PS5 Digital Edition + 2 controllers",
      url: null,
      priceCents: 12_000,
      previousPriceCents: null,
      originalPriceCents: 12_000,
      currency: "USD",
      locationText: "Vancouver, BC",
      postedAt: opts.now.toISOString(),
      imageUrls: [],
      sellerName: null,
      condition: "used",
    },
    match: {
      id: 0,
      event: "new",
      dealScore: 86,
      dealScoreReason: "32% below median of 14 comps",
      estimatedProfitCents: 9_500,
      firstMatchedAt: opts.now.toISOString(),
      lastEventAt: opts.now.toISOString(),
    },
    ai: null,
  };
}
