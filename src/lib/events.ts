import type { MatchEventType } from "./types";

/** Emitted by the engine when a listing newly matches a search or drops in price. Consumed by notify + ai. */
export interface MatchEvent {
  type: MatchEventType;
  matchId: number;
  searchId: number;
  listingId: number;
  /** For price drops: the price before the drop. */
  previousPriceCents?: number | null;
  /** Silent events are recorded but must not trigger notifications (e.g. stale listings on a first run). */
  silent: boolean;
}
