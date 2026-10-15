import { describe, expect, it } from "vitest";
import { checkedValue, meetsProfitTarget } from "./checked-value";

describe("checkedValue", () => {
  it("takes the better of selling whole and parting out", () => {
    expect(checkedValue({ item: { typicalCents: 63_000 }, partOutTotalCents: 50_000 }, 40_000)).toEqual({ valueCents: 63_000, partOut: false, profitCents: 23_000 });
    expect(checkedValue({ item: { typicalCents: 37_500 }, partOutTotalCents: 50_000 }, 40_000)).toEqual({ valueCents: 50_000, partOut: true, profitCents: 10_000 });
    expect(checkedValue({ item: { typicalCents: null }, partOutTotalCents: null }, 40_000)).toBeNull();
    expect(checkedValue({ item: { typicalCents: 50_000 } }, null)).toBeNull();
    expect(checkedValue("garbage", 40_000)).toBeNull();
  });

  it("checks the profit against a percentage of the asking price", () => {
    const value = checkedValue({ item: { typicalCents: 54_000 } }, 45_000); // +$90 on $450 = 20 %
    expect(meetsProfitTarget(value, 45_000, 20)).toBe(true);
    expect(meetsProfitTarget(value, 45_000, 21)).toBe(false);
    expect(meetsProfitTarget(null, 45_000, 20)).toBe(false);
  });
});
