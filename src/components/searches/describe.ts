/** Small display helpers for saved searches (pure; safe on server and client). */
import { formatPrice } from "@/lib/format";

export function describePriceRange(minCents: number | null, maxCents: number | null, currency: string): string {
  if (maxCents === 0) return "Free only";
  // A $0 minimum is no minimum at all ("Free–$400" reads oddly).
  const min = minCents ? minCents : null;
  if (min != null && maxCents != null) return `${formatPrice(min, currency)}–${formatPrice(maxCents, currency)}`;
  if (maxCents != null) return `Up to ${formatPrice(maxCents, currency)}`;
  if (min != null) return `${formatPrice(min, currency)}+`;
  return "Any price";
}

export function describeInterval(seconds: number): string {
  // Short odd intervals (e.g. OfferUp's 90 s floor) would round to a wrong number of minutes.
  if (seconds < 60 || (seconds < 600 && seconds % 60 !== 0)) return `every ${seconds}s`;
  if (seconds < 3600) {
    const minutes = Math.round(seconds / 60);
    return minutes === 1 ? "every minute" : `every ${minutes} min`;
  }
  const hours = Math.round((seconds / 3600) * 10) / 10;
  return hours === 1 ? "every hour" : `every ${hours} h`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.round(ms / 1000)} s`;
}

/** Only http(s) links from marketplace data are rendered as hrefs/images. */
export function safeHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}
