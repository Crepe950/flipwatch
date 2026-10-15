/** Small, pure text helpers for the Craigslist parser. */

export function cleanText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

/** Key used to match the same title across markup variants (whitespace/case/Unicode-form insensitive). */
export function titleKey(value: string): string {
  return cleanText(value).normalize("NFKC").toLowerCase();
}

/**
 * Absolute timestamps as they appear in markup: ISO 8601 (`time[datetime]`), "2026-09-28 10:15"
 * or `Date#toString()` output in `title` attributes. Strings without a year are rejected because
 * Date.parse would silently guess one.
 */
export function parseAbsoluteDate(value: string | null | undefined): Date | null {
  const s = cleanText(value);
  if (!s || !/\b(19|20)\d{2}\b/.test(s)) return null;
  const time = Date.parse(s);
  return Number.isNaN(time) ? null : new Date(time);
}

const RELATIVE_AGO = /^(\d+)\s*(s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?)\s+ago$/i;
const MONTH_DAY = /^(\d{1,2})\/(\d{1,2})$/;
const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** Craigslist's short date labels: "just now", "12m ago", "3h ago", "2d ago", "9/27". */
export function isRelativeDateLabel(value: string): boolean {
  const s = cleanText(value).toLowerCase();
  return s === "just now" || RELATIVE_AGO.test(s) || MONTH_DAY.test(s);
}

/** Resolve a short date label against `now`. Month/day labels resolve to noon UTC of the latest matching day. */
export function parseRelativeDate(value: string, now: Date): Date | null {
  const s = cleanText(value).toLowerCase();
  if (s === "just now") return new Date(now.getTime());

  const ago = RELATIVE_AGO.exec(s);
  if (ago) {
    const unit = UNIT_MS[ago[2][0]];
    return new Date(now.getTime() - Number(ago[1]) * unit);
  }

  const md = MONTH_DAY.exec(s);
  if (md) {
    const month = Number(md[1]);
    const day = Number(md[2]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    let year = now.getUTCFullYear();
    let date = new Date(Date.UTC(year, month - 1, day, 12));
    if (date.getUTCMonth() !== month - 1) return null; // e.g. 2/30
    if (date.getTime() - now.getTime() > 86_400_000) {
      year -= 1;
      date = new Date(Date.UTC(year, month - 1, day, 12));
    }
    return date;
  }
  return null;
}
