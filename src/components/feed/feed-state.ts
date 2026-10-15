/**
 * Client-side state of the live feed: the visible cards plus "pending" cards that arrived via
 * polling and wait behind the "N new deals" pill. Pure reducer so the merge rules are testable.
 */
import type { FeedApiResponse, FeedItem } from "@/lib/queries/feed";

export interface FeedState {
  items: FeedItem[];
  pending: FeedItem[];
}

export type FeedAction =
  /** Poll results (newest first). `reveal` shows them immediately instead of queueing. */
  | { type: "received"; fresh: FeedItem[]; reveal: boolean }
  | { type: "reveal" }
  /** Next page from "Load more". */
  | { type: "appended"; items: FeedItem[] }
  | { type: "patched"; matchIds: number[]; patch: Partial<FeedItem> }
  /** Deal fields belong to the listing, which can appear once per matching search. */
  | { type: "patchedListing"; listingId: number; patch: Pick<FeedItem, "dealId" | "dealStage"> }
  | { type: "removed"; matchId: number }
  | { type: "restored"; item: FeedItem; index: number };

/** A match can resurface with a newer event (price drop), so identity includes the event time. */
export function eventKey(item: Pick<FeedItem, "matchId" | "lastEventAt">): string {
  return `${item.matchId}@${item.lastEventAt}`;
}

/**
 * How far before the newest known event to poll from. The engine stamps lastEventAt when a run
 * starts but commits later, so an event can become visible with a timestamp older than one we
 * already have; re-reading a window and de-duplicating by eventKey catches those.
 */
export const POLL_OVERLAP_MS = 5 * 60 * 1000;

/** Newest lastEventAt (epoch ms) across the lists, or `fallback` when they are all empty. */
export function newestEventMs(lists: FeedItem[][], fallback: number): number {
  let newest = Number.NEGATIVE_INFINITY;
  for (const list of lists) {
    for (const item of list) {
      const t = Date.parse(item.lastEventAt);
      if (t > newest) newest = t;
    }
  }
  return Number.isFinite(newest) ? newest : fallback;
}

/** The `since` parameter for the next poll. */
export function pollSince(state: FeedState, generatedAtMs: number): string {
  return new Date(newestEventMs([state.items, state.pending], generatedAtMs) - POLL_OVERLAP_MS).toISOString();
}

/** Items per poll request; a bigger burst is read page by page. */
export const POLL_PAGE_SIZE = 100;
/** Pages read per poll before giving up and asking for a refresh instead. */
export const MAX_POLL_PAGES = 5;

export interface PollResult {
  items: FeedItem[];
  unseenCount: number;
  /** More events than MAX_POLL_PAGES pages: some were not read. */
  truncated: boolean;
}

/**
 * Read every event since the poll's `since` time, following the API's cursor so a burst of more
 * than one page (a new search's first run, a busy marketplace) isn't cut off at the page size.
 */
export async function readNewEvents(
  fetchPage: (cursor: string | null) => Promise<FeedApiResponse>,
  maxPages = MAX_POLL_PAGES,
): Promise<PollResult> {
  const items: FeedItem[] = [];
  let unseenCount = 0;
  let cursor: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const data = await fetchPage(cursor);
    items.push(...data.items);
    if (page === 0) unseenCount = data.unseenCount;
    cursor = data.nextCursor;
    if (!cursor) return { items, unseenCount, truncated: false };
  }
  return { items, unseenCount, truncated: true };
}

/** Text of the "N new deals" pill: only alert-worthy matches count as deals; silent ones are "quiet". */
export function pendingLabel(pending: FeedItem[]): string {
  const alerts = pending.filter((i) => !i.silent).length;
  if (alerts > 0) return `${alerts} new ${alerts === 1 ? "deal" : "deals"}`;
  return `${pending.length} quiet ${pending.length === 1 ? "match" : "matches"}`;
}

/** Live-update health shown above the feed. */
export interface Connection {
  status: "online" | "offline" | "expired";
  /** Consecutive failed polls. */
  failures: number;
}

export const ONLINE: Connection = { status: "online", failures: 0 };
/** Failed polls in a row before the feed says it is offline (one blip is not worth a banner). */
export const OFFLINE_AFTER_FAILURES = 3;

/**
 * `unauthorized`: the API answered 401 (session expired); `failed`: network error or server error;
 * `offline`: the browser says it lost its connection. A signed-out feed stays signed out until a
 * request succeeds again (e.g. after signing in in another tab).
 */
export function nextConnection(prev: Connection, outcome: "ok" | "unauthorized" | "failed" | "offline"): Connection {
  switch (outcome) {
    case "ok":
      return prev.status === "online" && prev.failures === 0 ? prev : ONLINE;
    case "unauthorized":
      return { status: "expired", failures: 0 };
    case "offline":
      return { status: prev.status === "expired" ? "expired" : "offline", failures: Math.max(prev.failures, OFFLINE_AFTER_FAILURES) };
    case "failed": {
      const failures = prev.failures + 1;
      const status = prev.status === "expired" ? "expired" : failures >= OFFLINE_AFTER_FAILURES ? "offline" : prev.status;
      return { status, failures };
    }
  }
}

/** Items from `incoming` whose event is not already visible or queued. */
export function unknownEvents(state: FeedState, incoming: FeedItem[]): FeedItem[] {
  const known = new Set([...state.items, ...state.pending].map(eventKey));
  return incoming.filter((i) => !known.has(eventKey(i)));
}

function reveal(state: FeedState): FeedState {
  if (state.pending.length === 0) return state;
  const ids = new Set(state.pending.map((i) => i.matchId));
  return { items: [...state.pending, ...state.items.filter((i) => !ids.has(i.matchId))], pending: [] };
}

function patchWhere(list: FeedItem[], match: (i: FeedItem) => boolean, patch: Partial<FeedItem>): FeedItem[] {
  let changed = false;
  const next = list.map((i) => {
    if (!match(i)) return i;
    changed = true;
    return { ...i, ...patch };
  });
  return changed ? next : list;
}

export function feedReducer(state: FeedState, action: FeedAction): FeedState {
  switch (action.type) {
    case "received": {
      const incoming = unknownEvents(state, action.fresh);
      if (incoming.length === 0) return state;
      const ids = new Set(incoming.map((i) => i.matchId));
      // A newer event for a queued match replaces the queued copy.
      const next = { items: state.items, pending: [...incoming, ...state.pending.filter((i) => !ids.has(i.matchId))] };
      return action.reveal ? reveal(next) : next;
    }
    case "reveal":
      return reveal(state);
    case "appended": {
      const ids = new Set([...state.items, ...state.pending].map((i) => i.matchId));
      const older = action.items.filter((i) => !ids.has(i.matchId));
      return older.length ? { ...state, items: [...state.items, ...older] } : state;
    }
    case "patched": {
      const ids = new Set(action.matchIds);
      const match = (i: FeedItem) => ids.has(i.matchId);
      return { items: patchWhere(state.items, match, action.patch), pending: patchWhere(state.pending, match, action.patch) };
    }
    case "patchedListing": {
      const match = (i: FeedItem) => i.listingId === action.listingId;
      return { items: patchWhere(state.items, match, action.patch), pending: patchWhere(state.pending, match, action.patch) };
    }
    case "removed":
      return {
        items: state.items.filter((i) => i.matchId !== action.matchId),
        pending: state.pending.filter((i) => i.matchId !== action.matchId),
      };
    case "restored": {
      if (state.items.some((i) => i.matchId === action.item.matchId)) return state;
      const items = [...state.items];
      items.splice(Math.max(0, Math.min(action.index, items.length)), 0, action.item);
      return { ...state, items };
    }
  }
}
