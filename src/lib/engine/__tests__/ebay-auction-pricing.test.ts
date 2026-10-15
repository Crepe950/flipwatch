/**
 * eBay auction pricing through the real engine: items come from the real eBay mapper (mapItemSummary)
 * and are fed to runSearch by a fake "ebay" adapter. An auction's bid is not a price you can pay, so it
 * must never score as a deal or register as a price drop.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createTestDb, type Db } from "@/lib/db";
import { listings, searchMatches } from "@/lib/db/schema";
import { mapItemSummary } from "@/lib/marketplaces/ebay/parse";
import type { ScrapedListing } from "@/lib/types";
import { aiQueueIdle } from "../ai-queue";
import { runSearch } from "../runner";
import { NOW, fakeAdapter, insertSearch, minutesAfter, noWaitGate, resetDb } from "./helpers";

vi.mock("@/lib/notify", () => ({ notifyMatchEvents: vi.fn(async () => {}) }));
vi.mock("@/lib/ai", () => ({ aiStatus: vi.fn(() => ({ configured: false, model: "" })), evaluateListing: vi.fn(async () => ({})) }));

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => ({ db, close } = await createTestDb()));
beforeEach(() => resetDb(db));
afterEach(() => aiQueueIdle());
afterAll(() => close());

function item(id: string, extra: Record<string, unknown>): ScrapedListing {
  return mapItemSummary(
    {
      itemId: `v1|${id}|0`,
      legacyItemId: id,
      title: `Sony PS5 console ${id}`,
      itemWebUrl: `https://www.ebay.com/itm/${id}`,
      itemCreationDate: minutesAfter(NOW, -10).toISOString(),
      ...extra,
    },
    "USD",
  )!;
}
const usd = (value: string) => ({ value, currency: "USD" });
const fixed = (id: string, dollars: string) => item(id, { buyingOptions: ["FIXED_PRICE"], price: usd(dollars) });

it("neither scores a penny auction as a deal nor reports an auction losing its Buy It Now as a price drop", async () => {
  const comps = [fixed("101", "380.00"), fixed("102", "400.00"), fixed("103", "420.00"), fixed("104", "390.00"), fixed("105", "410.00")];
  // Auction with Buy It Now $400, starting bid $50, no bids yet.
  const withBin = item("200", { buyingOptions: ["AUCTION", "FIXED_PRICE"], price: usd("400.00"), currentBidPrice: usd("50.00"), bidCount: 0 });
  const ebay = fakeAdapter("ebay", { results: [...comps, withBin] });
  const search = await insertSearch(db, { marketplaces: ["ebay"] });
  await runSearch(db, search.id, { adapters: { ebay }, gate: noWaitGate(), now: NOW }); // first run: silent

  // One $55 bid arrives and eBay drops the Buy It Now option; a brand-new $0.99 auction appears too.
  const afterBid = item("200", { buyingOptions: ["AUCTION"], currentBidPrice: usd("55.00"), bidCount: 1 });
  const penny = item("300", { buyingOptions: ["AUCTION"], currentBidPrice: usd("0.99"), price: usd("0.99"), bidCount: 0 });
  ebay.setResults([...comps, afterBid, penny]);
  const second = await runSearch(db, search.id, { adapters: { ebay }, gate: noWaitGate(), now: minutesAfter(NOW, 5) });

  expect(second.events.some((e) => e.type === "price_drop")).toBe(false);

  const rows = await db.select().from(listings);
  const matches = await db.select().from(searchMatches);
  const byExternalId = (externalId: string) => rows.find((r) => r.externalId === externalId)!;
  expect(byExternalId("v1|200|0").priceCents).toBeNull();
  const pennyRow = byExternalId("v1|300|0");
  expect(pennyRow.priceCents).toBeNull();
  expect(second.events).toContainEqual(expect.objectContaining({ type: "new", listingId: pennyRow.id }));
  expect(matches.find((m) => m.listingId === pennyRow.id)?.dealScore).toBeNull();
});
