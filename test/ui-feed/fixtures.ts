import type { Db } from "@/lib/db";
import { listings, priceHistory, searches, searchMatches, type NewListing } from "@/lib/db/schema";
import { DEFAULT_LOCATION } from "@/lib/locations";
import type { MarketplaceId, MatchEventType } from "@/lib/types";

let externalSeq = 0;

export async function insertSearch(db: Db, name = "PS5") {
  const [s] = await db
    .insert(searches)
    .values({ name, query: name.toLowerCase(), marketplaces: ["craigslist", "kijiji"], location: DEFAULT_LOCATION })
    .returning();
  return s;
}

export async function insertListing(db: Db, overrides: Partial<NewListing> = {}) {
  externalSeq++;
  const [l] = await db
    .insert(listings)
    .values({
      marketplace: "craigslist" as MarketplaceId,
      externalId: `ext-${externalSeq}`,
      url: `https://vancouver.craigslist.org/item/${externalSeq}`,
      title: `Listing ${externalSeq}`,
      priceCents: 30000,
      originalPriceCents: 30000,
      currency: "CAD",
      ...overrides,
    })
    .returning();
  await db.insert(priceHistory).values({ listingId: l.id, priceCents: l.priceCents, observedAt: l.firstSeenAt });
  return l;
}

export async function insertMatch(
  db: Db,
  searchId: number,
  listingId: number,
  overrides: Partial<{
    lastEventAt: Date;
    lastEvent: MatchEventType;
    dealScore: number | null;
    silent: boolean;
    seen: boolean;
    dismissed: boolean;
  }> = {},
) {
  const [m] = await db
    .insert(searchMatches)
    .values({ searchId, listingId, firstMatchedAt: overrides.lastEventAt, ...overrides })
    .returning();
  return m;
}
