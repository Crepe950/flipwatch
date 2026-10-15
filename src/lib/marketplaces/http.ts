import type { MarketplaceId } from "../types";
import { config } from "../config";
import type { AdapterContext } from "./types";
import { BlockedError, MarketplaceError, RateLimitedError } from "./types";

/** Current stable desktop browsers (September 2026). Refresh a few times a year: stale versions stand out. */
const DESKTOP_USER_AGENTS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:156.0) Gecko/20100101 Firefox/156.0",
];

let uaIndex = 0;
/** Rotate through a small pool of real desktop UAs unless SCRAPER_USER_AGENT pins one. */
export function userAgent(): string {
  const pinned = config.scraperUserAgent;
  if (pinned) return pinned;
  uaIndex = (uaIndex + 1) % DESKTOP_USER_AGENTS.length;
  return DESKTOP_USER_AGENTS[uaIndex];
}

export const BROWSER_HEADERS: Record<string, string> = {
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
};

export interface RequestOptions extends RequestInit {
  /** Per-request timeout; defaults to SCRAPER_TIMEOUT_MS. */
  timeoutMs?: number;
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, Math.round((date - Date.now()) / 1000));
}

/**
 * fetch() with a timeout, browser-like default headers and error classification:
 * 403 → BlockedError, 429 → RateLimitedError, other non-2xx → MarketplaceError.
 */
export async function request(
  ctx: AdapterContext,
  marketplace: MarketplaceId,
  url: string,
  options: RequestOptions = {},
): Promise<Response> {
  const { timeoutMs = config.scraperTimeoutMs, headers, signal, ...init } = options;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signals = [timeout, signal ?? undefined, ctx.signal].filter(Boolean) as AbortSignal[];
  const combined = signals.length === 1 ? signals[0] : AbortSignal.any(signals);

  let res: Response;
  try {
    res = await ctx.fetch(url, {
      redirect: "follow",
      ...init,
      headers: { "User-Agent": userAgent(), ...BROWSER_HEADERS, ...(headers as Record<string, string>) },
      signal: combined,
    });
  } catch (err) {
    if (timeout.aborted) throw new MarketplaceError(`Timed out after ${timeoutMs}ms: ${url}`, marketplace);
    throw new MarketplaceError(`Network error for ${url}: ${(err as Error).message}`, marketplace);
  }

  if (res.ok) return res;

  // Discard the unread error body so the connection is released now, not when the response is garbage-collected.
  await res.body?.cancel().catch(() => undefined);
  if (res.status === 429) {
    throw new RateLimitedError(`Rate limited (429) by ${marketplace}`, marketplace, parseRetryAfter(res.headers.get("retry-after")));
  }
  if (res.status === 403 || res.status === 401) {
    throw new BlockedError(`Blocked (${res.status}) by ${marketplace}`, marketplace);
  }
  throw new MarketplaceError(`HTTP ${res.status} from ${marketplace} for ${url}`, marketplace, res.status >= 500);
}

/** Read a response body, classifying mid-body timeouts/resets as retryable MarketplaceErrors. */
async function readBody(res: Response, marketplace: MarketplaceId, url: string): Promise<string> {
  try {
    return await res.text();
  } catch (err) {
    throw new MarketplaceError(`Failed reading response from ${url}: ${(err as Error).message}`, marketplace);
  }
}

export async function fetchText(
  ctx: AdapterContext,
  marketplace: MarketplaceId,
  url: string,
  options?: RequestOptions,
): Promise<string> {
  const res = await request(ctx, marketplace, url, options);
  return readBody(res, marketplace, url);
}

export async function fetchJson<T = unknown>(
  ctx: AdapterContext,
  marketplace: MarketplaceId,
  url: string,
  options?: RequestOptions,
): Promise<T> {
  const res = await request(ctx, marketplace, url, {
    ...options,
    headers: { Accept: "application/json", ...(options?.headers as Record<string, string>) },
  });
  const text = await readBody(res, marketplace, url);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new MarketplaceError(`Invalid JSON from ${marketplace} (${text.slice(0, 80)}…)`, marketplace);
  }
}

/**
 * Parse a human price string ("$1,250", "CA$40.00", "Free", "1.200,50 €", "1.2k") into cents.
 * Returns 0 for free, null when no number is present.
 */
export function parsePriceToCents(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  if (typeof input === "number") return Number.isFinite(input) ? Math.round(input * 100) : null;
  const s = input.trim().toLowerCase();
  if (!s) return null;
  if (/^free\b/.test(s) || s === "0") return 0;
  const match = s.match(/(\d[\d.,\s]*)/);
  if (!match) return null;
  let num = match[1].replace(/\s/g, "");
  const lastComma = num.lastIndexOf(",");
  const lastDot = num.lastIndexOf(".");
  if (lastComma > lastDot) {
    // European style "1.200,50" or thousands "1,200"
    const decimals = num.length - lastComma - 1;
    num = decimals === 2 ? num.replace(/\./g, "").replace(",", ".") : num.replace(/,/g, "");
  } else {
    num = num.replace(/,/g, "");
  }
  // "1.2k" / "$15K": thousands shorthand right after the number.
  const multiplier = /^k\b/.test(s.slice((match.index ?? 0) + match[0].length)) ? 1000 : 1;
  const value = Number.parseFloat(num) * multiplier;
  return Number.isFinite(value) ? Math.round(value * 100) : null;
}

/** Walk any JSON value depth-first, yielding every plain object. Useful for embedded page state. */
export function* walkObjects(value: unknown, maxDepth = 60): Generator<Record<string, unknown>> {
  const stack: Array<{ v: unknown; d: number }> = [{ v: value, d: 0 }];
  const seen = new Set<unknown>();
  while (stack.length) {
    const { v, d } = stack.pop()!;
    if (v === null || typeof v !== "object" || seen.has(v) || d > maxDepth) continue;
    seen.add(v);
    if (Array.isArray(v)) {
      for (let i = v.length - 1; i >= 0; i--) stack.push({ v: v[i], d: d + 1 });
    } else {
      yield v as Record<string, unknown>;
      const entries = Object.values(v as Record<string, unknown>);
      for (let i = entries.length - 1; i >= 0; i--) stack.push({ v: entries[i], d: d + 1 });
    }
  }
}

/** Great-circle distance in km. */
export function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function kmToMiles(km: number): number {
  return km * 0.621371;
}
