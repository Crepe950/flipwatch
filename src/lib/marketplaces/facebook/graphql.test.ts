import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchQuery } from "../../types";
import type { AdapterContext } from "../types";
import {
  buildSearchVariables,
  bundleUrls,
  extractGraphqlSession,
  findOperationDocId,
  jazoest,
  parseGraphqlResponse,
} from "./graphql";
import { resetFacebookBudget } from "./budget";
import facebook, { resetFacebookGraphqlCache } from "./index";

const COOKIES = "c_user=100012345678901; xs=12%3AabcDEF%3A2%3A1790000000%3A-1%3A1234; datr=Zx9aZ1b2c3d4";
const CONTAINER_DOC = "27517490627932547";
const PAGINATION_DOC = "27212616558440397";
const BUNDLE = "https://static.xx.fbcdn.net/rsrc.php/v4/yA/r/abc123.js";

const template = {
  buyLocation: { latitude: 49.28, longitude: -123.12 },
  count: 24,
  cursor: null,
  params: {
    bqf: { callsite: "COMMERCE_MKTPLACE_WWW", query: "rtx 4070" },
    browse_request_params: {
      filter_location_latitude: 49.28,
      filter_location_longitude: -123.12,
      filter_price_lower_bound: 0,
      filter_price_upper_bound: 214748364700,
      filter_radius_km: 40,
      commerce_search_sort_by: "BEST_MATCH",
    },
    custom_request_params: { surface: "SEARCH" },
  },
  savedSearchQuery: "rtx 4070",
  scale: 1,
};

type Vars = Omit<typeof template, "cursor"> & { cursor: string | null };

const listing = (id: string, title: string, price: string) => ({
  __typename: "GroupCommerceProductItem",
  id,
  marketplace_listing_title: title,
  listing_price: { amount: price, formatted_amount: `CA$${price}` },
  location: { reverse_geocode: { city: "Abbotsford", state: "BC" } },
});

const feed = (items: ReturnType<typeof listing>[], next: string | null) => ({
  data: {
    marketplace_search: {
      feed_units: {
        edges: items.map((l) => ({ node: { listing: l } })),
        page_info: { end_cursor: next, has_next_page: next !== null },
      },
    },
  },
});

/** A logged-in search page: request tokens, the preloaded search query, one server-rendered listing, one bundle. */
function searchPage(ssrItems = [listing("900", "SSR only RTX 3070", "450.00")]) {
  return `<html><script>requireLazy(["DTSGInitialData",[],{"token":"NAf-TEST-dtsg"}],["LSD",[],{"token":"lsd-TEST"}])</script>
<script type="application/json" data-sjs>${JSON.stringify({ require: [["ScheduledServerJS", "handle", null, [feed(ssrItems, "ssr-cursor")]]] })}</script>
<script>{"preloaderID":"x","queryID":"${CONTAINER_DOC}","variables":${JSON.stringify(template)},"queryName":"CometMarketplaceSearchContentContainerQuery"}</script>
<script src="${BUNDLE}"></script></html>`;
}

const bundleJs = `__d("CometMarketplaceSearchContentPaginationQuery_facebookRelayOperation",[],(function(a,b,c,d,e,f){e.exports="${PAGINATION_DOC}"}),null);`;

const vancouver = { label: "Vancouver, BC", lat: 49.2827, lng: -123.1207, radiusKm: 100, countryCode: "CA", facebookLocation: "vancouver" };
const query: SearchQuery = { keywords: "rtx 4070", location: vancouver, sort: "relevance", minPriceCents: 30_000, maxPriceCents: 60_000 };

describe("graphql helpers", () => {
  it("extracts the session tokens, user and the search query template from a page", () => {
    const session = extractGraphqlSession(searchPage(), COOKIES);
    expect(session).toMatchObject({ fbDtsg: "NAf-TEST-dtsg", lsd: "lsd-TEST", userId: "100012345678901", containerDocId: CONTAINER_DOC });
    expect(session?.variables).toEqual(template);
    expect(extractGraphqlSession("<html>logged out</html>", COOKIES)).toBeNull();
  });

  it("re-aims the template at the query's location, radius, sort, price range and cursor", () => {
    const vars = buildSearchVariables(template, { ...query, keywords: "gtx 1080" }, "cur-2") as Vars;
    expect(vars.params.bqf.query).toBe("gtx 1080");
    expect(vars.params.browse_request_params).toMatchObject({
      filter_location_latitude: 49.2827,
      filter_location_longitude: -123.1207,
      filter_radius_km: 100,
      commerce_search_sort_by: "BEST_MATCH",
      filter_price_lower_bound: 30_000,
      filter_price_upper_bound: 60_000,
    });
    expect(vars).toMatchObject({ buyLocation: { latitude: 49.2827, longitude: -123.1207 }, count: 24, cursor: "cur-2", savedSearchQuery: "gtx 1080" });
    expect(template.params.browse_request_params.filter_radius_km).toBe(40); // template untouched
    const newest = buildSearchVariables(template, { ...query, sort: undefined, minPriceCents: null, maxPriceCents: null }, null) as Vars;
    expect(newest.params.browse_request_params).toMatchObject({ commerce_search_sort_by: "CREATION_TIME_DESCEND", filter_price_lower_bound: 0, filter_price_upper_bound: 214748364700 });
  });

  it("finds bundle URLs and a persisted query's doc id", () => {
    expect(bundleUrls(searchPage())).toEqual([BUNDLE]);
    expect(bundleUrls(`"src":"https:\\/\\/static.xx.fbcdn.net\\/rsrc.php\\/v4\\/x.js"`)).toEqual(["https://static.xx.fbcdn.net/rsrc.php/v4/x.js"]);
    expect(findOperationDocId(bundleJs, "CometMarketplaceSearchContentPaginationQuery")).toBe(PAGINATION_DOC);
    expect(findOperationDocId(bundleJs, "SomethingElseQuery")).toBeNull();
  });

  it("parses prefixed, streamed responses with page info and errors", () => {
    const text = `for (;;);${JSON.stringify(feed([listing("1", "a", "1.00")], "next-1"))}\n${JSON.stringify({ errors: [{ message: "rate limit" }] })}\nnot json`;
    const parsed = parseGraphqlResponse(text);
    expect(parsed.blobs).toHaveLength(2);
    expect(parsed).toMatchObject({ endCursor: "next-1", hasNextPage: true, errors: ["rate limit"] });
    expect(jazoest("ab")).toBe("2195");
  });
});

describe("facebook adapter with the search API", () => {
  let posts: Array<{ friendly: string; docId: string; variables: Vars }>;

  function fakeFacebook(post: (docId: string, cookie: string) => Response, credentials: AdapterContext["credentials"] = { facebookCookies: COOKIES }) {
    posts = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      if (url === BUNDLE) return new Response(bundleJs);
      if (url.startsWith("https://www.facebook.com/api/graphql/")) {
        const body = new URLSearchParams(String(init.body));
        posts.push({ friendly: body.get("fb_api_req_friendly_name")!, docId: body.get("doc_id")!, variables: JSON.parse(body.get("variables")!) });
        return post(body.get("doc_id")!, new Headers(init.headers).get("cookie") ?? "");
      }
      return new Response(searchPage(), { headers: { "Content-Type": "text/html" } });
    });
    const ctx: AdapterContext = { fetch: fetchImpl as unknown as typeof fetch, credentials };
    return { ctx, fetchImpl };
  }

  beforeEach(() => {
    resetFacebookBudget();
    vi.stubEnv("FACEBOOK_ENABLED", "true");
    vi.stubEnv("FACEBOOK_COOKIES", "");
    vi.stubEnv("SCRAPER_USER_AGENT", "");
    vi.spyOn(Math, "random").mockReturnValue(0);
    resetFacebookGraphqlCache();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    resetFacebookGraphqlCache();
  });

  it("searches with the query's own radius and pages through results", async () => {
    const { ctx } = fakeFacebook((docId) =>
      docId === CONTAINER_DOC
        ? new Response(JSON.stringify(feed([listing("1", "RTX 4070 Ti", "900.00"), listing("2", "RTX 3070", "450.00")], "c-2")))
        : new Response(JSON.stringify(feed([listing("2", "RTX 3070", "450.00"), listing("3", "RTX 3080", "580.00")], null))),
    );
    const results = await facebook.search({ ...query, pages: 3 }, ctx);

    expect(results.map((l) => l.externalId)).toEqual(["1", "2", "3"]);
    expect(posts.map((p) => [p.friendly, p.docId, p.variables.cursor])).toEqual([
      ["CometMarketplaceSearchContentContainerQuery", CONTAINER_DOC, null],
      ["CometMarketplaceSearchContentPaginationQuery", PAGINATION_DOC, "c-2"],
    ]);
    expect(posts[0].variables.params.browse_request_params.filter_radius_km).toBe(100);
  });

  it("reuses the session: a second search makes no page request", async () => {
    const { ctx, fetchImpl } = fakeFacebook(() => new Response(JSON.stringify(feed([listing("1", "RTX 4070", "700.00")], null))));
    await facebook.search(query, ctx);
    await facebook.search({ ...query, keywords: "rtx 3080" }, ctx);
    const pageLoads = fetchImpl.mock.calls.filter(([u]) => String(u).includes("/marketplace/"));
    expect(pageLoads).toHaveLength(1);
    expect(posts).toHaveLength(2);
  });

  it("backs off on Facebook's rate limit instead of loading the page as well", async () => {
    const { ctx, fetchImpl } = fakeFacebook(() => new Response(JSON.stringify({ errors: [{ message: "Rate limit exceeded" }] })));
    await expect(facebook.search(query, ctx)).rejects.toThrow(/rate-limited the Facebook account/);
    const requests = fetchImpl.mock.calls.length;
    // While cooling down, nothing at all goes to Facebook — not even for a search the user is waiting on.
    await expect(facebook.search({ ...query, interactive: true }, ctx)).rejects.toThrow(/resting it for another/);
    expect(fetchImpl.mock.calls.length).toBe(requests);
  });

  it("moves a search to the other account when Facebook rate-limits one", async () => {
    vi.stubEnv("FACEBOOK_COOKIES", "c_user=1; xs=old");
    vi.stubEnv("FACEBOOK_COOKIES_2", "c_user=2; xs=new");
    vi.stubEnv("FACEBOOK_ACCOUNT_SHARES", "35,65");
    const { ctx } = fakeFacebook(
      (_docId, cookie) =>
        cookie.includes("xs=new")
          ? new Response(JSON.stringify({ errors: [{ message: "Rate limit exceeded" }] }))
          : new Response(JSON.stringify(feed([listing("1", "RTX 4070", "700.00")], null))),
      {},
    );
    // The 65 % account goes first, gets rate-limited, and the search finishes on the other one.
    expect((await facebook.search(query, ctx)).map((l) => l.externalId)).toEqual(["1"]);
    expect(posts).toHaveLength(2);
    // The rate-limited account now rests: the next search goes straight to the other.
    await facebook.search(query, ctx);
    expect(posts).toHaveLength(3);
  });

  it("falls back to the server-rendered page when the search API fails", async () => {
    const { ctx } = fakeFacebook(() => new Response(JSON.stringify({ errors: [{ message: "PersistedQueryNotFound" }] })));
    const results = await facebook.search(query, ctx);
    expect(results.map((l) => l.title)).toEqual(["SSR only RTX 3070"]);
  });
});
