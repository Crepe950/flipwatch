/** Minimal row builders for AI module tests (test-only). */
import type { Db } from "../../db";
import { listings, priceHistory, searchMatches, searches } from "../../db/schema";
import type { Listing, NewListing, NewSearch, Search, SearchMatch } from "../../db/schema";
import { DEFAULT_LOCATION } from "../../locations";

let externalIdCounter = 0;

export async function seedSearch(db: Db, overrides: Partial<NewSearch> = {}): Promise<Search> {
  const [row] = await db
    .insert(searches)
    .values({ name: "PS5", query: "ps5", marketplaces: ["craigslist", "kijiji"], location: DEFAULT_LOCATION, ...overrides })
    .returning();
  return row;
}

export async function seedListing(db: Db, overrides: Partial<NewListing> = {}): Promise<Listing> {
  externalIdCounter++;
  const [row] = await db
    .insert(listings)
    .values({
      marketplace: "craigslist",
      externalId: `ext-${externalIdCounter}`,
      url: `https://vancouver.craigslist.org/vgm/d/${externalIdCounter}.html`,
      title: "PS5 Disc Edition with 2 controllers",
      priceCents: 40000,
      originalPriceCents: 40000,
      currency: "CAD",
      ...overrides,
    })
    .returning();
  return row;
}

export async function seedMatch(db: Db, searchId: number, listingId: number, overrides: Partial<typeof searchMatches.$inferInsert> = {}): Promise<SearchMatch> {
  const [row] = await db.insert(searchMatches).values({ searchId, listingId, ...overrides }).returning();
  return row;
}

export async function seedPrice(db: Db, listingId: number, priceCents: number | null, observedAt: Date): Promise<void> {
  await db.insert(priceHistory).values({ listingId, priceCents, observedAt });
}
