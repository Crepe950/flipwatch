import { describe, expect, it } from "vitest";
import {
  eventKey,
  feedReducer,
  newestEventMs,
  nextConnection,
  OFFLINE_AFTER_FAILURES,
  ONLINE,
  pendingLabel,
  pollSince,
  POLL_OVERLAP_MS,
  readNewEvents,
  unknownEvents,
  type Connection,
  type FeedState,
} from "@/components/feed/feed-state";
import type { FeedApiResponse, FeedItem } from "@/lib/queries/feed";

function item(matchId: number, lastEventAt: string, overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    matchId,
    searchId: 1,
    searchName: "PS5",
    listingId: matchId * 10,
    marketplace: "craigslist",
    url: "https://example.org",
    title: `Item ${matchId}`,
    priceCents: 1000,
    originalPriceCents: 1000,
    currency: "CAD",
    imageUrl: null,
    locationText: null,
    postedAt: null,
    firstSeenAt: lastEventAt,
    lastSeenAt: lastEventAt,
    lastEventAt,
    lastEvent: "new",
    dealScore: null,
    dealScoreReason: null,
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

const T1 = "2026-09-28T10:00:00.000Z";
const T2 = "2026-09-28T11:00:00.000Z";
const T3 = "2026-09-28T12:00:00.000Z";

describe("feed state", () => {
  const base: FeedState = { items: [item(2, T2), item(1, T1)], pending: [] };

  it("queues unknown events behind the pill and ignores ones already shown", () => {
    const next = feedReducer(base, { type: "received", fresh: [item(3, T3), item(2, T2)], reveal: false });
    expect(next.pending.map((i) => i.matchId)).toEqual([3]);
    expect(next.items).toBe(base.items);
    expect(feedReducer(next, { type: "received", fresh: [item(3, T3)], reveal: false })).toBe(next);
  });

  it("moves a match to the top when it gets a newer event (price drop)", () => {
    const drop = item(1, T3, { lastEvent: "price_drop", priceCents: 800 });
    const queued = feedReducer(base, { type: "received", fresh: [drop], reveal: false });
    expect(queued.pending).toEqual([drop]);
    const shown = feedReducer(queued, { type: "reveal" });
    expect(shown.pending).toEqual([]);
    expect(shown.items.map((i) => [i.matchId, i.lastEvent])).toEqual([
      [1, "price_drop"],
      [2, "new"],
    ]);
  });

  it("reveals immediately when asked (user at the top of the page)", () => {
    const next = feedReducer(base, { type: "received", fresh: [item(3, T3)], reveal: true });
    expect(next.items.map((i) => i.matchId)).toEqual([3, 2, 1]);
    expect(next.pending).toEqual([]);
  });

  it("appends older pages without duplicating matches", () => {
    const next = feedReducer(base, { type: "appended", items: [item(1, T1), item(0, "2026-09-28T09:00:00.000Z")] });
    expect(next.items.map((i) => i.matchId)).toEqual([2, 1, 0]);
  });

  it("patches, removes and restores cards", () => {
    const seen = feedReducer(base, { type: "patched", matchIds: [1], patch: { seen: true } });
    expect(seen.items.find((i) => i.matchId === 1)?.seen).toBe(true);
    expect(seen.items[0]).toBe(base.items[0]);

    const inPipeline = feedReducer(base, { type: "patchedListing", listingId: 20, patch: { dealId: 7, dealStage: "lead" } });
    expect(inPipeline.items[0]).toMatchObject({ dealId: 7, dealStage: "lead" });

    const removed = feedReducer(base, { type: "removed", matchId: 2 });
    expect(removed.items.map((i) => i.matchId)).toEqual([1]);
    const restored = feedReducer(removed, { type: "restored", item: base.items[0], index: 0 });
    expect(restored.items.map((i) => i.matchId)).toEqual([2, 1]);
    expect(feedReducer(restored, { type: "restored", item: base.items[0], index: 0 })).toBe(restored);
  });

  it("computes the poll window from the newest known event, with overlap", () => {
    expect(eventKey(item(5, T1))).toBe(`5@${T1}`);
    expect(unknownEvents(base, [item(2, T2), item(2, T3)]).map((i) => i.lastEventAt)).toEqual([T3]);
    expect(newestEventMs([[item(1, T1)], [item(9, T3)]], 0)).toBe(Date.parse(T3));
    expect(newestEventMs([[], []], 42)).toBe(42);
    expect(pollSince(base, 0)).toBe(new Date(Date.parse(T2) - POLL_OVERLAP_MS).toISOString());
    const generatedAt = Date.parse(T3);
    expect(pollSince({ items: [], pending: [] }, generatedAt)).toBe(new Date(generatedAt - POLL_OVERLAP_MS).toISOString());
  });
});

describe("live polling", () => {
  const response = (items: FeedItem[], nextCursor: string | null, unseenCount = 0): FeedApiResponse => ({
    items,
    nextCursor,
    unseenCount,
    serverTime: T3,
  });

  it("follows the cursor through a burst bigger than one page", async () => {
    const pages: Record<string, FeedApiResponse> = {
      start: response([item(9, T3), item(8, T3)], "c1", 12),
      c1: response([item(7, T3), item(6, T3)], "c2", 12),
      c2: response([item(5, T3)], null, 12),
    };
    const cursors: Array<string | null> = [];
    const result = await readNewEvents(async (cursor) => {
      cursors.push(cursor);
      return pages[cursor ?? "start"];
    });
    expect(cursors).toEqual([null, "c1", "c2"]);
    expect(result.items.map((i) => i.matchId)).toEqual([9, 8, 7, 6, 5]);
    expect(result).toMatchObject({ unseenCount: 12, truncated: false });
  });

  it("stops after the page budget and says so", async () => {
    let calls = 0;
    const result = await readNewEvents(async () => response([item(++calls, T3)], `c${calls}`), 3);
    expect(calls).toBe(3);
    expect(result.items).toHaveLength(3);
    expect(result.truncated).toBe(true);
  });

  it("counts only alert-worthy matches as new deals in the pill", () => {
    expect(pendingLabel([item(1, T3), item(2, T3, { silent: true }), item(3, T3)])).toBe("2 new deals");
    expect(pendingLabel([item(1, T3), item(2, T3, { silent: true })])).toBe("1 new deal");
    expect(pendingLabel([item(2, T3, { silent: true }), item(3, T3, { silent: true })])).toBe("2 quiet matches");
    expect(pendingLabel([item(2, T3, { silent: true })])).toBe("1 quiet match");
  });

  it("says offline only after several failed polls, and signed out at once on 401", () => {
    let c: Connection = ONLINE;
    for (let i = 1; i < OFFLINE_AFTER_FAILURES; i++) {
      c = nextConnection(c, "failed");
      expect(c.status).toBe("online");
    }
    c = nextConnection(c, "failed");
    expect(c).toEqual({ status: "offline", failures: OFFLINE_AFTER_FAILURES });
    expect(nextConnection(c, "ok")).toBe(ONLINE);
    expect(nextConnection(ONLINE, "ok")).toBe(ONLINE);

    expect(nextConnection(ONLINE, "offline").status).toBe("offline");
    const expired = nextConnection(ONLINE, "unauthorized");
    expect(expired.status).toBe("expired");
    // Still signed out while the network flaps; back to normal once a request succeeds.
    expect(nextConnection(nextConnection(expired, "failed"), "offline").status).toBe("expired");
    expect(nextConnection(expired, "ok")).toBe(ONLINE);
  });
});
