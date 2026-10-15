/**
 * Listing persistence. Listings are shared by all searches and identified by (marketplace, externalId).
 * Every price (or currency) change writes a price_history row in the same transaction as the price
 * update, so the history is always a faithful timeline (price-drop detection in matches.ts depends on that).
 */
import { and, eq, gt, gte, inArray, isNotNull, isNull, lt, or } from "drizzle-orm";
import type { Db } from "../db";
import { listings, priceHistory, searchMatches, type Listing, type NewListing } from "../db/schema";
import type { MarketplaceId, ScrapedListing } from "../types";

export interface UpsertedListing {
  listing: Listing;
  /** First time this listing was ever stored. */
  isNew: boolean;
}

function insertValues(s: ScrapedListing, now: Date): NewListing {
  return {
    marketplace: s.marketplace,
    externalId: s.externalId,
    url: s.url,
    title: s.title,
    description: s.description ?? null,
    priceCents: s.priceCents,
    originalPriceCents: s.priceCents,
    currency: s.currency,
    imageUrls: s.imageUrls,
    locationText: s.locationText ?? null,
    lat: s.lat ?? null,
    lng: s.lng ?? null,
    postedAt: s.postedAt ?? null,
    sellerName: s.sellerName ?? null,
    condition: s.condition ?? null,
    status: "active",
    raw: s.raw ?? null,
    firstSeenAt: now,
    lastSeenAt: now,
  };
}

/** Mutable fields to write for an existing listing. Optional fields only overwrite when the scrape provides them. */
function updateValues(existing: Listing, s: ScrapedListing, now: Date): Partial<NewListing> {
  const v: Partial<NewListing> = {
    title: s.title,
    url: s.url,
    priceCents: s.priceCents,
    currency: s.currency,
    status: "active",
    lastSeenAt: now,
  };
  if (s.description) v.description = s.description;
  if (s.imageUrls.length > 0) v.imageUrls = s.imageUrls;
  if (s.locationText) v.locationText = s.locationText;
  if (s.lat != null && s.lng != null) {
    v.lat = s.lat;
    v.lng = s.lng;
  }
  if (s.sellerName) v.sellerName = s.sellerName;
  if (s.condition) v.condition = s.condition;
  if (s.postedAt && !existing.postedAt) v.postedAt = s.postedAt;
  if (s.raw != null) v.raw = s.raw;
  if (existing.originalPriceCents == null && s.priceCents != null) v.originalPriceCents = s.priceCents;
  return v;
}

const HOUR_MS = 3_600_000;

/** Facebook's CDN signs image URLs (oh= signature, oe= expiry) and re-signs them on every page load. */
const isSignedUrl = (url: string) => /[?&]oh=/.test(url) && /[?&]oe=/.test(url);

/** The part of an image URL that identifies the image: signed URLs without their query string. */
function imageKey(url: string): string {
  const i = url.indexOf("?");
  return i >= 0 && isSignedUrl(url) ? url.slice(0, i) : url;
}

/** When a signed image URL stops working (`oe`: hex Unix seconds), if it says. */
function signedUrlExpiry(url: string): number | null {
  const match = /[?&]oe=([0-9a-f]{8})(?:&|$)/i.exec(url);
  return match ? Number.parseInt(match[1], 16) * 1_000 : null;
}

/**
 * Whether the scraped images differ from the stored ones. A mere re-signing doesn't count, so Facebook
 * listings don't turn into row-by-row updates on every run; stored signed URLs that expire within a
 * day are refreshed so pictures keep loading.
 */
function imagesChanged(stored: readonly string[], scraped: readonly string[], now: Date): boolean {
  if (scraped.length === 0) return false;
  if (stored.length !== scraped.length || stored.some((url, i) => imageKey(url) !== imageKey(scraped[i]))) return true;
  return stored.some((url, i) => {
    const expiry = signedUrlExpiry(url);
    return url !== scraped[i] && expiry !== null && expiry < now.getTime() + 24 * HOUR_MS;
  });
}

/** Whether the scrape carries anything worth an UPDATE beyond bumping lastSeenAt. */
function hasChanges(e: Listing, s: ScrapedListing, now: Date): boolean {
  return (
    e.status !== "active" ||
    e.title !== s.title ||
    e.url !== s.url ||
    e.priceCents !== s.priceCents ||
    e.currency !== s.currency ||
    (!!s.description && s.description !== e.description) ||
    imagesChanged(e.imageUrls ?? [], s.imageUrls, now) ||
    (!!s.locationText && s.locationText !== e.locationText) ||
    (s.lat != null && s.lng != null && (s.lat !== e.lat || s.lng !== e.lng)) ||
    (!!s.sellerName && s.sellerName !== e.sellerName) ||
    (!!s.condition && s.condition !== e.condition) ||
    (!!s.postedAt && !e.postedAt) ||
    (e.originalPriceCents == null && s.priceCents != null)
  );
}

function historyValues(listing: Listing, observedAt: Date) {
  return { listingId: listing.id, priceCents: listing.priceCents, currency: listing.currency, observedAt };
}

function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 4; e = (e as { cause?: unknown }).cause, depth++) {
    if ((e as { code?: unknown }).code === "23505") return true;
  }
  return false;
}

/** Insert-or-update one listing under a row lock; retries once if a concurrent insert wins the race. */
async function upsertOne(db: Db, s: ScrapedListing, clock: () => Date): Promise<UpsertedListing> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await db.transaction(async (tx) => {
        const now = clock();
        const [row] = await tx
          .select()
          .from(listings)
          .where(and(eq(listings.marketplace, s.marketplace), eq(listings.externalId, s.externalId)))
          .for("update");
        if (!row) {
          const [inserted] = await tx.insert(listings).values(insertValues(s, now)).returning();
          await tx.insert(priceHistory).values(historyValues(inserted, now));
          return { listing: inserted, isNew: true };
        }
        const [updated] = await tx.update(listings).set(updateValues(row, s, now)).where(eq(listings.id, row.id)).returning();
        if (row.priceCents !== s.priceCents || row.currency !== s.currency) {
          await tx.insert(priceHistory).values(historyValues(updated, now));
        }
        return { listing: updated, isNew: false };
      });
    } catch (err) {
      if (attempt >= 2 || !isUniqueViolation(err)) throw err;
    }
  }
}

/**
 * Persist one marketplace's (sanitized, deduplicated) results. Unchanged listings only get lastSeenAt
 * bumped in a single statement; new ones are batch-inserted; changed ones are updated row by row.
 * Returns the stored row for every input, keyed by externalId.
 *
 * `clock` is read right before each write so price_history timestamps follow the real write order
 * (matches.ts compares them with match event times written by concurrent runs).
 */
export async function upsertListings(
  db: Db,
  marketplace: MarketplaceId,
  batch: readonly ScrapedListing[],
  clock: () => Date,
): Promise<Map<string, UpsertedListing>> {
  const result = new Map<string, UpsertedListing>();
  if (batch.length === 0) return result;

  const existingRows = await db
    .select()
    .from(listings)
    .where(and(eq(listings.marketplace, marketplace), inArray(listings.externalId, batch.map((s) => s.externalId))));
  const existing = new Map(existingRows.map((row) => [row.externalId, row]));

  const fresh: ScrapedListing[] = [];
  const changed: ScrapedListing[] = [];
  const unchanged: Listing[] = [];
  const checkedAt = clock();
  for (const s of batch) {
    const row = existing.get(s.externalId);
    if (!row) fresh.push(s);
    else if (hasChanges(row, s, checkedAt)) changed.push(s);
    else unchanged.push(row);
  }

  if (fresh.length > 0) {
    // A stable key order keeps concurrent workers inserting overlapping batches from deadlocking.
    const ordered = [...fresh].sort((a, b) => (a.externalId < b.externalId ? -1 : a.externalId > b.externalId ? 1 : 0));
    const inserted = await db.transaction(async (tx) => {
      const now = clock();
      const rows = await tx
        .insert(listings)
        .values(ordered.map((s) => insertValues(s, now)))
        .onConflictDoNothing({ target: [listings.marketplace, listings.externalId] })
        .returning();
      if (rows.length > 0) await tx.insert(priceHistory).values(rows.map((r) => historyValues(r, now)));
      return rows;
    });
    for (const row of inserted) result.set(row.externalId, { listing: row, isNew: true });
    // Another worker inserted these between our SELECT and INSERT: treat them as updates.
    for (const s of fresh) if (!result.has(s.externalId)) changed.push(s);
  }

  if (unchanged.length > 0) {
    const now = clock();
    // Lock the rows in id order (like the inserts above) so concurrent runs over overlapping results
    // can't deadlock. Rows another run holds right now are skipped: that run is bumping them anyway.
    const ids = unchanged.map((row) => row.id).sort((a, b) => a - b);
    const lockable = db
      .select({ id: listings.id })
      .from(listings)
      .where(inArray(listings.id, ids))
      .orderBy(listings.id)
      .for("update", { skipLocked: true });
    await db.update(listings).set({ lastSeenAt: now }).where(inArray(listings.id, lockable));
    for (const row of unchanged) result.set(row.externalId, { listing: { ...row, lastSeenAt: now }, isNew: false });
  }

  for (const s of changed) result.set(s.externalId, await upsertOne(db, s, clock));
  return result;
}

/** Matched listings not returned for this long (while their marketplace answered) are considered gone. */
export const GONE_AFTER_MS = 3 * 24 * HOUR_MS;

function oldest(dates: ReadonlyArray<Date | null>): Date | null {
  const times = dates.filter((d): d is Date => d !== null).map((d) => d.getTime());
  return times.length > 0 ? new Date(Math.min(...times)) : null;
}

/**
 * After a successful fetch, mark this search's matches on `marketplace` gone (sold or removed) when
 * the marketplace hasn't returned them for GONE_AFTER_MS although it still returns listings that are
 * not newer (posted no later; first seen earlier when the posting date is unknown). Listings older
 * than everything returned may just have dropped out of the newest-first result window, so they are
 * left alone. Seeing a listing again makes it active again (upsertListings). Returns how many changed.
 */
export async function markGoneListings(
  db: Db,
  searchId: number,
  marketplace: MarketplaceId,
  returned: readonly Listing[],
  now: Date,
): Promise<number> {
  const oldestPosted = oldest(returned.map((l) => l.postedAt));
  const oldestFirstSeen = oldest(returned.map((l) => l.firstSeenAt));
  if (!oldestFirstSeen) return 0;
  // A whole first run shares one firstSeenAt, so only a strictly later first sighting says "newer".
  const newerThanReturned = or(
    oldestPosted ? and(isNotNull(listings.postedAt), gte(listings.postedAt, oldestPosted)) : undefined,
    and(isNull(listings.postedAt), gt(listings.firstSeenAt, oldestFirstSeen)),
  );
  const rows = await db
    .update(listings)
    .set({ status: "gone" })
    .where(
      and(
        eq(listings.marketplace, marketplace),
        eq(listings.status, "active"),
        lt(listings.lastSeenAt, new Date(now.getTime() - GONE_AFTER_MS)),
        newerThanReturned,
        inArray(
          listings.id,
          db.select({ id: searchMatches.listingId }).from(searchMatches).where(eq(searchMatches.searchId, searchId)),
        ),
      ),
    )
    .returning({ id: listings.id });
  return rows.length;
}
