/** Pure deal scoring from comparable prices and/or the user's expected resale value. */
import { formatPrice } from "../format";

export interface DealScoreInput {
  priceCents: number | null;
  /** Prices of comparable listings (same search, recent). Placeholder prices (≤ $1) are ignored. */
  compsCents: readonly number[];
  expectedResaleCents?: number | null;
  /** Used for the money in `reason` (default USD). */
  currency?: string;
}

export interface DealScore {
  /** 0–100, higher is better; null when there is not enough data. */
  score: number | null;
  reason: string | null;
  estimatedProfitCents: number | null;
}

/** Minimum comparable prices (after outlier removal) before we trust a median. */
export const MIN_COMPS = 5;

/**
 * Prices up to this ($1) are almost always placeholders ("$1 — message me"), not asking prices: they
 * are not scored and never count as comps.
 */
export const PLACEHOLDER_MAX_CENTS = 100;

/** Whether a price is a real asking price worth scoring or comparing against. */
export function isScorablePrice(priceCents: number | null | undefined): priceCents is number {
  return priceCents != null && Number.isFinite(priceCents) && priceCents > PLACEHOLDER_MAX_CENTS;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

function quantile(sorted: readonly number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return quantile([...values].sort((a, b) => a - b), 0.5);
}

/**
 * Drop non-positive/non-finite values and Tukey outliers (outside 1.5 × IQR). Returns sorted values.
 * The fence is at least 25 % of the median: when most comps share one price (IQR ≈ 0), ordinary
 * ±10 % variation must not be thrown away as "outliers".
 */
export function cleanComps(values: readonly number[]): number[] {
  const sorted = values.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (sorted.length < 4) return sorted;
  const q1 = quantile(sorted, 0.25);
  const q3 = quantile(sorted, 0.75);
  const fence = Math.max(1.5 * (q3 - q1), 0.25 * quantile(sorted, 0.5));
  return sorted.filter((v) => v >= q1 - fence && v <= q3 + fence);
}

function compPart(priceCents: number, comps: readonly number[], currency: string) {
  const cleaned = cleanComps(comps);
  if (cleaned.length < MIN_COMPS) return null;
  const med = quantile(cleaned, 0.5);
  const pctBelow = (med - priceCents) / med;
  const score = clamp(Math.round(50 + pctBelow * 125), 0, 100);
  const pct = Math.round(Math.abs(pctBelow) * 100);
  const where = `the median of ${cleaned.length} similar listings (${formatPrice(Math.round(med), currency)})`;
  const reason = pct === 0 ? `At ${where}` : `${pct}% ${pctBelow > 0 ? "below" : "above"} ${where}`;
  return { score, reason };
}

function marginPart(priceCents: number, resaleCents: number, currency: string) {
  const profit = resaleCents - priceCents;
  const margin = profit / resaleCents;
  const score = clamp(Math.round(50 + margin * 100), 0, 100);
  const pct = Math.round(margin * 100);
  const reason =
    profit > 0
      ? `Est. profit ${formatPrice(profit, currency)} (${pct}% margin)`
      : profit === 0
        ? "Break-even at the expected resale price"
        : `Est. loss ${formatPrice(-profit, currency)} vs. the expected resale price`;
  return { score, reason, profit };
}

/**
 * Score a listing 0–100. With ≥ 5 comps: 50 at the median, +1.25 per % below it.
 * With an expected resale value: 50 at break-even, 100 at ≥ 50 % margin. Both → average.
 * Free listings are scored from the expected resale value only (comps say nothing about a $0 price);
 * placeholder prices ($0.01–$1) are not scored.
 */
export function computeDealScore(input: DealScoreInput): DealScore {
  const { priceCents } = input;
  const currency = input.currency ?? "USD";
  if (priceCents == null || !Number.isFinite(priceCents) || priceCents < 0) {
    return { score: null, reason: null, estimatedProfitCents: null };
  }
  const resale = input.expectedResaleCents != null && input.expectedResaleCents > 0 ? input.expectedResaleCents : null;

  if (priceCents === 0) {
    const margin = resale != null ? marginPart(0, resale, currency) : null;
    return {
      score: margin ? margin.score : null,
      reason: margin ? `Free · ${margin.reason}` : "Free",
      estimatedProfitCents: margin ? margin.profit : null,
    };
  }
  if (!isScorablePrice(priceCents)) return { score: null, reason: "Placeholder price", estimatedProfitCents: null };

  const comp = compPart(priceCents, input.compsCents.filter(isScorablePrice), currency);
  const margin = resale != null ? marginPart(priceCents, resale, currency) : null;
  const parts = [comp, margin].filter((p) => p !== null);
  if (parts.length === 0) return { score: null, reason: null, estimatedProfitCents: null };

  return {
    score: Math.round(parts.reduce((sum, p) => sum + p.score, 0) / parts.length),
    reason: parts.map((p) => p.reason).join(" · "),
    estimatedProfitCents: margin ? margin.profit : null,
  };
}
