import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MatchCard } from "@/components/feed/match-card";
import { QUIET_TOOLTIP } from "@/components/feed/quiet";
import { ScoreWithReason } from "@/components/feed/score-with-reason";
import { notSeenRecently, NOT_SEEN_RECENTLY_MS } from "@/components/listing/freshness";
import { MatchedSearches } from "@/components/listing/matched-searches";
import type { FeedItem } from "@/lib/queries/feed";

const T = "2026-09-28T10:00:00.000Z";

function item(overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    matchId: 1,
    searchId: 1,
    searchName: "PS5",
    listingId: 1,
    marketplace: "craigslist",
    url: "https://vancouver.craigslist.org/1.html",
    title: "PS5 slim",
    priceCents: 30_000,
    originalPriceCents: 30_000,
    currency: "CAD",
    imageUrl: null,
    locationText: null,
    postedAt: null,
    firstSeenAt: T,
    lastSeenAt: T,
    lastEventAt: T,
    lastEvent: "new",
    dealScore: 72,
    dealScoreReason: "20% under the median of 14 comparable listings",
    estimatedProfitCents: null,
    silent: false,
    seen: false,
    dismissed: false,
    listingStatus: "active",
    aiVerdict: null,
    aiDealScore: null,
    dealId: null,
    dealStage: null,
    ...overrides,
  };
}

const card = (overrides: Partial<FeedItem>) =>
  renderToStaticMarkup(createElement(MatchCard, { item: item(overrides), onDismiss() {}, onRestore() {}, onSeen() {}, onAddToPipeline() {} }));

const escaped = (text: string) => text.replace(/'/g, "&#x27;");

describe("quiet (silent) matches", () => {
  it("are labelled Quiet with the real reasons, not 'Initial' (first run only)", () => {
    const html = card({ silent: true });
    expect(html).toContain(">Quiet</span>");
    expect(html).toContain(`title="${escaped(QUIET_TOOLTIP)}"`);
    expect(html).not.toContain("Initial");
    expect(QUIET_TOOLTIP).toMatch(/first run/);
    expect(QUIET_TOOLTIP).toMatch(/minimum deal score/);
    expect(QUIET_TOOLTIP).toMatch(/max listing age/);
    expect(card({ silent: false })).not.toContain(">Quiet</span>");
  });

  it("use the same label on the listing page", () => {
    const html = renderToStaticMarkup(
      createElement(MatchedSearches, {
        currency: "CAD",
        matches: [
          {
            matchId: 1,
            searchId: 1,
            searchName: "PS5",
            lastEvent: "new",
            lastEventAt: new Date(T),
            firstMatchedAt: new Date(T),
            dealScore: null,
            dealScoreReason: null,
            estimatedProfitCents: null,
            silent: true,
            seen: false,
            dismissed: false,
          },
        ],
      }),
    );
    expect(html).toContain(">Quiet</span>");
    expect(html).not.toContain("Initial");
  });
});

describe("score tooltip", () => {
  it("is display:none until hovered or focused, so it can't widen narrow pages", () => {
    const html = renderToStaticMarkup(createElement(ScoreWithReason, { score: 72, reason: "20% under the median" }));
    const tooltip = /<span[^>]*role="tooltip"[^>]*>/.exec(html)?.[0] ?? "";
    expect(tooltip).toMatch(/class="[^"]*\bhidden\b/);
    expect(tooltip).toMatch(/group-hover\/score:block/);
    expect(tooltip).toMatch(/group-focus-within\/score:block/);
    expect(tooltip).not.toMatch(/\binvisible\b/);
    // Never wider than the viewport allows next to the photo column.
    expect(tooltip).toMatch(/max-w-\[min\(16rem,calc\(100vw-9rem\)\)\]/);
  });
});

describe("listing freshness", () => {
  const now = new Date("2026-09-28T12:00:00Z");
  it("flags listings missing from results for more than a day", () => {
    expect(notSeenRecently(new Date(now.getTime() - NOT_SEEN_RECENTLY_MS - 1000), now)).toBe(true);
    expect(notSeenRecently(new Date(now.getTime() - NOT_SEEN_RECENTLY_MS + 1000), now)).toBe(false);
    expect(notSeenRecently("2026-09-28T11:00:00Z", now.getTime())).toBe(false);
    expect(notSeenRecently("garbage", now)).toBe(false);
  });
});
