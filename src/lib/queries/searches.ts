import { and, count, desc, eq, gte, sql } from "drizzle-orm";
import type { Db } from "../db";
import { searchMatches, searches, type NewSearch, type Search } from "../db/schema";
import type { SearchInput } from "../search-schema";
import type { SearchLocation } from "../types";

export interface SearchWithStats extends Search {
  /** Non-silent matches first seen in the last 24 hours. */
  recentMatches: number;
  totalMatches: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const NAME_MAX = 80;

function blankToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeLocation(location: SearchLocation): SearchLocation {
  return {
    label: location.label.trim(),
    lat: location.lat,
    lng: location.lng,
    radiusKm: location.radiusKm,
    countryCode: location.countryCode.trim().toUpperCase(),
    postalCode: blankToNull(location.postalCode),
    craigslistSite: blankToNull(location.craigslistSite)?.toLowerCase() ?? null,
    facebookLocation: blankToNull(location.facebookLocation),
    kijijiLocationId: blankToNull(location.kijijiLocationId),
    kijijiLocationSlug: blankToNull(location.kijijiLocationSlug),
  };
}

function uniqueCaseInsensitive(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const value = raw.trim();
    const key = value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

/** Map validated input to column values. `category: "any"` is stored as null (no category filter). */
export function searchInputToColumns(input: SearchInput) {
  return {
    name: input.name,
    query: input.query,
    excludeTerms: uniqueCaseInsensitive(input.excludeTerms),
    titleMustMatch: input.titleMustMatch,
    minPriceCents: input.minPriceCents ?? null,
    maxPriceCents: input.maxPriceCents ?? null,
    expectedResaleCents: input.expectedResaleCents ?? null,
    marketplaces: [...new Set(input.marketplaces)],
    location: normalizeLocation(input.location),
    category: input.category && input.category !== "any" ? input.category : null,
    pollIntervalSec: input.pollIntervalSec,
    maxListingAgeHours: input.maxListingAgeHours,
    notifyChannelIds: input.notifyChannelIds?.length ? [...new Set(input.notifyChannelIds)] : null,
    notifyMinDealScore: input.notifyMinDealScore ?? null,
    notifyMinAiScore: input.notifyMinAiScore ?? null,
    notifyMinProfitPct: input.notifyMinProfitPct ?? null,
    aiInstructions: input.aiInstructions?.trim() || null,
    notifyPriceDrops: input.notifyPriceDrops,
    // An AI score threshold needs AI evaluations to compare against.
    aiEvaluate: input.aiEvaluate || input.notifyMinAiScore != null,
    enabled: input.enabled,
  } satisfies Omit<NewSearch, "id" | "createdAt" | "updatedAt">;
}

/** Every saved search (newest first) with match counts. */
export async function listSearchesWithStats(db: Db, now: Date = new Date()): Promise<SearchWithStats[]> {
  const since = new Date(now.getTime() - DAY_MS);
  const [rows, stats] = await Promise.all([
    db.select().from(searches).orderBy(desc(searches.createdAt), desc(searches.id)),
    db
      .select({
        searchId: searchMatches.searchId,
        total: count(),
        recent: sql<number>`count(*) filter (where ${and(gte(searchMatches.firstMatchedAt, since), eq(searchMatches.silent, false))})`.mapWith(
          Number,
        ),
      })
      .from(searchMatches)
      .groupBy(searchMatches.searchId),
  ]);
  const bySearch = new Map(stats.map((s) => [s.searchId, s]));
  return rows.map((row) => ({
    ...row,
    recentMatches: bySearch.get(row.id)?.recent ?? 0,
    totalMatches: bySearch.get(row.id)?.total ?? 0,
  }));
}

/** A route/query param → positive integer id (fits Postgres `serial`), or null. */
export function parseSearchId(raw: string | null | undefined): number | null {
  if (!raw || !/^\d{1,9}$/.test(raw)) return null;
  const id = Number(raw);
  return id > 0 ? id : null;
}

export async function getSearch(db: Db, id: number): Promise<Search | null> {
  const [row] = await db.select().from(searches).where(eq(searches.id, id)).limit(1);
  return row ?? null;
}

export async function createSearch(db: Db, input: SearchInput): Promise<Search> {
  const [row] = await db.insert(searches).values(searchInputToColumns(input)).returning();
  return row;
}

type DefinitionColumns = Pick<
  Search,
  "query" | "excludeTerms" | "titleMustMatch" | "minPriceCents" | "maxPriceCents" | "location" | "category"
>;

const LOCATION_KEYS = [
  "lat",
  "lng",
  "radiusKm",
  "countryCode",
  "postalCode",
  "craigslistSite",
  "facebookLocation",
  "kijijiLocationId",
  "kijijiLocationSlug",
] as const satisfies ReadonlyArray<keyof SearchLocation>;

const normalizedQuery = (query: string) => query.trim().replace(/\s+/g, " ").toLowerCase();
const termSet = (terms: readonly string[] | null) => [...new Set((terms ?? []).map((t) => t.trim().toLowerCase()))].sort().join("\n");

/**
 * Whether the edit changes which listings match: query, exclude terms, title matching, price range,
 * location (not its label) or category. Marketplaces aren't compared: one that is new to the search
 * gets its own silent first run anyway.
 */
function definitionChanged(before: DefinitionColumns, after: DefinitionColumns): boolean {
  return (
    normalizedQuery(before.query) !== normalizedQuery(after.query) ||
    termSet(before.excludeTerms) !== termSet(after.excludeTerms) ||
    before.titleMustMatch !== after.titleMustMatch ||
    (before.minPriceCents ?? null) !== (after.minPriceCents ?? null) ||
    (before.maxPriceCents ?? null) !== (after.maxPriceCents ?? null) ||
    (before.category ?? null) !== (after.category ?? null) ||
    LOCATION_KEYS.some((key) => (before.location?.[key] ?? null) !== (after.location?.[key] ?? null))
  );
}

/**
 * Replace a search's definition. Clears nextRunAt so the scheduler picks it up on its next tick. When
 * the edit changes which listings match, definitionChangedAt restarts first-run silence: the next run
 * records what the new definition finds without alerting, instead of alerting on all of it.
 */
export async function updateSearch(db: Db, id: number, input: SearchInput, now: Date = new Date()): Promise<Search | null> {
  const current = await getSearch(db, id);
  if (!current) return null;
  const columns = searchInputToColumns(input);
  const [row] = await db
    .update(searches)
    .set({
      ...columns,
      updatedAt: now,
      nextRunAt: null,
      ...(definitionChanged(current, columns) ? { definitionChangedAt: now } : {}),
    })
    .where(eq(searches.id, id))
    .returning();
  return row ?? null;
}

export async function setSearchEnabled(db: Db, id: number, enabled: boolean, now: Date = new Date()): Promise<boolean> {
  const rows = await db
    .update(searches)
    // Re-enabling should run soon rather than wait out a stale schedule.
    .set(enabled ? { enabled, updatedAt: now, nextRunAt: null } : { enabled, updatedAt: now })
    .where(eq(searches.id, id))
    .returning({ id: searches.id });
  return rows.length > 0;
}

function copyName(name: string): string {
  const suffix = " (copy)";
  return `${name.slice(0, NAME_MAX - suffix.length).trimEnd()}${suffix}`;
}

/** Copy a search's definition (not its run state or matches). The copy starts paused. */
export async function duplicateSearch(db: Db, id: number): Promise<Search | null> {
  const source = await getSearch(db, id);
  if (!source) return null;
  const [row] = await db
    .insert(searches)
    .values({
      name: copyName(source.name),
      query: source.query,
      excludeTerms: source.excludeTerms,
      titleMustMatch: source.titleMustMatch,
      minPriceCents: source.minPriceCents,
      maxPriceCents: source.maxPriceCents,
      expectedResaleCents: source.expectedResaleCents,
      marketplaces: source.marketplaces,
      location: source.location,
      category: source.category,
      pollIntervalSec: source.pollIntervalSec,
      maxListingAgeHours: source.maxListingAgeHours,
      notifyChannelIds: source.notifyChannelIds,
      notifyMinDealScore: source.notifyMinDealScore,
      notifyMinAiScore: source.notifyMinAiScore,
      notifyMinProfitPct: source.notifyMinProfitPct,
      aiInstructions: source.aiInstructions,
      notifyPriceDrops: source.notifyPriceDrops,
      aiEvaluate: source.aiEvaluate,
      enabled: false,
    })
    .returning();
  return row;
}

/** Delete a search; its matches and scrape runs cascade. */
export async function deleteSearch(db: Db, id: number): Promise<boolean> {
  const rows = await db.delete(searches).where(eq(searches.id, id)).returning({ id: searches.id });
  return rows.length > 0;
}
