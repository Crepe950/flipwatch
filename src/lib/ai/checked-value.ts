/**
 * What a stored market price check says a listing is worth: the better of selling it whole and parting
 * it out (a partial part-out total doesn't count), and the profit at the asking price. Reads the stored
 * JSON defensively, so it never needs the price-check module (and its marketplace adapters).
 */
export interface CheckedValue {
  valueCents: number;
  /** The value is the part-out total (otherwise the whole-item price). */
  partOut: boolean;
  profitCents: number;
}

function cents(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

export function checkedValue(result: unknown, priceCents: number | null): CheckedValue | null {
  if (priceCents === null || typeof result !== "object" || result === null) return null;
  const r = result as { item?: { typicalCents?: unknown }; partOutTotalCents?: unknown };
  const whole = cents(r.item?.typicalCents);
  const parts = cents(r.partOutTotalCents);
  if (whole === null && parts === null) return null;
  const partOut = parts !== null && (whole === null || parts > whole);
  const valueCents = partOut ? parts! : whole!;
  return { valueCents, partOut, profitCents: valueCents - priceCents };
}

/** Whether the checked profit reaches `minPct` percent of the asking price. */
export function meetsProfitTarget(value: CheckedValue | null, priceCents: number | null, minPct: number): boolean {
  if (!value || priceCents === null || priceCents <= 0) return false;
  return value.profitCents * 100 >= minPct * priceCents;
}
