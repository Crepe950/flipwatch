/** Formatting helpers safe to use from both server and client components. */

export function formatPrice(cents: number | null | undefined, currency = "USD", opts: { compact?: boolean } = {}): string {
  if (cents === null || cents === undefined) return "—";
  if (cents === 0) return "Free";
  const value = cents / 100;
  const whole = Number.isInteger(value) || opts.compact;
  return new Intl.NumberFormat(currency === "CAD" ? "en-CA" : "en-US", {
    style: "currency",
    currency,
    currencyDisplay: "narrowSymbol",
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
    notation: opts.compact && Math.abs(value) >= 10_000 ? "compact" : "standard",
  }).format(value);
}

/** Signed money, e.g. "+$120" / "−$40". */
export function formatSignedPrice(cents: number | null | undefined, currency = "USD"): string {
  if (cents === null || cents === undefined) return "—";
  const sign = cents > 0 ? "+" : cents < 0 ? "−" : "";
  return `${sign}${formatPrice(Math.abs(cents), currency)}`.replace("Free", formatZero(currency));
}

function formatZero(currency: string) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency, currencyDisplay: "narrowSymbol", maximumFractionDigits: 0 }).format(0);
}

/** "3m ago", "2h ago", "5d ago". */
export function timeAgo(date: Date | string | number | null | undefined, now: Date = new Date()): string {
  if (date === null || date === undefined) return "—";
  const d = date instanceof Date ? date : new Date(date);
  const seconds = Math.round((now.getTime() - d.getTime()) / 1000);
  if (!Number.isFinite(seconds)) return "—";
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Parse a user-typed dollar amount ("1,250", "$40.5") into cents; null for blank/invalid. */
export function dollarsToCents(input: string | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  const cleaned = String(input).replace(/[^0-9.]/g, "");
  if (!cleaned) return null;
  const value = Number.parseFloat(cleaned);
  return Number.isFinite(value) ? Math.round(value * 100) : null;
}

export function centsToDollarsInput(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "";
  return (cents / 100).toFixed(cents % 100 === 0 ? 0 : 2);
}

export function percent(n: number, digits = 0): string {
  return `${(n * 100).toFixed(digits)}%`;
}
