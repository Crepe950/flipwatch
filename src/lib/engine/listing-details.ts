/**
 * Fill in a listing's full description from its own page. Search results carry little more than the
 * title (Facebook's carry no description at all), so "i7 / 16GB / GTX gaming PC" would otherwise be
 * valued as a much newer machine than the i7-2600 + GTX 555 its description lists.
 */
import { eq } from "drizzle-orm";
import type { Db } from "../db";
import { listings, type Listing } from "../db/schema";
import { createAdapterContext, getAdapter } from "../marketplaces/registry";
import { RateLimitedError, type AdapterContext } from "../marketplaces/types";
import { errorMessage, log } from "./log";

/** A listing's page is read at most once in this window (per process). */
const REFETCH_AFTER_MS = 6 * 3_600_000;

const state = globalThis as unknown as {
  __flipwatchDescriptionFetchedAt?: Map<number, number>;
  __flipwatchDescriptionInFlight?: Map<number, Promise<Listing>>;
};
const fetchedAt = () => (state.__flipwatchDescriptionFetchedAt ??= new Map<number, number>());
/** Reads still running, so a second look (e.g. the page refreshing) waits for the same one. */
const inFlight = () => (state.__flipwatchDescriptionInFlight ??= new Map<number, Promise<Listing>>());

/** Test hook. */
export function resetListingDetailsCache(): void {
  fetchedAt().clear();
  inFlight().clear();
}

export interface FullDescriptionOptions {
  /** Defaults to the live network context; tests pass a fake one (without it, nothing is fetched in tests). */
  ctx?: AdapterContext;
  /** Someone is waiting on it (opening the listing, a price check): may use the reserve of the Facebook budget. */
  interactive?: boolean;
  now?: number;
}

/**
 * The listing with its description read from the listing page when that gives more than we stored.
 * Never throws: a failed or unsupported fetch leaves the listing as it was.
 */
export async function withFullDescription(db: Db, listing: Listing, opts: FullDescriptionOptions = {}): Promise<Listing> {
  if (!opts.ctx && process.env.NODE_ENV === "test") return listing;
  const adapter = getAdapter(listing.marketplace);
  if (!adapter?.fetchDescription || !listing.url) return listing;
  const running = inFlight().get(listing.id);
  if (running) return running;
  const now = opts.now ?? Date.now();
  const last = fetchedAt().get(listing.id);
  if (last !== undefined && now - last < REFETCH_AFTER_MS) return listing;
  fetchedAt().set(listing.id, now);
  const read = readDescription(db, listing, adapter.fetchDescription.bind(adapter), opts).finally(() => inFlight().delete(listing.id));
  inFlight().set(listing.id, read);
  return read;
}

async function readDescription(
  db: Db,
  listing: Listing,
  fetchDescription: NonNullable<ReturnType<typeof getAdapter>["fetchDescription"]>,
  opts: FullDescriptionOptions,
): Promise<Listing> {
  let description: string | null;
  try {
    description = await fetchDescription(listing.url, opts.ctx ?? createAdapterContext(), { interactive: opts.interactive ?? false });
  } catch (err) {
    // Out of Facebook budget: try again on a later look rather than waiting out the refetch window.
    if (err instanceof RateLimitedError) fetchedAt().delete(listing.id);
    else log.warn(`Couldn't read the description of listing ${listing.id} (${listing.marketplace}): ${errorMessage(err)}`);
    return listing;
  }
  if (!description || description.length <= (listing.description ?? "").trim().length) return listing;
  await db.update(listings).set({ description }).where(eq(listings.id, listing.id));
  return { ...listing, description };
}
