/**
 * Request builder for OfferUp's undocumented web GraphQL endpoint (the one offerup.com's search page
 * calls for infinite scroll). Operation and field names are reconstructed from the web client —
 * re-verify against a live request in browser devtools when the fallback starts failing.
 */
import type { SearchQuery } from "../../types";
import { OFFERUP_ORIGIN, offerUpCoordinate, offerUpDistanceMiles, offerUpPriceBounds } from "./url";

export const OFFERUP_GRAPHQL_URL = `${OFFERUP_ORIGIN}/api/graphql`;
const FEED_LIMIT = 50;

/** Only the fields we map; asking for less keeps us resilient to unrelated schema changes. */
export const MODULAR_FEED_QUERY = `query GetModularFeed($searchParams: [SearchParam], $debug: Boolean = false) {
  modularFeed(params: $searchParams, debug: $debug) {
    looseTiles {
      __typename
      ... on ModularFeedTileListing {
        tileId
        listing {
          __typename
          listingId
          title
          price
          locationName
          conditionText
          isFirmPrice
          flags
          image {
            url
            width
            height
          }
        }
      }
    }
    pageCursor
  }
}`;

export interface SearchParam {
  key: string;
  value: string;
}

function feedLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return FEED_LIMIT;
  return Math.min(FEED_LIMIT, Math.max(1, Math.floor(limit)));
}

export function buildModularFeedParams(query: SearchQuery): SearchParam[] {
  const params: SearchParam[] = [
    { key: "q", value: query.keywords.trim() },
    { key: "platform", value: "web" },
    { key: "lat", value: offerUpCoordinate(query.location.lat) },
    { key: "lon", value: offerUpCoordinate(query.location.lng) },
    { key: "limit", value: String(feedLimit(query.limit)) },
    { key: "SORT", value: "-posted" },
    { key: "DISTANCE", value: String(offerUpDistanceMiles(query.location.radiusKm)) },
  ];
  const { min, max } = offerUpPriceBounds(query);
  if (min) params.push({ key: "PRICE_MIN", value: min });
  if (max) params.push({ key: "PRICE_MAX", value: max });
  return params;
}

export function buildModularFeedBody(query: SearchQuery): string {
  return JSON.stringify({
    operationName: "GetModularFeed",
    variables: { debug: false, searchParams: buildModularFeedParams(query) },
    query: MODULAR_FEED_QUERY,
  });
}
