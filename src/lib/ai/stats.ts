/** Summary of comparable asking prices, all in integer cents. */
export interface CompStats {
  count: number;
  medianCents: number;
  p25Cents: number;
  p75Cents: number;
  minCents: number;
  maxCents: number;
}

/** Linear-interpolated percentile (same as numpy's default) of an ascending-sorted array. */
function percentile(sorted: readonly number[], p: number): number {
  const rank = (sorted.length - 1) * p;
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (rank - lower);
}

/** Price distribution of comparable listings; null when there are none. Non-finite values are ignored. */
export function computeCompStats(pricesCents: readonly number[]): CompStats | null {
  const sorted = pricesCents.filter((p) => Number.isFinite(p)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  return {
    count: sorted.length,
    medianCents: Math.round(percentile(sorted, 0.5)),
    p25Cents: Math.round(percentile(sorted, 0.25)),
    p75Cents: Math.round(percentile(sorted, 0.75)),
    minCents: sorted[0],
    maxCents: sorted[sorted.length - 1],
  };
}
