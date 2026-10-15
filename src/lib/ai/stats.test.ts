import { describe, expect, it } from "vitest";
import { computeCompStats } from "./stats";

describe("computeCompStats", () => {
  it("returns null without prices", () => {
    expect(computeCompStats([])).toBeNull();
    expect(computeCompStats([Number.NaN, Number.POSITIVE_INFINITY])).toBeNull();
  });

  it("computes interpolated quartiles on unsorted input without mutating it", () => {
    const prices = [50000, 10000, 40000, 20000, 30000];
    expect(computeCompStats(prices)).toEqual({
      count: 5,
      medianCents: 30000,
      p25Cents: 20000,
      p75Cents: 40000,
      minCents: 10000,
      maxCents: 50000,
    });
    expect(prices).toEqual([50000, 10000, 40000, 20000, 30000]);
  });

  it("interpolates between neighbours and rounds to whole cents", () => {
    expect(computeCompStats([100, 201, 300, 401])).toMatchObject({ medianCents: 251, p25Cents: 176, p75Cents: 325 });
  });

  it("handles a single comparable", () => {
    expect(computeCompStats([45000])).toEqual({
      count: 1,
      medianCents: 45000,
      p25Cents: 45000,
      p75Cents: 45000,
      minCents: 45000,
      maxCents: 45000,
    });
  });
});
