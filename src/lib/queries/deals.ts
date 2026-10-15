/** CRM pipeline queries and mutations. */
import { asc, desc, eq } from "drizzle-orm";
import type { Db } from "../db";
import { dealMessages, deals, listings, type Deal, type DealMessage } from "../db/schema";
import { stageEntryPatch, stageRank } from "../deals";
import type { DealStage, MarketplaceId } from "../types";

export type MessageDirection = DealMessage["direction"];

/** The listing fields shown next to a deal. */
export interface DealListing {
  id: number;
  marketplace: MarketplaceId;
  url: string;
  title: string;
  priceCents: number | null;
  currency: string;
  imageUrl: string | null;
  locationText: string | null;
  status: "active" | "gone";
}

export interface PipelineDeal extends Deal {
  listing: DealListing;
}

export interface DealDetail {
  deal: PipelineDeal;
  messages: DealMessage[];
}

const listingColumns = {
  id: listings.id,
  marketplace: listings.marketplace,
  url: listings.url,
  title: listings.title,
  priceCents: listings.priceCents,
  currency: listings.currency,
  imageUrls: listings.imageUrls,
  locationText: listings.locationText,
  status: listings.status,
};

function toDealListing({ imageUrls, ...rest }: { imageUrls: string[] } & Omit<DealListing, "imageUrl">): DealListing {
  const imageUrl = Array.isArray(imageUrls) ? (imageUrls.find((u) => typeof u === "string" && u.length > 0) ?? null) : null;
  return { ...rest, imageUrl };
}

/** Every deal with its listing, most recently updated first. */
export async function listPipelineDeals(db: Db): Promise<PipelineDeal[]> {
  const rows = await db
    .select({ deal: deals, listing: listingColumns })
    .from(deals)
    .innerJoin(listings, eq(listings.id, deals.listingId))
    .orderBy(desc(deals.updatedAt), desc(deals.id));
  return rows.map((r) => ({ ...r.deal, listing: toDealListing(r.listing) }));
}

export async function getDealDetail(db: Db, dealId: number): Promise<DealDetail | null> {
  const [row] = await db
    .select({ deal: deals, listing: listingColumns })
    .from(deals)
    .innerJoin(listings, eq(listings.id, deals.listingId))
    .where(eq(deals.id, dealId))
    .limit(1);
  if (!row) return null;
  const messages = await db
    .select()
    .from(dealMessages)
    .where(eq(dealMessages.dealId, dealId))
    .orderBy(asc(dealMessages.createdAt), asc(dealMessages.id));
  return { deal: { ...row.deal, listing: toDealListing(row.listing) }, messages };
}

export async function getDealByListing(db: Db, listingId: number): Promise<Deal | null> {
  const [deal] = await db.select().from(deals).where(eq(deals.listingId, listingId)).limit(1);
  return deal ?? null;
}

/**
 * Put a listing in the pipeline as a "lead". Idempotent: when the listing already has a deal
 * (including one created concurrently) that deal is returned untouched.
 * Returns null when the listing does not exist.
 */
export async function addListingToPipeline(
  db: Db,
  listingId: number,
  now: Date = new Date(),
): Promise<{ deal: Deal; created: boolean } | null> {
  const [listing] = await db.select({ id: listings.id }).from(listings).where(eq(listings.id, listingId)).limit(1);
  if (!listing) return null;
  const [inserted] = await db
    .insert(deals)
    .values({ listingId, stage: "lead", createdAt: now, updatedAt: now, stageChangedAt: now })
    .onConflictDoNothing({ target: deals.listingId })
    .returning();
  if (inserted) return { deal: inserted, created: true };
  const existing = await getDealByListing(db, listingId);
  return existing ? { deal: existing, created: false } : null;
}

/** Move a deal to another stage, stamping contactedAt / purchasedAt / soldAt when first entered. */
export async function moveDealStage(db: Db, dealId: number, stage: DealStage, now: Date = new Date()): Promise<Deal | null> {
  return db.transaction(async (tx) => {
    const [deal] = await tx.select().from(deals).where(eq(deals.id, dealId)).limit(1);
    if (!deal) return null;
    if (deal.stage === stage) return deal;
    const [updated] = await tx
      .update(deals)
      .set({ stage, updatedAt: now, stageChangedAt: now, ...stageEntryPatch(deal, stage, now) })
      .where(eq(deals.id, dealId))
      .returning();
    return updated ?? null;
  });
}

export interface DealPatch {
  offerCents?: number | null;
  purchaseCents?: number | null;
  salePriceCents?: number | null;
  feesCents?: number | null;
  otherCostsCents?: number | null;
  notes?: string | null;
  followUpAt?: Date | null;
}

export async function updateDealDetails(db: Db, dealId: number, patch: DealPatch, now: Date = new Date()): Promise<Deal | null> {
  const [updated] = await db
    .update(deals)
    .set({ ...patch, updatedAt: now })
    .where(eq(deals.id, dealId))
    .returning();
  return updated ?? null;
}

export async function addDealMessage(
  db: Db,
  dealId: number,
  message: { direction: MessageDirection; body: string; aiGenerated?: boolean },
  now: Date = new Date(),
): Promise<DealMessage | null> {
  return db.transaction(async (tx) => {
    const [deal] = await tx.select({ id: deals.id }).from(deals).where(eq(deals.id, dealId)).limit(1);
    if (!deal) return null;
    const [row] = await tx
      .insert(dealMessages)
      .values({ dealId, direction: message.direction, body: message.body, aiGenerated: message.aiGenerated ?? false, createdAt: now })
      .returning();
    await tx.update(deals).set({ updatedAt: now }).where(eq(deals.id, dealId));
    return row ?? null;
  });
}

/** Deletes the deal and its message log. Returns the listing id, or null when it did not exist. */
export async function deleteDeal(db: Db, dealId: number): Promise<number | null> {
  const [row] = await db.delete(deals).where(eq(deals.id, dealId)).returning({ listingId: deals.listingId });
  return row?.listingId ?? null;
}

/**
 * Record an outreach message as sent: create the deal if needed, advance a "lead" to "contacted",
 * stamp contactedAt, and append the outgoing message. Returns null when the listing does not exist.
 */
export async function logOutreachSent(
  db: Db,
  listingId: number,
  message: { body: string; aiGenerated: boolean },
  now: Date = new Date(),
): Promise<{ deal: Deal; message: DealMessage } | null> {
  const added = await addListingToPipeline(db, listingId, now);
  if (!added) return null;
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(deals).where(eq(deals.id, added.deal.id)).limit(1);
    if (!current) throw new Error("Deal disappeared while logging outreach");
    const advance = current.stage !== "passed" && stageRank(current.stage) < stageRank("contacted");
    const [deal] = await tx
      .update(deals)
      .set({
        stage: advance ? "contacted" : current.stage,
        ...(advance ? { stageChangedAt: now } : {}),
        contactedAt: current.contactedAt ?? now,
        updatedAt: now,
      })
      .where(eq(deals.id, current.id))
      .returning();
    const [row] = await tx
      .insert(dealMessages)
      .values({ dealId: current.id, direction: "out", body: message.body, aiGenerated: message.aiGenerated, createdAt: now })
      .returning();
    return { deal: deal ?? current, message: row };
  });
}
