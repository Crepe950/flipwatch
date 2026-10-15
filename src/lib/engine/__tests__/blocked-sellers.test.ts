import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type Db } from "@/lib/db";
import { searchMatches } from "@/lib/db/schema";
import { blockSeller, isBlockedSeller, listBlockedSellers, loadBlockedSellers, sellerKey, unblockSeller } from "@/lib/queries/blocked-sellers";
import { runSearch } from "../runner";
import { NOW, fakeAdapter, insertSearch, minutesAfter, noWaitGate, resetDb, scraped } from "./helpers";

vi.mock("@/lib/notify", () => ({ notifyMatchEvents: vi.fn(async () => {}) }));

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
beforeEach(() => resetDb(db));
afterAll(() => close());

describe("seller blocklist", () => {
  it("compares seller names ignoring case and spacing, per marketplace", async () => {
    expect(sellerKey("  Bob's   Deals ")).toBe("bob's deals");
    await blockSeller(db, "facebook", "Bob's Deals");
    const blocked = await loadBlockedSellers(db);
    expect(isBlockedSeller(blocked, { marketplace: "facebook", sellerName: "BOB'S  deals" })).toBe(true);
    expect(isBlockedSeller(blocked, { marketplace: "ebay", sellerName: "Bob's Deals" })).toBe(false);
    expect(isBlockedSeller(blocked, { marketplace: "facebook", sellerName: null })).toBe(false);
  });

  it("stops matching a blocked seller's listings and dismisses the ones already matched", async () => {
    const search = await insertSearch(db, { marketplaces: ["facebook"] });
    const adapter = fakeAdapter("facebook", {
      results: [scraped("facebook", "1", { sellerName: "Flipper Frank" }), scraped("facebook", "2", { sellerName: "Private Pam" })],
    });
    const opts = { adapters: { facebook: adapter }, gate: noWaitGate(), notify: false } as const;
    await runSearch(db, search.id, { ...opts, now: NOW });
    expect(await db.select().from(searchMatches)).toHaveLength(2);

    const { dismissed } = await blockSeller(db, "facebook", "flipper frank");
    expect(dismissed).toBe(1);

    adapter.setResults([
      scraped("facebook", "1", { sellerName: "Flipper Frank" }),
      scraped("facebook", "3", { sellerName: "Flipper Frank" }),
      scraped("facebook", "4", { sellerName: "Private Pam" }),
    ]);
    await runSearch(db, search.id, { ...opts, now: minutesAfter(NOW, 10) });
    const matches = await db.select().from(searchMatches);
    // Listing 3 (blocked seller) never becomes a match; 4 does.
    expect(matches).toHaveLength(3);
    const byListing = await db.select({ dismissed: searchMatches.dismissed }).from(searchMatches).where(eq(searchMatches.dismissed, true));
    expect(byListing).toHaveLength(1);
  });

  it("lists and unblocks", async () => {
    await blockSeller(db, "ebay", "megaseller99");
    await blockSeller(db, "ebay", "MegaSeller99"); // same seller: no duplicate
    const list = await listBlockedSellers(db);
    expect(list.map((b) => b.sellerName)).toEqual(["megaseller99"]);
    expect(await unblockSeller(db, list[0].id)).toBe(true);
    expect(await listBlockedSellers(db)).toEqual([]);
  });

  it("refuses a listing without a seller name", async () => {
    await expect(blockSeller(db, "facebook", "   ")).rejects.toThrow(/no seller name/);
  });
});
