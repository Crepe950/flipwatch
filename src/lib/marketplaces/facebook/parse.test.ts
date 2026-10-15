import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extractEmbeddedJson, sliceBalancedJson } from "./embedded-json";
import { loginRedirectReason, loginWallReason } from "./login-wall";
import { extractFacebookListings, facebookPriceCents } from "./parse";

function fixture(name: string): string {
  return readFileSync(new URL(`../../../../test/fixtures/facebook/${name}`, import.meta.url), "utf8");
}

describe("extractEmbeddedJson", () => {
  it("parses application/json blobs and inline handle() payloads, skipping malformed ones", () => {
    const blobs = extractEmbeddedJson(fixture("search-page.html"));
    // timing + search + prefetch blobs, the truncated blob is skipped, plus one inline handle() payload.
    expect(blobs).toHaveLength(4);
    expect(JSON.stringify(blobs[3])).toContain("adp_CometMarketplaceSearchContentPaginationQueryRelayPreloader");
  });

  it("returns [] for a page without scripts", () => {
    expect(extractEmbeddedJson("<html><body>hi</body></html>")).toEqual([]);
  });
});

describe("sliceBalancedJson", () => {
  it("respects braces inside strings and escapes", () => {
    const text = 'x.handle({"a":"}{\\"]","b":[1,{"c":2}]});rest';
    expect(sliceBalancedJson(text, text.indexOf("{"))).toBe('{"a":"}{\\"]","b":[1,{"c":2}]}');
  });

  it("returns null for unbalanced input or a non-bracket start", () => {
    expect(sliceBalancedJson('{"a":1', 0)).toBeNull();
    expect(sliceBalancedJson("abc", 0)).toBeNull();
  });
});

describe("extractFacebookListings", () => {
  const { listings, sawSearchFeed } = extractFacebookListings(extractEmbeddedJson(fixture("search-page.html")), "CAD");

  it("keeps available feed listings in page order; skips sold/pending/hidden and duplicates", () => {
    expect(sawSearchFeed).toBe(true);
    expect(listings.map((l) => l.externalId)).toEqual([
      "1234567890123456",
      "2234567890123457",
      "6234567890123461",
      "7234567890123462",
      "9234567890123464",
    ]);
  });

  it("maps a search result completely", () => {
    expect(listings[0]).toEqual({
      marketplace: "facebook",
      externalId: "1234567890123456",
      url: "https://www.facebook.com/marketplace/item/1234567890123456/",
      title: "PS5 Disc Edition with 2 controllers",
      priceCents: 45000,
      currency: "CAD",
      description: null,
      imageUrls: [
        "https://scontent-sea1-1.xx.fbcdn.net/v/t45.5328-4/461234567_1234567890_n.jpg?stp=c0.43.261.261a_dst-jpg_p261x260&_nc_cat=105&ccb=1-7&oh=00_AYB&oe=66F8A1B2",
      ],
      locationText: "Vancouver, British Columbia",
      lat: null,
      lng: null,
      postedAt: new Date(1_790_000_000 * 1000),
      sellerName: "Jordan Lee",
      condition: null,
      raw: expect.objectContaining({ id: "1234567890123456", is_live: true, delivery_types: ["IN_PERSON"] }),
    });
  });

  it("handles free items, listing_image photos and city/state locations", () => {
    expect(listings[1]).toMatchObject({
      title: "Free moving boxes",
      priceCents: 0,
      imageUrls: ["https://scontent-sea1-1.xx.fbcdn.net/v/t45.5328-4/boxes_n.jpg?_nc_cat=1"],
      locationText: "Burnaby, BC",
      sellerName: null,
      postedAt: null,
    });
  });

  it("uses custom_title, minor-unit amounts and an explicit currency", () => {
    expect(listings[2]).toMatchObject({
      title: "Xbox Series X (custom title)",
      priceCents: 12500,
      currency: "USD",
      imageUrls: [],
      locationText: "Blaine, WA",
      sellerName: "Sam",
      raw: expect.objectContaining({ subtitles: ["Ships to you"] }),
    });
  });

  it("falls back to the formatted amount and drops non-http image URIs", () => {
    expect(listings[3]).toMatchObject({ priceCents: 120000, imageUrls: [], locationText: null });
  });

  it("reads string creation_time from a streamed pagination chunk", () => {
    expect(listings[4]).toMatchObject({ title: "Nintendo Switch (from inline handle payload)", priceCents: 18000 });
    expect(listings[4].postedAt).toEqual(new Date(1_790_003_600 * 1000));
  });

  it("drops a listing that a later chunk of the feed marks pending", () => {
    expect(listings.some((l) => l.externalId === "8234567890123463")).toBe(false);
  });

  it("ignores listings outside the search feed (recently viewed rail) when the feed is present", () => {
    expect(listings.some((l) => l.externalId === "1111222233334444")).toBe(false);
    expect(listings[0].title).not.toContain("Duplicate");
  });

  it("falls back to every listing-shaped object when the feed wrapper is unrecognised", () => {
    const blob = {
      data: {
        renamed_search: {
          results: [
            { id: "1", marketplace_listing_title: "Desk", listing_price: { amount: "40.00" }, is_sold: false },
            { id: "2", marketplace_listing_title: "Chair", listing_price: { amount: "15.00" }, is_pending: true },
            { id: "3", marketplace_listing_title: "Shelf", listing_price: { amount: "99999999999.00" } },
          ],
        },
      },
    };
    const result = extractFacebookListings([blob], "USD");
    expect(result.sawSearchFeed).toBe(false);
    expect(result.listings.map((l) => [l.externalId, l.priceCents])).toEqual([
      ["1", 4000],
      ["3", null],
    ]);
  });

  it("reports an empty feed as a feed with no listings", () => {
    const empty = extractFacebookListings(extractEmbeddedJson(fixture("search-page-empty.html")), "USD");
    expect(empty).toEqual({ listings: [], sawSearchFeed: true, unreadableFeedListings: 0 });
  });

  it("counts feed listings that are not listing-shaped (a renamed price field)", () => {
    const drifted = fixture("search-page.html").replaceAll('"listing_price"', '"price_info"');
    const result = extractFacebookListings(extractEmbeddedJson(drifted), "CAD");
    expect(result).toMatchObject({ listings: [], sawSearchFeed: true });
    expect(result.unreadableFeedListings).toBeGreaterThan(0);
    // Readable feeds, and feed stories without a listing, count nothing.
    expect(extractFacebookListings(extractEmbeddedJson(fixture("search-page.html")), "CAD").unreadableFeedListings).toBe(0);
    const story = { marketplace_search: { feed_units: { edges: [{ node: { __typename: "MarketplaceFeedAdStory", listing: null } }] } } };
    expect(extractFacebookListings([story], "USD").unreadableFeedListings).toBe(0);
  });

  it("reports a page without a feed", () => {
    expect(extractFacebookListings(extractEmbeddedJson(fixture("unknown-page.html")), "USD").sawSearchFeed).toBe(false);
  });
});

describe("facebookPriceCents", () => {
  it("prefers amount, then minor units, then the formatted text", () => {
    expect(facebookPriceCents({ amount: "19.99", amount_with_offset_in_currency: "1", formatted_amount: "$1" })).toBe(1999);
    expect(facebookPriceCents({ amount_with_offset_in_currency: "2500" })).toBe(2500);
    expect(facebookPriceCents({ formatted_amount: "Free" })).toBe(0);
    expect(facebookPriceCents({})).toBeNull();
  });

  it("treats placeholder prices that would overflow the column as no price", () => {
    expect(facebookPriceCents({ amount: "1234567890.00" })).toBeNull();
    expect(facebookPriceCents({ amount_with_offset_in_currency: "999999999999" })).toBeNull();
    expect(facebookPriceCents({ formatted_amount: "$99,999,999,999" })).toBeNull();
  });
});

describe("login wall detection", () => {
  it("recognises login and checkpoint redirects", () => {
    expect(loginRedirectReason("https://www.facebook.com/login/?next=%2Fmarketplace")).toBe("login redirect");
    expect(loginRedirectReason("https://www.facebook.com/login.php?next=x")).toBe("login redirect");
    expect(loginRedirectReason("https://www.facebook.com/checkpoint/1501092823525282/")).toBe("security checkpoint redirect");
    expect(loginRedirectReason("https://www.facebook.com/marketplace/vancouver/search?query=login")).toBeNull();
    expect(loginRedirectReason("not a url")).toBeNull();
  });

  it("recognises login, checkpoint and temporary-block pages", () => {
    expect(loginWallReason(fixture("login-wall.html"))).toBe("login page");
    expect(loginWallReason(fixture("checkpoint.html"))).toBe("security checkpoint");
    expect(loginWallReason("<title>Facebook – log in or sign up</title>")).toBe("login page");
    expect(loginWallReason("<title>Log in to Facebook</title>")).toBe("login page");
    expect(loginWallReason("<h2>You’re Temporarily Blocked</h2>")).toBe("temporary block");
    expect(loginWallReason('<form method="post" action="https://www.facebook.com/login.php?login_attempt=1">')).toBe("login form");
  });

  it("recognises meta-refresh bounces to the login page or a checkpoint", () => {
    expect(loginWallReason('<meta http-equiv="refresh" content="0; URL=/login/?next=%2Fmarketplace" />')).toBe("login redirect");
    expect(loginWallReason("<meta http-equiv=refresh content='0;url=https://www.facebook.com/checkpoint/123/'>")).toBe(
      "security checkpoint redirect",
    );
    expect(loginWallReason('<meta http-equiv="refresh" content="30">')).toBeNull();
  });

  it("does not flag an ordinary Marketplace page", () => {
    expect(loginWallReason(fixture("search-page-empty.html"))).toBeNull();
    expect(loginWallReason(fixture("search-page.html"))).toBeNull();
  });
});
