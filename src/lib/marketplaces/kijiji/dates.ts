import { cleanText } from "./common";

const UNIT_MS: Record<string, number> = { second: 1_000, minute: 60_000, hour: 3_600_000, day: 86_400_000 };
const AGO = /^<?\s*(\d+|an?)\s+(second|minute|hour|day)s?\s+ago$/;
const DAY_MONTH_YEAR = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

/**
 * Posting dates as shown on result cards: "< 9 minutes ago", "an hour ago", "3 hours ago",
 * "Yesterday", "27/09/2026" (Kijiji uses day/month/year), or an ISO timestamp from `datetime`.
 * Calendar dates resolve to noon UTC. Unknown formats yield null rather than a guess.
 */
export function parseKijijiDate(value: string | null | undefined, now: Date): Date | null {
  const text = cleanText(value);
  const s = text.toLowerCase();
  if (!s) return null;
  if (s === "just now" || s === "now") return new Date(now.getTime());
  if (s === "yesterday") return new Date(now.getTime() - UNIT_MS.day);

  const ago = AGO.exec(s);
  if (ago) {
    const count = /^\d+$/.test(ago[1]) ? Number(ago[1]) : 1;
    return new Date(now.getTime() - count * UNIT_MS[ago[2]]);
  }

  const dmy = DAY_MONTH_YEAR.exec(s);
  if (dmy) {
    const [day, month, year] = [Number(dmy[1]), Number(dmy[2]), Number(dmy[3])];
    const date = new Date(Date.UTC(year, month - 1, day, 12));
    return date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date : null;
  }

  if (/^\d{4}-\d{2}-\d{2}/.test(text)) {
    const time = Date.parse(text);
    return Number.isNaN(time) ? null : new Date(time);
  }
  return null;
}
