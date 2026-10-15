import { describe, expect, it } from "vitest";
import { cleanComps, computeDealScore, median } from "../scoring";

const comps = (...dollars: number[]) => dollars.map((d) => d * 100);

describe("median / cleanComps", () => {
  it("computes the median of odd and even sets", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
  });

  it("drops non-positive and non-finite values", () => {
    expect(cleanComps([0, -5, Number.NaN, Number.POSITIVE_INFINITY, 10, 20])).toEqual([10, 20]);
  });

  it("removes IQR outliers", () => {
    expect(cleanComps([100, 102, 98, 101, 99, 5_000, 1])).toEqual([98, 99, 100, 101, 102]);
    expect(cleanComps([40_000, 42_000, 45_000, 47_000, 50_000, 120_000, 2_000])).toEqual([40_000, 42_000, 45_000, 47_000, 50_000]);
  });

  it("keeps normal variation when most comps share one price (IQR of 0)", () => {
    expect(cleanComps([400, 450, 450, 450, 500])).toEqual([400, 450, 450, 450, 500]);
    expect(cleanComps([300, 450, 450, 450, 450])).toEqual([450, 450, 450, 450]);
  });

  it("keeps small sets untouched (IQR is meaningless under 4 values)", () => {
    expect(cleanComps([1, 1_000, 5])).toEqual([1, 5, 1_000]);
  });
});

describe("computeDealScore", () => {
  it("returns nulls without a price", () => {
    expect(computeDealScore({ priceCents: null, compsCents: comps(1, 2, 3, 4, 5), expectedResaleCents: 10_000 })).toEqual({
      score: null,
      reason: null,
      estimatedProfitCents: null,
    });
  });

  it("returns nulls when there are too few comps and no resale estimate", () => {
    expect(computeDealScore({ priceCents: 10_000, compsCents: comps(100, 110, 120, 130), expectedResaleCents: null })).toEqual({
      score: null,
      reason: null,
      estimatedProfitCents: null,
    });
  });

  it("scores free listings from the expected resale value only", () => {
    expect(computeDealScore({ priceCents: 0, compsCents: comps(400, 450, 450, 450, 500), expectedResaleCents: null })).toEqual({
      score: null,
      reason: "Free",
      estimatedProfitCents: null,
    });
    const withResale = computeDealScore({ priceCents: 0, compsCents: [], expectedResaleCents: 5_000 });
    expect(withResale.score).toBe(100);
    expect(withResale.estimatedProfitCents).toBe(5_000);
    expect(withResale.reason).toBe("Free · Est. profit $50 (100% margin)");
  });

  it("does not score placeholder prices ($1 and below) or use them as comps", () => {
    const set = comps(400, 450, 450, 450, 500);
    for (const priceCents of [1, 99, 100]) {
      expect(computeDealScore({ priceCents, compsCents: set, expectedResaleCents: 50_000 })).toEqual({
        score: null,
        reason: "Placeholder price",
        estimatedProfitCents: null,
      });
    }
    // Five real comps plus placeholders: still five comps.
    expect(computeDealScore({ priceCents: 36_000, compsCents: [...set, 100, 100, 1] }).reason).toBe(
      "20% below the median of 5 similar listings ($450)",
    );
    // Only four real comps: not enough for a median.
    expect(computeDealScore({ priceCents: 36_000, compsCents: [...comps(400, 450, 450, 500), 100] }).score).toBeNull();
  });

  it("scores 50 at the comp median and 1.25 points per percent below it", () => {
    const set = comps(400, 450, 450, 450, 500);
    expect(computeDealScore({ priceCents: 45_000, compsCents: set }).score).toBe(50);
    // 20% below → 50 + 25 = 75
    const cheap = computeDealScore({ priceCents: 36_000, compsCents: set });
    expect(cheap.score).toBe(75);
    expect(cheap.reason).toBe("20% below the median of 5 similar listings ($450)");
    expect(cheap.estimatedProfitCents).toBeNull();
  });

  it("describes prices above and at the median", () => {
    const set = comps(400, 450, 450, 450, 500);
    const pricey = computeDealScore({ priceCents: 54_000, compsCents: set });
    expect(pricey.score).toBe(25);
    expect(pricey.reason).toBe("20% above the median of 5 similar listings ($450)");
    expect(computeDealScore({ priceCents: 45_000, compsCents: set }).reason).toBe("At the median of 5 similar listings ($450)");
  });

  it("clamps comp scores to 0–100", () => {
    const set = comps(400, 450, 450, 450, 500);
    expect(computeDealScore({ priceCents: 1_000, compsCents: set }).score).toBe(100);
    expect(computeDealScore({ priceCents: 200_000, compsCents: set }).score).toBe(0);
  });

  it("ignores outliers when computing the median", () => {
    const set = [...comps(400, 450, 450, 450, 500), 1, 9_999_999];
    const result = computeDealScore({ priceCents: 45_000, compsCents: set });
    expect(result.score).toBe(50);
    expect(result.reason).toContain("median of 5 similar listings");
  });

  it("needs at least 5 comps after dropping junk", () => {
    const result = computeDealScore({ priceCents: 10_000, compsCents: [0, -1, ...comps(100, 100, 100, 100)] });
    expect(result.score).toBeNull();
  });

  it("scores margin against the expected resale value", () => {
    // 40% margin → 50 + 40 = 90
    expect(computeDealScore({ priceCents: 27_000, compsCents: [], expectedResaleCents: 45_000 })).toEqual({
      score: 90,
      reason: "Est. profit $180 (40% margin)",
      estimatedProfitCents: 18_000,
    });
    // ≥ 50 % margin → 100
    expect(computeDealScore({ priceCents: 10_000, compsCents: [], expectedResaleCents: 45_000 }).score).toBe(100);
  });

  it("handles break-even and losses", () => {
    expect(computeDealScore({ priceCents: 45_000, compsCents: [], expectedResaleCents: 45_000 })).toEqual({
      score: 50,
      reason: "Break-even at the expected resale price",
      estimatedProfitCents: 0,
    });
    const loss = computeDealScore({ priceCents: 60_000, compsCents: [], expectedResaleCents: 40_000 });
    expect(loss.score).toBe(0);
    expect(loss.estimatedProfitCents).toBe(-20_000);
    expect(loss.reason).toBe("Est. loss $200 vs. the expected resale price");
  });

  it("averages comp and margin scores when both exist", () => {
    const result = computeDealScore({
      priceCents: 36_000,
      compsCents: comps(400, 450, 450, 450, 500),
      expectedResaleCents: 45_000,
    });
    // comp 75, margin 50 + 20 = 70 → 72.5 → 73
    expect(result.score).toBe(73);
    expect(result.reason).toBe("20% below the median of 5 similar listings ($450) · Est. profit $90 (20% margin)");
  });

  it("ignores a zero or negative resale estimate", () => {
    expect(computeDealScore({ priceCents: 1_000, compsCents: [], expectedResaleCents: 0 }).score).toBeNull();
    expect(computeDealScore({ priceCents: 1_000, compsCents: [], expectedResaleCents: -5 }).score).toBeNull();
  });

  it("formats money in the listing's currency", () => {
    const result = computeDealScore({ priceCents: 5_000, compsCents: [], expectedResaleCents: 10_000, currency: "EUR" });
    expect(result.reason).toBe("Est. profit €50 (50% margin)");
  });
});
