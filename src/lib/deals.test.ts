import { describe, expect, it } from "vitest";
import {
  daysInStage,
  dealCostBasisCents,
  dealProfitCents,
  dealRoi,
  followUpFromInput,
  followUpState,
  followUpToInput,
  formatMoneyTotals,
  formatRoi,
  MAX_MONEY_CENTS,
  parseMoneyInput,
  pipelineSummary,
  stageEntryPatch,
  stageRank,
  type SummaryDeal,
} from "./deals";

const money = { purchaseCents: null, salePriceCents: null, feesCents: null, otherCostsCents: null };

function deal(overrides: Partial<SummaryDeal>): SummaryDeal {
  return { ...money, stage: "lead", currency: "CAD", purchasedAt: null, soldAt: null, followUpAt: null, ...overrides };
}

describe("dealProfitCents", () => {
  it("is sale − purchase − fees − other costs", () => {
    expect(dealProfitCents({ purchaseCents: 30000, salePriceCents: 45000, feesCents: 1500, otherCostsCents: 500 })).toBe(13000);
  });

  it("treats missing fees and costs as zero", () => {
    expect(dealProfitCents({ ...money, purchaseCents: 10000, salePriceCents: 12000 })).toBe(2000);
  });

  it("is null without a purchase or a sale price", () => {
    expect(dealProfitCents({ ...money, salePriceCents: 12000 })).toBeNull();
    expect(dealProfitCents({ ...money, purchaseCents: 12000 })).toBeNull();
  });

  it("can be negative (a loss)", () => {
    expect(dealProfitCents({ ...money, purchaseCents: 20000, salePriceCents: 18000, feesCents: 1000 })).toBe(-3000);
  });

  it("works for free pickups", () => {
    expect(dealProfitCents({ ...money, purchaseCents: 0, salePriceCents: 5000 })).toBe(5000);
  });
});

describe("dealRoi", () => {
  it("is profit divided by the full cost basis", () => {
    const d = { purchaseCents: 30000, salePriceCents: 45000, feesCents: 1500, otherCostsCents: 500 };
    expect(dealCostBasisCents(d)).toBe(32000);
    expect(dealRoi(d)).toBeCloseTo(13000 / 32000);
  });

  it("is null when the cost basis is zero or profit is unknown", () => {
    expect(dealRoi({ ...money, purchaseCents: 0, salePriceCents: 5000 })).toBeNull();
    expect(dealRoi({ ...money, purchaseCents: 5000 })).toBeNull();
  });
});

describe("pipelineSummary", () => {
  const now = new Date(2026, 8, 28, 10, 0, 0);

  it("returns empty totals for an empty pipeline", () => {
    expect(pipelineSummary([], now)).toEqual({
      capitalTiedUp: {},
      realizedProfit: {},
      soldCount: 0,
      avgRoi: null,
      avgDaysToSell: null,
      openLeads: 0,
      followUpsDue: 0,
      followUpsOverdue: 0,
    });
  });

  it("aggregates capital, profit, ROI, days to sell, leads and follow-ups", () => {
    const summary = pipelineSummary(
      [
        deal({ stage: "lead" }),
        deal({ stage: "contacted", followUpAt: followUpFromInput("2026-09-28")! }),
        deal({ stage: "negotiating", followUpAt: followUpFromInput("2026-09-20")! }),
        deal({ stage: "purchased", purchaseCents: 30000, otherCostsCents: 2000 }),
        deal({ stage: "listed", purchaseCents: 50000 }),
        deal({
          stage: "sold",
          purchaseCents: 10000,
          salePriceCents: 20000,
          purchasedAt: new Date("2026-09-01T00:00:00Z"),
          soldAt: new Date("2026-09-05T00:00:00Z"),
        }),
        deal({
          stage: "sold",
          purchaseCents: 40000,
          salePriceCents: 50000,
          feesCents: 5000,
          purchasedAt: new Date("2026-09-10T00:00:00Z"),
          soldAt: new Date("2026-09-12T00:00:00Z"),
        }),
        // Sold deals never count as due follow-ups, and passed deals are not open leads.
        deal({ stage: "sold", followUpAt: followUpFromInput("2026-09-01")! }),
        deal({ stage: "passed", followUpAt: followUpFromInput("2026-09-01")! }),
      ],
      now,
    );
    expect(summary.capitalTiedUp).toEqual({ CAD: 82000 });
    expect(summary.realizedProfit).toEqual({ CAD: 10000 + 5000 });
    expect(summary.soldCount).toBe(3);
    expect(summary.avgRoi).toBeCloseTo((1 + 5000 / 45000) / 2);
    expect(summary.avgDaysToSell).toBeCloseTo(3);
    expect(summary.openLeads).toBe(3);
    expect(summary.followUpsDue).toBe(2);
    expect(summary.followUpsOverdue).toBe(1);
  });

  it("keeps currencies apart", () => {
    const summary = pipelineSummary(
      [
        deal({ stage: "purchased", purchaseCents: 10000, currency: "CAD" }),
        deal({ stage: "listed", purchaseCents: 5000, currency: "USD" }),
      ],
      now,
    );
    expect(summary.capitalTiedUp).toEqual({ CAD: 10000, USD: 5000 });
  });
});

describe("follow-up dates", () => {
  it("round-trips a date input as noon UTC", () => {
    const d = followUpFromInput("2026-09-30");
    expect(d?.toISOString()).toBe("2026-09-30T12:00:00.000Z");
    expect(followUpToInput(d)).toBe("2026-09-30");
  });

  it("distinguishes blank from invalid input", () => {
    expect(followUpFromInput("")).toBeNull();
    expect(followUpFromInput(null)).toBeNull();
    expect(followUpFromInput("2026-02-31")).toBeUndefined();
    expect(followUpFromInput("30/09/2026")).toBeUndefined();
  });

  it("classifies overdue, today and upcoming against the local day", () => {
    const now = new Date(2026, 8, 28, 23, 30);
    expect(followUpState(followUpFromInput("2026-09-27"), now)).toBe("overdue");
    expect(followUpState(followUpFromInput("2026-09-28"), now)).toBe("today");
    expect(followUpState(followUpFromInput("2026-09-29"), now)).toBe("upcoming");
    expect(followUpState(null, now)).toBeNull();
  });
});

describe("stage bookkeeping", () => {
  const now = new Date("2026-09-28T10:00:00Z");
  const unset = { contactedAt: null, purchasedAt: null, soldAt: null };

  it("stamps the entered stage's timestamp only when unset", () => {
    expect(stageEntryPatch(unset, "contacted", now)).toEqual({ contactedAt: now });
    expect(stageEntryPatch(unset, "purchased", now)).toEqual({ purchasedAt: now });
    expect(stageEntryPatch(unset, "sold", now)).toEqual({ soldAt: now });
    expect(stageEntryPatch(unset, "negotiating", now)).toEqual({});
    const earlier = new Date("2026-09-01T00:00:00Z");
    expect(stageEntryPatch({ ...unset, contactedAt: earlier }, "contacted", now)).toEqual({});
  });

  it("orders stages and keeps passed off the flow", () => {
    expect(stageRank("lead")).toBeLessThan(stageRank("contacted"));
    expect(stageRank("listed")).toBeLessThan(stageRank("sold"));
    expect(stageRank("passed")).toBe(-1);
  });

  it("counts whole days since the last stage change", () => {
    expect(daysInStage({ stageChangedAt: new Date("2026-09-20T10:00:00Z") }, now)).toBe(8);
    expect(daysInStage({ stageChangedAt: new Date("2026-09-25T09:00:00Z") }, now)).toBe(3);
    expect(daysInStage({ stageChangedAt: new Date("2026-09-27T10:00:00Z") }, now)).toBe(1);
    expect(daysInStage({ stageChangedAt: new Date(now.getTime() + 60_000) }, now)).toBe(0);
  });
});

describe("parseMoneyInput", () => {
  it("parses typical dollar input", () => {
    expect(parseMoneyInput("250")).toBe(25000);
    expect(parseMoneyInput(" $1,250 ")).toBe(125000);
    expect(parseMoneyInput("249.99")).toBe(24999);
    expect(parseMoneyInput("40.5")).toBe(4050);
    expect(parseMoneyInput(".5")).toBe(50);
    expect(parseMoneyInput("0")).toBe(0);
  });

  it("returns null for blank and undefined for invalid input", () => {
    expect(parseMoneyInput("")).toBeNull();
    expect(parseMoneyInput("   ")).toBeNull();
    expect(parseMoneyInput(null)).toBeNull();
    for (const bad of ["abc", "1.2.3", "-5", "12,34", "1.234", "$", ".", "1e5", "12 34"]) {
      expect(parseMoneyInput(bad), bad).toBeUndefined();
    }
    expect(parseMoneyInput(String(MAX_MONEY_CENTS / 100 + 1))).toBeUndefined();
  });
});

describe("formatting", () => {
  it("formats money totals for one or several currencies", () => {
    expect(formatMoneyTotals({ CAD: 125000 })).toBe("$1,250");
    expect(formatMoneyTotals({}, "CAD")).toBe("$0");
    expect(formatMoneyTotals({ CAD: -2500 })).toBe("−$25");
    expect(formatMoneyTotals({ CAD: 10000, USD: 50000 })).toBe("$500 USD · $100 CAD");
  });

  it("formats ROI as a signed percentage", () => {
    expect(formatRoi(0.254)).toBe("+25%");
    expect(formatRoi(-0.1)).toBe("−10%");
    expect(formatRoi(null)).toBe("—");
  });
});
