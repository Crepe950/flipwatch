import { vi } from "vitest";
import type { Db } from "../../db";
import { listings, notificationChannels, searchMatches, searches, type NotificationChannel } from "../../db/schema";
import type { MatchEvent } from "../../events";
import { DEFAULT_LOCATION } from "../../locations";
import type { NotificationChannelType } from "../../types";
import type { Alert, SendContext } from "../types";

export const HOSTILE_TITLE = "<b>x</b> & *y* @everyone";
export const APP_URL = "https://flipwatch.example.com";
export const NOW = new Date("2026-09-28T12:00:00Z");

/** A fully populated single-listing alert; override anything. */
export function makeAlert(overrides: Partial<Alert> = {}): Alert {
  return {
    kind: "new",
    test: false,
    title: `$120 · ${HOSTILE_TITLE}`,
    context: "Craigslist · Vancouver, BC · posted 5m ago",
    fields: [
      { label: "Deal score", value: "86/100 · 32% below median of 14 comps" },
      { label: "Est. profit", value: "+$95" },
      { label: "Search", value: "PS5" },
    ],
    lines: [
      "Craigslist · Vancouver, BC · posted 5m ago",
      "Deal score: 86/100 · 32% below median of 14 comps",
      "Est. profit: +$95",
      "Search: PS5",
    ],
    items: [],
    url: "https://vancouver.craigslist.org/van/vgm/d/ps5/7712345678.html",
    appUrl: `${APP_URL}/listings/42`,
    appPath: "/listings/42",
    imageUrl: "https://images.craigslist.org/00a0a_abc_600x450.jpg",
    dealScore: 86,
    tag: "match-7",
    timestamp: NOW,
    search: { id: 3, name: "PS5" },
    matchIds: [7],
    listing: null,
    match: null,
    ai: null,
    ...overrides,
  };
}

export function makeDigestAlert(count = 7): Alert {
  const items = Array.from({ length: count }, (_, i) => ({
    matchId: 100 + i,
    listingId: 200 + i,
    title: `$${100 + i} · PS5 #${i} ${HOSTILE_TITLE}`,
    url: `https://vancouver.craigslist.org/van/vgm/d/ps5/${i}.html`,
    appUrl: `${APP_URL}/listings/${200 + i}`,
  }));
  return makeAlert({
    kind: "digest",
    title: `+${count} more matches for PS5`,
    context: null,
    fields: [],
    lines: items.map((i) => i.title),
    items,
    url: `${APP_URL}/?search=3`,
    appUrl: `${APP_URL}/?search=3`,
    appPath: "/?search=3",
    imageUrl: null,
    tag: "digest-3",
    matchIds: items.map((i) => i.matchId),
  });
}

export function makeCtx(overrides: Partial<SendContext> = {}): SendContext {
  return {
    db: {} as Db,
    signal: new AbortController().signal,
    deadline: Date.now() + 10_000,
    sleep: async () => {},
    ...overrides,
  };
}

export interface FetchCall {
  url: string;
  init: RequestInit;
  /** Body parsed as JSON (or form fields for URLSearchParams bodies). */
  json: Record<string, unknown>;
}

/** Replace global fetch with a responder; returns the recorded calls. */
export function stubFetch(respond: (url: string, init: RequestInit, n: number) => Response | Promise<Response> = () => new Response(null, { status: 204 })) {
  const calls: FetchCall[] = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = init.body;
    const json =
      body instanceof URLSearchParams ? Object.fromEntries(body) : typeof body === "string" && body.startsWith("{") ? JSON.parse(body) : {};
    calls.push({ url, init, json });
    return respond(url, init, calls.length);
  });
  return { calls, spy };
}

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

// ---- Database seeding ---------------------------------------------------------------------------

let seq = 0;

export async function seedSearch(db: Db, overrides: Partial<typeof searches.$inferInsert> = {}) {
  const [row] = await db
    .insert(searches)
    .values({ name: "PS5", query: "ps5", marketplaces: ["craigslist"], location: DEFAULT_LOCATION, ...overrides })
    .returning();
  return row;
}

export async function seedListing(db: Db, overrides: Partial<typeof listings.$inferInsert> = {}) {
  seq += 1;
  const [row] = await db
    .insert(listings)
    .values({
      marketplace: "craigslist",
      externalId: `ext-${seq}`,
      url: `https://vancouver.craigslist.org/van/vgm/d/ps5/${seq}.html`,
      title: `PS5 Digital Edition #${seq}`,
      priceCents: 12_000,
      originalPriceCents: 12_000,
      currency: "USD",
      imageUrls: [`https://images.craigslist.org/${seq}_600x450.jpg`],
      locationText: "Vancouver, BC",
      postedAt: new Date(NOW.getTime() - 5 * 60_000),
      ...overrides,
    })
    .returning();
  return row;
}

export async function seedMatch(db: Db, searchId: number, listingId: number, overrides: Partial<typeof searchMatches.$inferInsert> = {}) {
  const [row] = await db
    .insert(searchMatches)
    .values({
      searchId,
      listingId,
      dealScore: 70,
      dealScoreReason: "20% below median",
      estimatedProfitCents: 5_000,
      firstMatchedAt: NOW,
      lastEventAt: NOW,
      ...overrides,
    })
    .returning();
  return row;
}

export async function seedChannel(
  db: Db,
  type: NotificationChannelType,
  config: Record<string, string>,
  overrides: Partial<typeof notificationChannels.$inferInsert> = {},
): Promise<NotificationChannel> {
  const [row] = await db.insert(notificationChannels).values({ name: `${type} channel`, type, config, ...overrides }).returning();
  return row;
}

/** Search + N listings + matches, and the matching "new" events. */
export async function seedMatches(db: Db, count: number, searchOverrides: Partial<typeof searches.$inferInsert> = {}) {
  const search = await seedSearch(db, searchOverrides);
  const events: MatchEvent[] = [];
  const matches = [];
  for (let i = 0; i < count; i++) {
    const listing = await seedListing(db);
    const match = await seedMatch(db, search.id, listing.id);
    matches.push(match);
    events.push({ type: "new", matchId: match.id, searchId: search.id, listingId: listing.id, silent: false });
  }
  return { search, matches, events };
}
