/**
 * Marketplace search through Facebook's own web GraphQL endpoint — the request the Marketplace page makes
 * when you change the radius or scroll. Unlike the server-rendered page (first ~24 results, always the
 * radius saved on the account), it takes the location, radius, sort and price range per request and pages
 * with a cursor.
 *
 * Everything comes from a normal logged-in search page: the session's request tokens (fb_dtsg, lsd), the
 * search query's persisted doc id and its current variables (used as a template, so fields Facebook adds
 * keep being sent), and — from the page's public JS bundles — the doc id of the "load more" query. Doc ids
 * change when Facebook ships; callers fall back to the server-rendered page whenever this path fails.
 * Reverse-engineered, undocumented, and against Meta's terms like the rest of this adapter.
 */
import type { SearchQuery } from "../../types";
import { sliceBalancedJson } from "./embedded-json";

export const CONTAINER_QUERY = "CometMarketplaceSearchContentContainerQuery";
export const PAGINATION_QUERY = "CometMarketplaceSearchContentPaginationQuery";
export const GRAPHQL_URL = "https://www.facebook.com/api/graphql/";
/** Results per request (what the web client asks for). */
export const PAGE_SIZE = 24;
/** Facebook's own "no upper bound" price, in cents. */
const NO_MAX_PRICE_CENTS = 214_748_364_700;

type Json = Record<string, unknown>;

export interface GraphqlSession {
  fbDtsg: string;
  lsd: string;
  userId: string;
  containerDocId: string;
  /** The page's own variables for the search query: a template for ours. */
  variables: Json;
}

function asObject(value: unknown): Json | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined;
}

/** The request tokens, user id and search query (doc id + variables) embedded in a logged-in search page. */
export function extractGraphqlSession(html: string, cookies: string): GraphqlSession | null {
  const fbDtsg = html.match(/"DTSGInitialData",\[\],\{"token":"([^"]+)"/)?.[1];
  const lsd = html.match(/"LSD",\[\],\{"token":"([^"]+)"/)?.[1];
  const userId = cookies.match(/(?:^|;\s*)c_user=(\d+)/)?.[1];
  if (!fbDtsg || !lsd || !userId) return null;

  // Preloaded queries look like {"queryID":"123…","variables":{…},…}; the search one has browse_request_params.
  const marker = /"queryID":"(\d{8,25})","variables":/g;
  let match: RegExpExecArray | null;
  while ((match = marker.exec(html))) {
    const json = sliceBalancedJson(html, match.index + match[0].length);
    if (!json) continue;
    let variables: Json;
    try {
      variables = JSON.parse(json) as Json;
    } catch {
      continue;
    }
    const params = asObject(variables.params);
    if (asObject(params?.browse_request_params) && asObject(params?.bqf)) {
      return { fbDtsg, lsd, userId, containerDocId: match[1], variables };
    }
  }
  return null;
}

/** Public JS bundle URLs referenced by a page (static CDN; fetched without cookies). */
export function bundleUrls(html: string): string[] {
  return [...new Set([...html.matchAll(/https:\\?\/\\?\/static\.xx\.fbcdn\.net\\?\/rsrc\.php\\?\/[^"\s]+?\.js[^"\s\\]*/g)].map((m) => m[0].replace(/\\\//g, "/")))];
}

/** A Relay operation's persisted doc id, from the module that exports it: __d("X_facebookRelayOperation",[],(function(…){e.exports="123"}) */
export function findOperationDocId(js: string, operation: string): string | null {
  const escaped = operation.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return js.match(new RegExp(`__d\\("${escaped}_facebookRelayOperation",\\[\\],\\(function\\([^)]*\\)\\{[^}]*?exports="(\\d+)"`))?.[1] ?? null;
}

/** The session's search variables, re-aimed at our query: location, radius, sort, price range, cursor. */
export function buildSearchVariables(template: Json, query: SearchQuery, cursor: string | null): Json {
  const vars = structuredClone(template);
  const params = asObject(vars.params) ?? {};
  const bqf = asObject(params.bqf) ?? {};
  const browse = asObject(params.browse_request_params) ?? {};
  const { lat, lng, radiusKm } = query.location;
  const keywords = query.keywords.trim();

  bqf.query = keywords;
  browse.filter_location_latitude = lat;
  browse.filter_location_longitude = lng;
  browse.filter_radius_km = Math.max(1, Math.round(radiusKm));
  browse.commerce_search_sort_by = query.sort === "relevance" ? "BEST_MATCH" : "CREATION_TIME_DESCEND";
  // Unlike the page URL's price parameters, these keep results relevant (verified Sep 2026). Cents.
  browse.filter_price_lower_bound = query.minPriceCents != null && query.minPriceCents > 0 ? Math.floor(query.minPriceCents) : 0;
  browse.filter_price_upper_bound = query.maxPriceCents != null && query.maxPriceCents >= 0 ? Math.ceil(query.maxPriceCents) : NO_MAX_PRICE_CENTS;
  params.bqf = bqf;
  params.browse_request_params = browse;
  vars.params = params;
  vars.buyLocation = { latitude: lat, longitude: lng };
  vars.count = PAGE_SIZE;
  vars.cursor = cursor;
  vars.savedSearchQuery = keywords;
  return vars;
}

/** Facebook's "jazoest" check value: "2" followed by the sum of fb_dtsg's character codes. */
export function jazoest(fbDtsg: string): string {
  return `2${[...fbDtsg].reduce((sum, ch) => sum + ch.charCodeAt(0), 0)}`;
}

/** Form body of a GraphQL request, as the web client sends it. */
export function graphqlBody(session: GraphqlSession, operation: string, docId: string, variables: Json): URLSearchParams {
  return new URLSearchParams({
    av: session.userId,
    __user: session.userId,
    __a: "1",
    __comet_req: "15",
    fb_dtsg: session.fbDtsg,
    jazoest: jazoest(session.fbDtsg),
    lsd: session.lsd,
    fb_api_caller_class: "RelayModern",
    fb_api_req_friendly_name: operation,
    variables: JSON.stringify(variables),
    server_timestamps: "true",
    doc_id: docId,
  });
}

export interface GraphqlPage {
  /** Every JSON document in the (possibly streamed, one-per-line) response. */
  blobs: unknown[];
  errors: string[];
  endCursor: string | null;
  hasNextPage: boolean;
}

/** Parse a GraphQL response: strips the anti-JSON-hijacking prefix, reads each line, finds page info and errors. */
export function parseGraphqlResponse(text: string): GraphqlPage {
  const blobs: unknown[] = [];
  const errors: string[] = [];
  for (const line of text.replace(/^for \(;;\);/, "").split("\n")) {
    if (!line.trim()) continue;
    try {
      blobs.push(JSON.parse(line));
    } catch {
      // not JSON: ignore
    }
  }
  let endCursor: string | null = null;
  let hasNextPage = false;
  for (const blob of blobs) {
    const root = asObject(blob);
    for (const e of Array.isArray(root?.errors) ? root.errors : []) {
      const message = asObject(e)?.message;
      if (typeof message === "string") errors.push(message);
    }
    const info = asObject(asObject(asObject(asObject(root?.data)?.marketplace_search)?.feed_units)?.page_info);
    if (info) {
      if (typeof info.end_cursor === "string") endCursor = info.end_cursor;
      hasNextPage = info.has_next_page === true;
    }
  }
  return { blobs, errors, endCursor, hasNextPage };
}
