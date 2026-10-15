import { describe, expect, it } from "vitest";
import { rankByVerifiedProfit, stripCandidateIds, verifiedValue, type HuntPick } from "./deal-hunt";

function pick(rank: number, profit: number | null): HuntPick {
  return {
    rank, listingId: rank, title: `PC ${rank}`, marketplace: "facebook", url: "https://example.com", imageUrl: null, locationText: null,
    priceCents: 50_000, currency: "CAD", estimatedValueCents: profit === null ? null : 50_000 + profit, estimatedProfitCents: profit,
    score: 70, verdict: "good", why: "", redFlags: [],
  };
}

describe("verified values", () => {
  it("values a pick at the better of selling it whole or parting it out", () => {
    expect(verifiedValue({ itemValueCents: 60_000, partOutTotalCents: 72_000 })).toBe(72_000);
    expect(verifiedValue({ itemValueCents: 60_000, partOutTotalCents: null })).toBe(60_000);
    expect(verifiedValue({ itemValueCents: null, partOutTotalCents: null })).toBeNull();
  });

  it("re-ranks by verified profit, unknowns last in their original order, and renumbers", () => {
    const ranked = rankByVerifiedProfit([pick(1, 5_000), pick(2, null), pick(3, 19_000), pick(4, -2_000), pick(5, null)]);
    expect(ranked.map((p) => p.title)).toEqual(["PC 3", "PC 1", "PC 4", "PC 2", "PC 5"]);
    expect(ranked.map((p) => p.rank)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("stripCandidateIds", () => {
  it("removes candidate ids the model leaks into prose, keeping model numbers", () => {
    expect(stripCandidateIds("The closest match is an RTX 4070 Super (c4) at $840.")).toBe("The closest match is an RTX 4070 Super at $840.");
    expect(stripCandidateIds("Both (c2, c7) are overpriced; c12 is the pick.")).toBe("Both are overpriced; is the pick.");
    expect(stripCandidateIds("RTX 3080 12GB vs 3070 Ti, i7-9700k")).toBe("RTX 3080 12GB vs 3070 Ti, i7-9700k");
  });

  it("names the listing a bare id stands for, so the sentence still reads", () => {
    const names = new Map([
      ["c3", "Acer Nitro N50-610 ($300)"],
      ["c7", "i5-8500 + GTX 1660 Ti ($449)"],
    ]);
    expect(stripCandidateIds("Two deals stand out: c3 and c7 offer solid margins; c9 is older.", names)).toBe(
      "Two deals stand out: Acer Nitro N50-610 ($300) and i5-8500 + GTX 1660 Ti ($449) offer solid margins; is older.",
    );
    expect(stripCandidateIds("The Acer Nitro (c3) is the pick.", names)).toBe("The Acer Nitro is the pick.");
  });
});
