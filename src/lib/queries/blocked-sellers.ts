import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db";
import { blockedSellers, listings, searchMatches, type BlockedSeller } from "../db/schema";
import type { MarketplaceId } from "../types";

/** How seller names are compared: case- and whitespace-insensitive. */
export function sellerKey(name: string): string {
  return name.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

/** Lookup key for a (marketplace, seller) pair. */
function setKey(marketplace: string, key: string): string {
  return `${marketplace}|${key}`;
}

/** Everything blocked, as a set to test listings against with `isBlockedSeller`. */
export async function loadBlockedSellers(db: Db): Promise<Set<string>> {
  const rows = await db.select({ marketplace: blockedSellers.marketplace, sellerKey: blockedSellers.sellerKey }).from(blockedSellers);
  return new Set(rows.map((r) => setKey(r.marketplace, r.sellerKey)));
}

export function isBlockedSeller(blocked: ReadonlySet<string>, listing: { marketplace: string; sellerName?: string | null }): boolean {
  if (blocked.size === 0 || !listing.sellerName?.trim()) return false;
  return blocked.has(setKey(listing.marketplace, sellerKey(listing.sellerName)));
}

export async function listBlockedSellers(db: Db): Promise<BlockedSeller[]> {
  return db.select().from(blockedSellers).orderBy(asc(blockedSellers.marketplace), asc(blockedSellers.sellerName));
}

/**
 * Block a seller on one marketplace and dismiss the matches of their listings already in the feed.
 * Returns how many matches were dismissed. Blocking twice is harmless.
 */
export async function blockSeller(db: Db, marketplace: MarketplaceId, sellerName: string): Promise<{ dismissed: number }> {
  const name = sellerName.trim().slice(0, 120);
  const key = sellerKey(name);
  if (!key) throw new Error("This listing has no seller name to block");
  await db.insert(blockedSellers).values({ marketplace, sellerKey: key, sellerName: name }).onConflictDoNothing();
  const theirs = await db
    .select({ id: listings.id })
    .from(listings)
    .where(and(eq(listings.marketplace, marketplace), sql`lower(regexp_replace(trim(${listings.sellerName}), '\\s+', ' ', 'g')) = ${key}`));
  if (theirs.length === 0) return { dismissed: 0 };
  const rows = await db
    .update(searchMatches)
    .set({ dismissed: true })
    .where(and(inArray(searchMatches.listingId, theirs.map((l) => l.id)), eq(searchMatches.dismissed, false)))
    .returning({ id: searchMatches.id });
  return { dismissed: rows.length };
}

export async function unblockSeller(db: Db, id: number): Promise<boolean> {
  const rows = await db.delete(blockedSellers).where(eq(blockedSellers.id, id)).returning({ id: blockedSellers.id });
  return rows.length > 0;
}
