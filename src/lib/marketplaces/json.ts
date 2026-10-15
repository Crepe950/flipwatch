/**
 * Defensive readers for untrusted JSON. Every field an API returns may be missing or the wrong type.
 */

export type JsonObject = Record<string, unknown>;

export function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

// C0 controls other than tab/newline/CR, plus DEL. Postgres text and jsonb reject NUL outright.
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** Non-empty trimmed string without control characters; finite numbers are stringified (ids sometimes arrive as numbers). */
export function asString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const cleaned = value.replace(CONTROL_CHARS, "").trim();
    return cleaned === "" ? undefined : cleaned;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

/** Absolute http(s) URL or undefined — never let `javascript:` or relative junk through. */
export function asHttpUrl(value: unknown): string | undefined {
  const s = asString(value);
  if (!s) return undefined;
  try {
    const url = new URL(s);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** ISO-8601 string or Unix epoch (seconds or milliseconds, number or digit string) → Date. */
export function asDate(value: unknown): Date | null {
  const s = asString(value);
  if (!s) return null;
  let date: Date;
  if (/^\d+(\.\d+)?$/.test(s)) {
    const epoch = Number(s);
    if (epoch <= 0) return null;
    // Anything below 1e11 is seconds (1e11 s is the year 5138; 1e11 ms is 1973).
    date = new Date(epoch < 1e11 ? epoch * 1000 : epoch);
  } else {
    date = new Date(s);
  }
  return Number.isNaN(date.getTime()) ? null : date;
}

export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** listings.price_cents is a Postgres `integer`. */
const MAX_PRICE_CENTS = 2_147_483_647;

/**
 * A storable price, or null. Sellers post placeholder prices ("$1234567890") that would overflow the
 * column and fail the whole batch; treat those — and negatives — as "no price".
 */
export function plausibleCents(cents: number | null): number | null {
  return cents !== null && Number.isSafeInteger(cents) && cents >= 0 && cents <= MAX_PRICE_CENTS ? cents : null;
}
