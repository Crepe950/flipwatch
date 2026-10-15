import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BlockedError, ParseError } from "../types";
import { apolloPriceCents } from "./apollo";
import { parseKijijiSearch } from "./parse";

const FIXTURES = path.resolve(import.meta.dirname, "../../../../test/fixtures/kijiji");
const fixture = (name: string) => readFileSync(path.join(FIXTURES, name), "utf8");

const NOW = new Date("2026-09-28T18:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const MIN = 60_000;
const HOUR = 60 * MIN;

const byId = <T extends { externalId: string }>(items: T[], id: string): T => {
  const found = items.find((item) => item.externalId === id);
  if (!found) throw new Error(`listing ${id} not found`);
  return found;
};

const withoutNextData = (html: string) => html.replace(/<script id="__NEXT_DATA__"[\s\S]*?<\/script>/, "");
const withoutCards = (html: string) => html.replace(/<ul data-testid="srp-search-list"[\s\S]*?<\/ul>/, "");
const withoutJsonLd = (html: string) => html.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g, "");
const nextDataPage = (data: unknown, body = "") =>
  `<!DOCTYPE html><html><head><title>Kijiji</title></head><body>${body}<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script></body></html>`;

describe("Next.js page state (search-next.html)", () => {
  const listings = parseKijijiSearch(fixture("search-next.html"), { now: NOW });

  it("returns each listing once, newest bump first", () => {
    expect(listings.map((l) => l.externalId)).toEqual([
      "1712000008",
      "1712000001",
      "1712000002",
      "1712000003",
      "1712000005",
      "1712000006",
      "1712000004",
      "1711000099",
    ]);
  });

  it("maps an Apollo listing, reading the price in cents", () => {
    const listing = byId(listings, "1712000001");
    expect(listing).toEqual({
      marketplace: "kijiji",
      externalId: "1712000001",
      url: "https://www.kijiji.ca/v-video-games-consoles/city-of-toronto/ps5-disc-edition-2-controllers/1712000001",
      title: "PS5 Disc Edition + 2 controllers",
      priceCents: 45_000,
      currency: "CAD",
      description:
        "Barely used PS5 disc edition, comes with 2 DualSense controllers and the charging dock. Pickup near Union Station, cash or e-transfer.",
      imageUrls: [
        "https://media.kijiji.ca/api/v1/ca-prod-fsbo-ads/images/1a/1a2b3c4d-0001-4a5b-9c8d-000000000001?rule=kijijica-640-webp",
        "https://media.kijiji.ca/api/v1/ca-prod-fsbo-ads/images/1a/1a2b3c4d-0001-4a5b-9c8d-000000000002?rule=kijijica-640-webp",
      ],
      locationText: "Toronto, ON M5J 1E6",
      lat: 43.6453,
      lng: -79.3806,
      postedAt: new Date("2026-09-28T15:42:10.000Z"),
      raw: expect.objectContaining({ source: "apollo", priceType: "FIXED", priceAmount: 45_000, topAd: false }),
    });
    expect(JSON.stringify(listing.raw).length).toBeLessThan(4096);
  });

  it("maps price types: odd cents, CONTACT and SWAP_TRADE → null, FREE → 0", () => {
    expect(byId(listings, "1712000008").priceCents).toBe(8_999);
    expect(byId(listings, "1712000002").priceCents).toBe(105_000);
    expect(byId(listings, "1712000003").priceCents).toBeNull();
    expect(byId(listings, "1712000005").priceCents).toBeNull();
    expect(byId(listings, "1712000006").priceCents).toBe(0);
  });

  it("resolves location refs and relative URLs, and uses the first activation as postedAt", () => {
    expect(byId(listings, "1712000008")).toMatchObject({
      url: "https://www.kijiji.ca/v-video-games-consoles/mississauga-peel-region/ps5-pulse-3d-wireless-headset/1712000008",
      locationText: "Mississauga, ON L5B 4M7",
      lat: 43.589,
      lng: -79.6441,
      postedAt: new Date("2026-09-20T12:00:00.000Z"),
    });
  });

  it("handles listings without images, address or coordinates, and non-ASCII titles", () => {
    expect(byId(listings, "1712000006")).toMatchObject({ imageUrls: [], locationText: "Toronto", lat: null, lng: null });
    expect(byId(listings, "1712000005").title).toBe("Échange PS5 contre Xbox Series X – état impeccable");
  });

  it("keeps the organic copy of a top-ad duplicate and keeps top-ad-only listings", () => {
    expect(listings.filter((l) => l.externalId === "1712000004")).toHaveLength(1);
    expect(byId(listings, "1712000004").raw).toMatchObject({ topAd: false });
    expect(byId(listings, "1711000099").raw).toMatchObject({ topAd: true });
  });
});

describe("server-rendered cards (search-next.html without page state)", () => {
  const listings = parseKijijiSearch(withoutNextData(fixture("search-next.html")), { now: NOW });

  it("reads cards in page order, the organic copy replacing the top-ad duplicate", () => {
    expect(listings.map((l) => l.externalId)).toEqual([
      "1711000099",
      "1712000008",
      "1712000001",
      "1712000002",
      "1712000003",
      "1712000005",
      "1712000006",
      "1712000004",
    ]);
    expect(byId(listings, "1712000004").raw).toMatchObject({ source: "card", featured: false });
    expect(byId(listings, "1711000099").raw).toMatchObject({ featured: true });
  });

  it("reads card fields and fills the truncated description from JSON-LD", () => {
    expect(byId(listings, "1712000001")).toEqual({
      marketplace: "kijiji",
      externalId: "1712000001",
      url: "https://www.kijiji.ca/v-video-games-consoles/city-of-toronto/ps5-disc-edition-2-controllers/1712000001",
      title: "PS5 Disc Edition + 2 controllers",
      priceCents: 45_000,
      currency: "CAD",
      description:
        "Barely used PS5 disc edition, comes with 2 DualSense controllers and the charging dock. Pickup near Union Station, cash or e-transfer.",
      imageUrls: ["https://media.kijiji.ca/api/v1/ca-prod-fsbo-ads/images/1a/1a2b3c4d-0001-4a5b-9c8d-000000000001?rule=kijijica-200-webp"],
      locationText: "Toronto",
      postedAt: ago(24 * MIN),
      raw: expect.objectContaining({ source: "card", price: "$450.00", date: "< 24 minutes ago" }),
    });
  });

  it("parses card prices and dates", () => {
    expect(byId(listings, "1712000002")).toMatchObject({ priceCents: 105_000, postedAt: ago(2 * HOUR) });
    expect(byId(listings, "1712000003")).toMatchObject({ priceCents: null, postedAt: ago(3 * HOUR) });
    expect(byId(listings, "1712000005").priceCents).toBeNull();
    expect(byId(listings, "1712000006")).toMatchObject({ priceCents: 0, postedAt: ago(24 * HOUR) });
    expect(byId(listings, "1712000008")).toMatchObject({ priceCents: 8_999, postedAt: ago(MIN) });
    expect(byId(listings, "1712000004").postedAt).toEqual(new Date("2026-09-25T12:00:00.000Z"));
  });

  it("drops placeholder images", () => {
    expect(byId(listings, "1712000006").imageUrls).toEqual([]);
  });
});

describe("JSON-LD only (search-next.html without page state or cards)", () => {
  const listings = parseKijijiSearch(withoutCards(withoutNextData(fixture("search-next.html"))), { now: NOW });

  it("reads the ItemList in order with dollar prices", () => {
    expect(listings.map((l) => [l.externalId, l.priceCents])).toEqual([
      ["1712000008", 8_999],
      ["1712000001", 45_000],
      ["1712000002", 105_000],
      ["1712000003", null],
      ["1712000005", null],
      ["1712000006", 0],
      ["1712000004", 38_000],
    ]);
    expect(byId(listings, "1712000001")).toMatchObject({
      url: "https://www.kijiji.ca/v-video-games-consoles/city-of-toronto/ps5-disc-edition-2-controllers/1712000001",
      title: "PS5 Disc Edition + 2 controllers",
      currency: "CAD",
      imageUrls: ["https://media.kijiji.ca/api/v1/ca-prod-fsbo-ads/images/1a/1a2b3c4d-0001-4a5b-9c8d-000000000001?rule=kijijica-200-webp"],
      postedAt: null,
      raw: expect.objectContaining({ source: "json-ld" }),
    });
    expect(byId(listings, "1712000006").imageUrls).toEqual([]);
  });
});

describe("legacy markup (search-legacy.html)", () => {
  const listings = parseKijijiSearch(fixture("search-legacy.html"), { now: NOW });

  it("reads every ad once, the organic copy replacing the top-feature duplicate", () => {
    expect(listings.map((l) => l.externalId)).toEqual([
      "1598765440",
      "1598765441",
      "1598765442",
      "1598765443",
      "1598765432",
      "1598765444",
    ]);
  });

  it("maps a legacy card", () => {
    expect(listings[0]).toEqual({
      marketplace: "kijiji",
      externalId: "1598765440",
      url: "https://www.kijiji.ca/v-bikes/ottawa/norco-storm-4-medium/1598765440",
      title: "Norco Storm 4 - Medium",
      priceCents: 115_000,
      currency: "CAD",
      description: '2022 Norco Storm 4, 29" wheels, new tires. Minor scratches on the top tube.',
      imageUrls: ["https://i.ebayimg.com/00/s/NjAwWDgwMA==/z/kL6mN7oP8qR9sT0u/$_35.JPG"],
      locationText: "Kanata",
      postedAt: ago(9 * MIN),
      raw: expect.objectContaining({ source: "card", featured: false }),
    });
  });

  it("parses Free, Swap / Trade, Please Contact and cents", () => {
    expect(byId(listings, "1598765441").priceCents).toBe(0);
    expect(byId(listings, "1598765442").priceCents).toBeNull();
    expect(byId(listings, "1598765443").priceCents).toBeNull();
    expect(byId(listings, "1598765444").priceCents).toBe(129_999);
  });

  it("parses day/month/year, Yesterday and relative dates", () => {
    expect(byId(listings, "1598765432").postedAt).toEqual(new Date("2026-09-15T12:00:00.000Z"));
    expect(byId(listings, "1598765443").postedAt).toEqual(new Date("2026-09-27T12:00:00.000Z"));
    expect(byId(listings, "1598765441").postedAt).toEqual(ago(24 * HOUR));
    expect(byId(listings, "1598765444").postedAt).toEqual(ago(45 * MIN));
  });

  it("handles absolute links, missing images and non-ASCII text", () => {
    expect(byId(listings, "1598765444").url).toBe("https://www.kijiji.ca/v-bikes/ottawa/specialized-sirrus-x-4-0/1598765444");
    expect(byId(listings, "1598765443")).toMatchObject({ imageUrls: [], title: "Vélo électrique – batterie neuve", locationText: "Gatineau" });
    expect(byId(listings, "1598765441").locationText).toBe("Orléans");
  });
});

describe("page classification", () => {
  it("returns [] for a zero-results page, ignoring suggested listings", () => {
    expect(parseKijijiSearch(fixture("no-results.html"), { now: NOW })).toEqual([]);
  });

  it("treats an empty search-results object as authoritative", () => {
    const html = fixture("no-results.html").replace(/<div data-testid="srp-zero-results"[\s\S]*?<\/div>/, "");
    expect(html).not.toContain("srp-zero-results");
    expect(parseKijijiSearch(html, { now: NOW })).toEqual([]);
  });

  it("returns [] for a legacy results container without ads", () => {
    const html = '<html><body><div class="container-results large-images"><div class="third-party"></div></div></body></html>';
    expect(parseKijijiSearch(html, { now: NOW })).toEqual([]);
  });

  it("does not mistake a listing quoting a challenge page for a block", () => {
    const html = fixture("search-next.html").replace(
      "Brand new sealed PS5 Slim digital edition.",
      "Pardon our interruption - moving sale! Brand new sealed PS5 Slim digital edition.",
    );
    expect(parseKijijiSearch(html, { now: NOW })).toHaveLength(8);
    expect(parseKijijiSearch(withoutNextData(html), { now: NOW })).toHaveLength(8);
  });

  it("throws BlockedError for Cloudflare and captcha challenges", () => {
    expect(() => parseKijijiSearch(fixture("blocked-cloudflare.html"))).toThrow(BlockedError);
    expect(() => parseKijijiSearch(fixture("blocked-captcha.html"))).toThrow(BlockedError);
    const generic = "<html><head><title>Kijiji</title></head><body><p>Please verify you are a human.</p></body></html>";
    expect(() => parseKijijiSearch(generic)).toThrow(BlockedError);
  });

  it("does not mistake a results page that mentions captcha for a challenge", () => {
    const html = fixture("search-legacy.html").replace("</body>", '<script src="https://www.google.com/recaptcha/api.js"></script></body>');
    expect(parseKijijiSearch(html, { now: NOW })).toHaveLength(6);
  });

  it("throws ParseError for an empty body or an unrecognisable page", () => {
    expect(() => parseKijijiSearch("")).toThrow(ParseError);
    expect(() => parseKijijiSearch("<html><head><title>Maintenance</title></head><body>Back soon</body></html>")).toThrow(
      /Unrecognised Kijiji page \("Maintenance"\)/,
    );
    expect(() => parseKijijiSearch(nextDataPage({ props: { pageProps: { pageType: "VIP" } } }))).toThrow(ParseError);
  });

  it("links a card to its own ad even when the only link found points elsewhere", () => {
    const html = `<html><body><ul data-testid="srp-search-list">
      <li><section data-testid="listing-card" data-listingid="1712345678">
        <h3 data-testid="listing-title">Standing desk</h3>
        <a href="/o-profile/1001/listings">Seller</a>
        <p data-testid="listing-price">$150.00</p>
      </section></li>
    </ul></body></html>`;
    expect(parseKijijiSearch(html, { now: NOW })).toEqual([
      expect.objectContaining({
        externalId: "1712345678",
        title: "Standing desk",
        url: "https://www.kijiji.ca/v-view-details.html?adId=1712345678",
        priceCents: 15_000,
      }),
    ]);
  });

  it("throws ParseError when cards exist but none can be read", () => {
    const html = '<html><body><ul><li><section data-testid="listing-card"><p>no link, no title</p></section></li></ul></body></html>';
    expect(() => parseKijijiSearch(html)).toThrow(/could not read any/);
  });
});

describe("defensive page-state parsing", () => {
  it("falls back to the HTML when __NEXT_DATA__ is not valid JSON", () => {
    const html = fixture("search-next.html").replace(/(<script id="__NEXT_DATA__"[^>]*>)[\s\S]*?(<\/script>)/, "$1{broken$2");
    const listings = parseKijijiSearch(html, { now: NOW });
    expect(listings).toHaveLength(8);
    expect(listings[0].raw).toMatchObject({ source: "card" });
  });

  it("walks state without a search-results object or typenames", () => {
    const data = {
      props: {
        pageProps: {
          initialState: {
            srp: {
              items: [
                { id: 1700000001, title: " Couch ", price: { amount: 12_500, type: "FIXED" }, url: "/v-couch/toronto/couch/1700000001", imageUrls: [] },
                { id: "1700000002", title: "Desk", price: { amount: "0", type: "GIVE_AWAY" }, url: "https://evil.example/1700000002", imageUrls: ["data:x", "https://media.kijiji.ca/a.jpg"] },
                { id: "1700000003", title: "Chair", price: { amount: 5_000, type: "FIXED" }, url: "/v-chair/toronto/other-listing/1799999999" },
                { id: "../etc", title: "Bad id", price: { amount: 1 }, url: "/x" },
              ],
            },
          },
        },
      },
    };
    const listings = parseKijijiSearch(nextDataPage(data), { now: NOW });
    expect(listings.map((l) => [l.externalId, l.title, l.priceCents, l.url])).toEqual([
      ["1700000001", "Couch", 12_500, "https://www.kijiji.ca/v-couch/toronto/couch/1700000001"],
      // Off-site and mismatched links fall back to Kijiji's view-by-id URL.
      ["1700000002", "Desk", 0, "https://www.kijiji.ca/v-view-details.html?adId=1700000002"],
      ["1700000003", "Chair", 5_000, "https://www.kijiji.ca/v-view-details.html?adId=1700000003"],
    ]);
    expect(listings[1].imageUrls).toEqual(["https://media.kijiji.ca/a.jpg"]);
  });

  it("falls back to the cards when the search results in the page state can no longer be read", () => {
    // The listing typename changed: the search-results object still references its listings.
    const drifted = fixture("search-next.html").replaceAll('"StandardListing"', '"StandardAd"');
    const sources = (html: string) => parseKijijiSearch(html, { now: NOW }).map((l) => (l.raw as { source: string }).source);
    expect(sources(drifted)).toEqual(Array(8).fill("card"));
    // Only the JSON-LD left to read.
    expect(sources(withoutCards(drifted))).toEqual(Array(7).fill("json-ld"));
  });

  it("throws ParseError when the page state lists results that nothing on the page can read", () => {
    const retitled = withoutJsonLd(withoutCards(fixture("search-next.html").replaceAll('"title":', '"listingTitle":')));
    expect(() => parseKijijiSearch(retitled, { now: NOW })).toThrow(/page state lists 9 results but none could be read/);

    // A result count alone gives it away too, e.g. when listings moved to an unrecognised field.
    const counted = { props: { pageProps: { searchResults: { results: { items: [{ adId: 1 }] }, pagination: { totalCount: 5 } } } } };
    expect(() => parseKijijiSearch(nextDataPage(counted))).toThrow(/lists 5 results/);
  });

  it("still trusts an explicit zero-results block over leftover references", () => {
    const data = { props: { pageProps: { searchResults: { mainListings: [{ __ref: "Gone:1" }] } } } };
    expect(parseKijijiSearch(nextDataPage(data, '<div data-testid="srp-zero-results">none</div>'))).toEqual([]);
  });

  it("ignores listing-shaped state outside the results when the page says there are none", () => {
    const data = { props: { pageProps: { recommendations: [{ id: "1700000009", title: "Suggested", price: { amount: 100 }, url: "/v-x/y/z/1700000009" }] } } };
    expect(parseKijijiSearch(nextDataPage(data, '<div data-testid="srp-zero-results">none</div>'))).toEqual([]);
  });
});

describe("apolloPriceCents", () => {
  it.each([
    [{ amount: 45_000, type: "FIXED" }, 45_000],
    [{ amount: "12345", type: "FIXED" }, 12_345],
    [{ amount: 1_999.6 }, 2_000],
    [{ amount: null, type: "CONTACT" }, null],
    [{ amount: 50_000, type: "PLEASE_CONTACT" }, null],
    [{ amount: null, type: "SWAP_TRADE" }, null],
    [{ amount: null, type: "FREE" }, 0],
    [{ type: "give_away" }, 0],
    [{ amount: -5, type: "FIXED" }, null],
    [{ amount: "n/a", type: "FIXED" }, null],
    [undefined, null],
  ])("%j → %s", (price, expected) => {
    expect(apolloPriceCents(price)).toBe(expected);
  });
});
