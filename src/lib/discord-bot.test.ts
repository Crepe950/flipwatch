import { describe, expect, it } from "vitest";
import type { HuntPick, HuntResult } from "./ai/deal-hunt";
import { formatHuntReply } from "./discord-bot";

function pick(rank: number, overrides: Partial<HuntPick> = {}): HuntPick {
  return {
    rank,
    listingId: rank,
    title: `ASUS RTX 4070 Ti #${rank}`,
    marketplace: "facebook",
    url: `https://www.facebook.com/marketplace/item/${rank}/`,
    imageUrl: null,
    locationText: "Vancouver",
    priceCents: 55_000,
    currency: "CAD",
    estimatedValueCents: 68_000,
    estimatedProfitCents: 13_000,
    score: 82,
    verdict: "great",
    why: "Priced well under the ~$680 these sell for.",
    redFlags: [],
    ...overrides,
  };
}

const result = (picks: HuntPick[]): HuntResult => ({
  understood: "RTX 4070 Ti under $600",
  queries: ["rtx 4070 ti"],
  priceRange: { minCents: null, maxCents: 60_000 },
  summary: "Two good 4070 Tis right now.",
  marketNotes: "RTX 4070 Ti: sells $620-700.",
  considered: 31,
  sources: [],
  picks,
});

describe("formatHuntReply", () => {
  it("lists the top picks with links, value, profit and score, and links to the full results", () => {
    const text = formatHuntReply("rtx 4070 ti under $600", result([pick(1), pick(2)]), "https://fw.example/hunt");
    expect(text).toContain("> rtx 4070 ti under $600");
    expect(text).toContain("**1. [ASUS RTX 4070 Ti \\#1](https://www.facebook.com/marketplace/item/1/)** · $550 → worth ~$680 (+$130) · 82/100 · facebook");
    expect(text).toContain("[full results in FlipWatch](https://fw.example/hunt)");
  });

  it("escapes seller text, never pings, and stays under Discord's 2000-character limit", () => {
    const hostile = pick(1, { title: "@everyone **FREE** [click](https://evil.example)", why: "x".repeat(400), redFlags: ["y".repeat(300)] });
    const many = Array.from({ length: 10 }, (_, i) => pick(i + 2, { why: "z".repeat(400) }));
    const text = formatHuntReply("gpus", result([hostile, ...many]), "https://fw.example/hunt");
    expect(text.length).toBeLessThanOrEqual(2000);
    expect(text).not.toContain("[click](https://evil.example)");
    expect(text).toContain("\\@everyone");
  });

  it("says so when nothing is worth buying", () => {
    expect(formatHuntReply("rtx 5090 under $50", result([]), "https://fw.example/hunt")).toContain("No real deals right now.");
  });
});
