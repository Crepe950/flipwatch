/** Shared fixtures for engine tests: fake adapters, listing/search builders, a no-wait gate. */
import { eq } from "drizzle-orm";
import type { Db } from "@/lib/db";
import {
  aiEvaluations,
  appSettings,
  blockedSellers,
  dealMessages,
  deals,
  listings,
  marketplaceHealth,
  notificationChannels,
  notificationLog,
  priceHistory,
  pushSubscriptions,
  scrapeRuns,
  searches,
  searchMatches,
  type NewSearch,
  type Search,
} from "@/lib/db/schema";
import { DEFAULT_LOCATION } from "@/lib/locations";
import type { AdapterContext, AdapterStatus, MarketplaceAdapter } from "@/lib/marketplaces/types";
import type { MarketplaceId, ScrapedListing, SearchQuery } from "@/lib/types";
import { MarketplaceGate } from "../gate";

export const NOW = new Date("2026-05-01T12:00:00Z");

export const minutesAfter = (date: Date, minutes: number) => new Date(date.getTime() + minutes * 60_000);

export function scraped(marketplace: MarketplaceId, externalId: string, overrides: Partial<ScrapedListing> = {}): ScrapedListing {
  return {
    marketplace,
    externalId,
    url: `https://${marketplace}.example.com/item/${externalId}`,
    title: `PS5 console ${externalId}`,
    priceCents: 40_000,
    currency: "CAD",
    imageUrls: [],
    postedAt: minutesAfter(NOW, -30),
    ...overrides,
  };
}

type Results = ScrapedListing[] | ((query: SearchQuery, ctx: AdapterContext) => ScrapedListing[] | Promise<ScrapedListing[]>);

export interface FakeAdapter extends MarketplaceAdapter {
  calls: SearchQuery[];
  setResults(results: Results): void;
  setStatus(status: AdapterStatus): void;
}

export function fakeAdapter(
  id: MarketplaceId,
  opts: { results?: Results; countries?: string[]; minIntervalSec?: number; status?: AdapterStatus } = {},
): FakeAdapter {
  let results: Results = opts.results ?? [];
  let status: AdapterStatus = opts.status ?? { ok: true };
  const calls: SearchQuery[] = [];
  return {
    id,
    displayName: `Fake ${id}`,
    countries: opts.countries ?? ["CA", "US"],
    minIntervalSec: opts.minIntervalSec ?? 0,
    status: () => status,
    buildSearchUrl: (q) => `https://${id}.example.com/search?q=${encodeURIComponent(q.keywords)}`,
    async search(query, ctx) {
      calls.push(query);
      return typeof results === "function" ? results(query, ctx) : results;
    },
    calls,
    setResults(next) {
      results = next;
    },
    setStatus(next) {
      status = next;
    },
  };
}

/** Empty every table (children first) so one migrated database can be reused across tests. */
export async function resetDb(db: Db): Promise<void> {
  for (const table of [
    blockedSellers,
    notificationLog,
    aiEvaluations,
    dealMessages,
    deals,
    searchMatches,
    priceHistory,
    scrapeRuns,
    listings,
    searches,
    marketplaceHealth,
    appSettings,
    notificationChannels,
    pushSubscriptions,
  ]) {
    await db.delete(table);
  }
}

/** Expect `actual` to be within `toleranceMs` after `expected` (runs add real elapsed time to injected clocks). */
export function isNear(actual: Date | null | undefined, expected: Date, toleranceMs = 5_000): boolean {
  if (!actual) return false;
  const delta = actual.getTime() - expected.getTime();
  return delta >= 0 && delta <= toleranceMs;
}

/** A gate that never waits, so tests don't sleep 3 s between requests. */
export const noWaitGate = () => new MarketplaceGate({ minSpacingMs: 0, jitterMs: 0 });

export async function insertSearch(db: Db, overrides: Partial<NewSearch> = {}): Promise<Search> {
  const [row] = await db
    .insert(searches)
    .values({ name: "PS5", query: "ps5", marketplaces: ["craigslist"], location: DEFAULT_LOCATION, ...overrides })
    .returning();
  return row;
}

export async function getSearch(db: Db, id: number): Promise<Search> {
  const [row] = await db.select().from(searches).where(eq(searches.id, id));
  return row;
}

export async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
}
