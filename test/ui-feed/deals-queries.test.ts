import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type Db } from "@/lib/db";
import { dealMessages, deals, searchMatches } from "@/lib/db/schema";
import {
  addDealMessage,
  addListingToPipeline,
  deleteDeal,
  getDealDetail,
  listPipelineDeals,
  logOutreachSent,
  moveDealStage,
  updateDealDetails,
} from "@/lib/queries/deals";
import { getListingDetail, markListingMatchesSeen } from "@/lib/queries/listings";
import { insertListing, insertMatch, insertSearch } from "./fixtures";

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
});

afterEach(async () => {
  await close();
});

describe("addListingToPipeline", () => {
  it("creates a lead once and returns the same deal on repeat calls", async () => {
    const l = await insertListing(db);
    const first = await addListingToPipeline(db, l.id);
    expect(first).toMatchObject({ created: true, deal: { listingId: l.id, stage: "lead" } });
    await moveDealStage(db, first!.deal.id, "negotiating");

    const second = await addListingToPipeline(db, l.id);
    expect(second).toMatchObject({ created: false, deal: { id: first!.deal.id, stage: "negotiating" } });
    expect(await db.select().from(deals)).toHaveLength(1);
  });

  it("is safe under concurrent calls", async () => {
    const l = await insertListing(db);
    const results = await Promise.all([addListingToPipeline(db, l.id), addListingToPipeline(db, l.id), addListingToPipeline(db, l.id)]);
    expect(new Set(results.map((r) => r?.deal.id)).size).toBe(1);
    expect(results.filter((r) => r?.created)).toHaveLength(1);
  });

  it("returns null for an unknown listing", async () => {
    expect(await addListingToPipeline(db, 12345)).toBeNull();
  });
});

describe("moveDealStage", () => {
  it("stamps stage timestamps once and leaves them on later moves", async () => {
    const l = await insertListing(db);
    const { deal } = (await addListingToPipeline(db, l.id))!;
    const t1 = new Date("2026-09-20T10:00:00Z");
    const t2 = new Date("2026-09-22T10:00:00Z");
    const t3 = new Date("2026-09-25T10:00:00Z");

    const contacted = await moveDealStage(db, deal.id, "contacted", t1);
    expect(contacted).toMatchObject({ stage: "contacted", contactedAt: t1, updatedAt: t1 });
    await moveDealStage(db, deal.id, "lead", t2);
    const again = await moveDealStage(db, deal.id, "contacted", t2);
    expect(again?.contactedAt).toEqual(t1);

    const purchased = await moveDealStage(db, deal.id, "purchased", t2);
    expect(purchased?.purchasedAt).toEqual(t2);
    const sold = await moveDealStage(db, deal.id, "sold", t3);
    expect(sold).toMatchObject({ stage: "sold", purchasedAt: t2, soldAt: t3, stageChangedAt: t3 });
    expect(await moveDealStage(db, 999, "sold")).toBeNull();

    // Editing details must not reset "days in stage".
    const edited = await updateDealDetails(db, deal.id, { notes: "sold to a neighbour" }, new Date("2026-09-28T10:00:00Z"));
    expect(edited?.stageChangedAt).toEqual(t3);
  });
});

describe("deal details, messages and delete", () => {
  it("updates money fields, logs messages and deletes with its log", async () => {
    const l = await insertListing(db, { title: "Aeron size B" });
    const { deal } = (await addListingToPipeline(db, l.id))!;
    const followUpAt = new Date("2026-09-30T12:00:00Z");
    const updated = await updateDealDetails(db, deal.id, { offerCents: 45000, purchaseCents: 47500, notes: "Pick up Sat", followUpAt });
    expect(updated).toMatchObject({ offerCents: 45000, purchaseCents: 47500, notes: "Pick up Sat", followUpAt });
    expect(await updateDealDetails(db, 999, { notes: "x" })).toBeNull();

    await addDealMessage(db, deal.id, { direction: "out", body: "Hi, is this available?" }, new Date("2026-09-20T10:00:00Z"));
    await addDealMessage(db, deal.id, { direction: "in", body: "Yes!" }, new Date("2026-09-20T11:00:00Z"));
    expect(await addDealMessage(db, 999, { direction: "note", body: "x" })).toBeNull();

    const detail = await getDealDetail(db, deal.id);
    expect(detail?.deal.listing).toMatchObject({ id: l.id, title: "Aeron size B", currency: "CAD" });
    expect(detail?.messages.map((m) => m.direction)).toEqual(["out", "in"]);

    const pipeline = await listPipelineDeals(db);
    expect(pipeline).toHaveLength(1);
    expect(pipeline[0].listing.title).toBe("Aeron size B");

    expect(await deleteDeal(db, deal.id)).toBe(l.id);
    expect(await deleteDeal(db, deal.id)).toBeNull();
    expect(await db.select().from(dealMessages)).toHaveLength(0);
    expect(await getDealDetail(db, deal.id)).toBeNull();
  });
});

describe("logOutreachSent", () => {
  it("creates the deal, advances a lead to contacted and appends an outgoing message", async () => {
    const l = await insertListing(db);
    const now = new Date("2026-09-28T10:00:00Z");
    const result = await logOutreachSent(db, l.id, { body: "Would you take $250?", aiGenerated: true }, now);
    expect(result?.deal).toMatchObject({ stage: "contacted", contactedAt: now });
    expect(result?.message).toMatchObject({ direction: "out", aiGenerated: true, body: "Would you take $250?" });
  });

  it("never moves a deal backwards or out of passed, and keeps the first contactedAt", async () => {
    const a = await insertListing(db);
    const b = await insertListing(db);
    const t1 = new Date("2026-09-20T10:00:00Z");
    const t2 = new Date("2026-09-28T10:00:00Z");
    const dealA = (await addListingToPipeline(db, a.id))!.deal;
    await moveDealStage(db, dealA.id, "contacted", t1);
    await moveDealStage(db, dealA.id, "negotiating", t1);
    const dealB = (await addListingToPipeline(db, b.id))!.deal;
    await moveDealStage(db, dealB.id, "passed", t1);

    const ra = await logOutreachSent(db, a.id, { body: "Following up", aiGenerated: false }, t2);
    expect(ra?.deal).toMatchObject({ stage: "negotiating", contactedAt: t1 });
    const rb = await logOutreachSent(db, b.id, { body: "Still available?", aiGenerated: false }, t2);
    expect(rb?.deal).toMatchObject({ stage: "passed", contactedAt: t2 });
  });

  it("returns null for an unknown listing", async () => {
    expect(await logOutreachSent(db, 4242, { body: "hi", aiGenerated: false })).toBeNull();
  });
});

describe("getListingDetail", () => {
  it("collects price history, matches (best score first), latest evaluation and deal", async () => {
    const s1 = await insertSearch(db, "PS5");
    const s2 = await insertSearch(db, "Consoles");
    const l = await insertListing(db, { priceCents: 30000 });
    await insertMatch(db, s1.id, l.id, { dealScore: 40 });
    await insertMatch(db, s2.id, l.id, { dealScore: 85 });
    await addListingToPipeline(db, l.id);

    const detail = await getListingDetail(db, l.id);
    expect(detail?.listing.id).toBe(l.id);
    expect(detail?.priceHistory).toHaveLength(1);
    expect(detail?.matches.map((m) => m.searchName)).toEqual(["Consoles", "PS5"]);
    expect(detail?.evaluation).toBeNull();
    expect(detail?.deal?.stage).toBe("lead");
    expect(await getListingDetail(db, 999)).toBeNull();

    expect(await markListingMatchesSeen(db, l.id)).toBe(2);
    expect((await db.select().from(searchMatches)).every((m) => m.seen)).toBe(true);
  });
});
