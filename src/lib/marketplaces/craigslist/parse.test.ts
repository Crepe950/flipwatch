import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BlockedError, ParseError } from "../types";
import { parseCraigslistSearch, type ParseCraigslistOptions } from "./parse";

const FIXTURES = path.resolve(import.meta.dirname, "../../../../test/fixtures/craigslist");
const fixture = (name: string) => readFileSync(path.join(FIXTURES, name), "utf8");

const NOW = new Date("2026-09-28T18:00:00Z");
const VANCOUVER: ParseCraigslistOptions = { origin: "https://vancouver.craigslist.org", currency: "CAD", now: NOW };
const SEATTLE: ParseCraigslistOptions = { origin: "https://seattle.craigslist.org", currency: "USD", now: NOW };
const SFBAY: ParseCraigslistOptions = { origin: "https://sfbay.craigslist.org", currency: "USD", now: NOW };

const byId = <T extends { externalId: string }>(items: T[], id: string): T => {
  const found = items.find((item) => item.externalId === id);
  if (!found) throw new Error(`listing ${id} not found`);
  return found;
};

/** Minimal page shell around result markup, for edge cases the fixtures don't cover. */
const page = (body: string, head = "") => `<!DOCTYPE html><html><head><title>test - craigslist</title>${head}</head><body>${body}</body></html>`;

describe("static no-JS results (search-static.html)", () => {
  const listings = parseCraigslistSearch(fixture("search-static.html"), VANCOUVER);

  it("returns every result once, in page order, skipping the see-also links", () => {
    expect(listings.map((l) => l.externalId)).toEqual([
      "7781234501",
      "7781234502",
      "7781234503",
      "7781234504",
      "7781234505",
      "7781234506",
      "7781234508",
      "7781234509",
      "7781234510",
    ]);
  });

  it("merges JSON-LD images, coordinates and currency into the HTML row", () => {
    const first = listings[0];
    expect(first).toMatchObject({
      marketplace: "craigslist",
      externalId: "7781234501",
      url: "https://vancouver.craigslist.org/van/vgm/d/vancouver-ps5-disc-edition-with/7781234501.html",
      title: "PS5 Disc Edition with 2 controllers",
      priceCents: 45_000,
      currency: "CAD",
      imageUrls: [
        "https://images.craigslist.org/00a0a_5xYz9KpQw3E_0CI0t2_600x450.jpg",
        "https://images.craigslist.org/00b0b_hT4mN8rLq2A_0CI0t2_600x450.jpg",
      ],
      locationText: "Vancouver",
      lat: 49.2634,
      lng: -123.1382,
      postedAt: null,
    });
    expect(first.raw).toMatchObject({ variant: "static", pid: "7781234501", price: "$450" });
    expect(JSON.stringify(first.raw).length).toBeLessThan(4096);
  });

  it("parses prices with thousands separators, $0 as free and a missing price as null", () => {
    expect(byId(listings, "7781234502").priceCents).toBe(185_000);
    expect(byId(listings, "7781234509").priceCents).toBe(109_900);
    expect(byId(listings, "7781234504").priceCents).toBe(0);
    expect(byId(listings, "7781234503").priceCents).toBeNull();
  });

  it("resolves relative links against the site origin", () => {
    expect(byId(listings, "7781234505").url).toBe("https://vancouver.craigslist.org/pml/vgm/d/surrey-ps5-digital-edition/7781234505.html");
  });

  it("keeps non-ASCII and entity-encoded titles intact", () => {
    expect(byId(listings, "7781234506").title).toBe("Console PS5 — état neuf, jamais utilisée ✨");
    expect(byId(listings, "7781234508").title).toBe("PS VR2 headset & Horizon bundle");
  });

  it("handles results without images, location or coordinates", () => {
    expect(byId(listings, "7781234505").imageUrls).toEqual([]);
    // No HTML location: the JSON-LD locality is used; no JSON-LD geo: no coordinates.
    expect(byId(listings, "7781234510")).toMatchObject({ locationText: "Delta, BC", lat: null, lng: null });
  });

  it("lets the page's JSON-LD currency win over the site default", () => {
    const asUsd = parseCraigslistSearch(fixture("search-static.html"), { ...VANCOUVER, currency: "USD" });
    expect(asUsd.every((l) => l.currency === "CAD")).toBe(true);
  });
});

describe("/view/d/ posting links (2026 markup)", () => {
  const html = page(`<ol class="cl-static-search-results">
    <li class="cl-static-hub-links"><div>see also</div></li>
    <li class="cl-static-search-result" title="Dewalt DCD771 Cordless Drill Driver Set Used">
      <a href="https://www.craigslist.org/view/d/burnaby-dewalt-dcd771-cordless-drill/8RngeD788mznpUatTWsNF5">
        <div class="title">Dewalt DCD771 Cordless Drill Driver Set Used</div>
        <div class="details"><div class="price">$120</div><div class="location"> Metrotown </div></div>
      </a>
    </li>
  </ol>`);

  it("uses the opaque id from the link as the external id", () => {
    const [listing] = parseCraigslistSearch(html, VANCOUVER);
    expect(listing).toMatchObject({
      externalId: "8RngeD788mznpUatTWsNF5",
      url: "https://www.craigslist.org/view/d/burnaby-dewalt-dcd771-cordless-drill/8RngeD788mznpUatTWsNF5",
      title: "Dewalt DCD771 Cordless Drill Driver Set Used",
      priceCents: 12000,
      locationText: "Metrotown",
    });
  });
});

describe("JS-rendered gallery cards (search-gallery.html)", () => {
  const listings = parseCraigslistSearch(fixture("search-gallery.html"), SEATTLE);

  it("reads every card", () => {
    expect(listings).toHaveLength(6);
    expect(listings.every((l) => l.marketplace === "craigslist" && l.currency === "USD")).toBe(true);
  });

  it("reads title, price, images, location and the absolute date from the title attribute", () => {
    expect(listings[0]).toMatchObject({
      externalId: "7779876501",
      url: "https://seattle.craigslist.org/see/bik/d/seattle-trek-marlin-mountain-bike/7779876501.html",
      title: "Trek Marlin 5 mountain bike - size M",
      priceCents: 45_000,
      imageUrls: [
        "https://images.craigslist.org/00p0p_8aB2cD3eF4g_0CI0t2_300x300.jpg",
        "https://images.craigslist.org/00Q0Q_1hI2jK3lM4n_0CI0t2_300x300.jpg",
      ],
      locationText: "Ballard",
      lat: null,
      lng: null,
    });
    expect(listings[0].postedAt?.toISOString()).toBe("2026-09-28T15:42:10.000Z");
    expect(listings[0].raw).toMatchObject({ variant: "card" });
  });

  it("resolves bare relative labels ('3h ago', '9/26') against the reference time", () => {
    expect(byId(listings, "7779876502").postedAt?.toISOString()).toBe("2026-09-28T15:00:00.000Z");
    expect(byId(listings, "7779876505").postedAt?.toISOString()).toBe("2026-09-26T12:00:00.000Z");
  });

  it("handles missing price, missing images, $0, comma prices and non-ASCII titles", () => {
    expect(byId(listings, "7779876503")).toMatchObject({ priceCents: null, imageUrls: [], locationText: "Renton" });
    expect(byId(listings, "7779876506").priceCents).toBe(0);
    expect(byId(listings, "7779876502")).toMatchObject({ priceCents: 120_000, title: 'Specialized Rockhopper 29" hardtail' });
    expect(byId(listings, "7779876505").title).toBe("Vélo de route Bianchi Via Nirone 7 – très bon état");
  });

  it("resolves relative links and protocol-relative images, and prefers lazy data-src over placeholders", () => {
    expect(byId(listings, "7779876504")).toMatchObject({
      url: "https://seattle.craigslist.org/est/bik/d/kirkland-cannondale-synapse-105/7779876504.html",
      imageUrls: ["https://images.craigslist.org/00s0s_9aZ8bY7cX6d_0CI0t2_300x300.jpg"],
    });
    expect(byId(listings, "7779876506").imageUrls).toEqual(["https://images.craigslist.org/00u0u_3kL4mN5oP6q_0CI0t2_300x300.jpg"]);
  });
});

describe("JS-rendered list rows (search-list.html)", () => {
  const listings = parseCraigslistSearch(fixture("search-list.html"), SFBAY);

  it("drops the duplicated posting", () => {
    expect(listings.map((l) => l.externalId)).toEqual(["7790001001", "7790001002", "7790001003", "7790001004"]);
  });

  it("reads time[datetime], the location span and the price inside .meta", () => {
    expect(listings[0]).toMatchObject({
      title: "MacBook Pro 14 M3 Pro 18GB/512GB",
      priceCents: 165_000,
      locationText: "mission district",
      lat: 37.7599,
      lng: -122.4148,
      imageUrls: ["https://images.craigslist.org/00v0v_mbp14m3pro_0CI0t2_600x450.jpg"],
    });
    expect(listings[0].postedAt?.toISOString()).toBe("2026-09-28T16:15:00.000Z");
    expect(byId(listings, "7790001004").priceCents).toBe(45_000);
  });

  it("ignores (0,0) coordinates and empty image lists from JSON-LD", () => {
    expect(byId(listings, "7790001003")).toMatchObject({ priceCents: null, lat: null, lng: null, imageUrls: [] });
    expect(byId(listings, "7790001002").imageUrls).toEqual([]);
  });
});

describe("JSON-LD out of sync with the HTML (search-static-partial-ld.html)", () => {
  const listings = parseCraigslistSearch(fixture("search-static-partial-ld.html"), SEATTLE);

  it("matches JSON-LD entries by title when the counts differ", () => {
    expect(listings).toHaveLength(5);
    expect(byId(listings, "7779870001")).toMatchObject({
      title: "Trek Domane AL 2 road bike 56cm",
      locationText: "Fremont",
      lat: 47.6505,
      imageUrls: [
        "https://images.craigslist.org/03030_domaneccc_0CI0t2_600x450.jpg",
        "https://images.craigslist.org/03031_domaneddd_0CI0t2_600x450.jpg",
      ],
    });
    expect(byId(listings, "7779870002").imageUrls).toEqual(["https://images.craigslist.org/01010_fuelEX8aa_0CI0t2_600x450.jpg"]);
  });

  it("leaves rows without a JSON-LD match unenriched", () => {
    expect(byId(listings, "7779870003")).toMatchObject({ title: "trek kids bike 20in", imageUrls: [], lat: null, lng: null });
  });

  it("matches titles regardless of whitespace and accepts a single image string", () => {
    expect(byId(listings, "7779870005")).toMatchObject({
      imageUrls: ["https://images.craigslist.org/04040_marlineee_0CI0t2_600x450.jpg"],
      lat: 47.8209,
    });
    expect(byId(listings, "7779870004").locationText).toBe("Bellevue, WA");
  });
});

describe("page classification", () => {
  it("returns [] for a results page with no results", () => {
    expect(parseCraigslistSearch(fixture("no-results.html"), VANCOUVER)).toEqual([]);
    const jsEmpty = page('<div class="results cl-results-page"><div class="cl-no-results">no results</div></div>');
    expect(parseCraigslistSearch(jsEmpty, VANCOUVER)).toEqual([]);
  });

  it("throws BlockedError for the IP block page and the captcha page", () => {
    expect(() => parseCraigslistSearch(fixture("blocked.html"), VANCOUVER)).toThrow(BlockedError);
    expect(() => parseCraigslistSearch(fixture("captcha.html"), VANCOUVER)).toThrow(BlockedError);
  });

  it("does not mistake a results page that mentions captcha for a challenge", () => {
    const html = fixture("search-static.html").replace("</body>", "<script>window.captchaSiteKey = 'x';</script></body>");
    expect(parseCraigslistSearch(html, VANCOUVER)).toHaveLength(9);
  });

  it("throws ParseError for an empty body or an unrecognisable page", () => {
    expect(() => parseCraigslistSearch("", VANCOUVER)).toThrow(ParseError);
    expect(() => parseCraigslistSearch("   \n", VANCOUVER)).toThrow(ParseError);
    expect(() => parseCraigslistSearch(page("<h1>Welcome to nginx!</h1>"), VANCOUVER)).toThrow(/Unrecognised Craigslist page/);
    expect(() => parseCraigslistSearch("<html><body>{\"error\":1}</body></html>", VANCOUVER)).toThrow(ParseError);
  });

  it("throws ParseError when the page lists results but no result row is recognised", () => {
    // Result rows renamed: the JSON-LD still lists all 10 results.
    const renamed = fixture("search-static.html").replaceAll('class="cl-static-search-result"', 'class="cl-search-result-static"');
    expect(() => parseCraigslistSearch(renamed, VANCOUVER)).toThrow(/lists 10 results but no result rows were recognised/);
    // Without the JSON-LD the list's own entries give it away (the "see also" entry does not count).
    const withoutLd = renamed.replace(/<script type="application\/ld\+json" id="ld_searchpage_results"[\s\S]*?<\/script>/, "");
    expect(withoutLd).not.toContain("ld_searchpage_results");
    expect(() => parseCraigslistSearch(withoutLd, VANCOUVER)).toThrow(/lists 10 results/);
  });

  it("only treats block-page text as a block when the page has no results", () => {
    const quoting = fixture("search-static.html").replaceAll(
      "PS5 Disc Edition with 2 controllers",
      "PS5 - this IP has been automatically blocked from PSN lol",
    );
    expect(parseCraigslistSearch(quoting, VANCOUVER)[0].title).toBe("PS5 - this IP has been automatically blocked from PSN lol");
    const empty = fixture("no-results.html").replace("</main>", "<p>blocks-b123@craigslist.org</p></main>");
    expect(parseCraigslistSearch(empty, VANCOUVER)).toEqual([]);
  });

  it("throws ParseError when result rows exist but none can be read", () => {
    const html = page(`<ol class="cl-static-search-results">
      <li class="cl-static-search-result"><div class="title">No link</div></li>
      <li class="cl-static-search-result"><a href="/about/help"><div class="title">Not a posting</div></a></li>
    </ol>`);
    expect(() => parseCraigslistSearch(html, VANCOUVER)).toThrow(/could not read any/);
  });
});

describe("defensive parsing", () => {
  it("skips rows that link off Craigslist or use non-http schemes", () => {
    const html = page(`<ol class="cl-static-search-results">
      <li class="cl-static-search-result"><a href="https://evil.example/x/1234567890.html"><div class="title">Phish</div></a></li>
      <li class="cl-static-search-result"><a href="javascript:alert(1)//1234567891.html"><div class="title">Script</div></a></li>
      <li class="cl-static-search-result"><a href="/van/ele/d/ok/7781111111.html"><div class="title">OK &lt;b&gt;tv&lt;/b&gt;</div><div class="price">$20</div></a></li>
    </ol>`);
    const listings = parseCraigslistSearch(html, VANCOUVER);
    expect(listings).toHaveLength(1);
    expect(listings[0]).toMatchObject({ externalId: "7781111111", title: "OK <b>tv</b>", priceCents: 2_000, currency: "CAD" });
  });

  it("skips cards whose data-pid disagrees with their link", () => {
    const html = page(`<div class="cl-results-page">
      <div class="cl-search-result" data-pid="7700000009"><a class="posting-title" href="/x/d/other/7700000001.html"><span class="label">Mismatch</span></a></div>
      <div class="cl-search-result" data-pid="7700000002"><a class="posting-title" href="/x/d/ok/7700000002.html"><span class="label">Match</span></a><span class="priceinfo">$5</span></div>
    </div>`);
    expect(parseCraigslistSearch(html, VANCOUVER).map((l) => [l.externalId, l.title, l.priceCents])).toEqual([["7700000002", "Match", 500]]);
  });

  it("pairs JSON-LD by title when the counts match but the order does not", () => {
    const ld = {
      itemListElement: [
        { position: "0", item: { name: "Beta", image: ["https://images.craigslist.org/b.jpg"], offers: { priceCurrency: "CAD" } } },
        { position: "1", item: { name: "Alpha", image: ["https://images.craigslist.org/a.jpg"], offers: { priceCurrency: "CAD" } } },
      ],
    };
    const html = page(
      `<ol class="cl-static-search-results">
        <li class="cl-static-search-result"><a href="/a/7700000001.html"><div class="title">Alpha</div></a></li>
        <li class="cl-static-search-result"><a href="/b/7700000002.html"><div class="title">Beta</div></a></li>
      </ol>`,
      `<script type="application/ld+json" id="ld_searchpage_results">${JSON.stringify(ld)}</script>`,
    );
    const [alpha, beta] = parseCraigslistSearch(html, VANCOUVER);
    expect(alpha.imageUrls).toEqual(["https://images.craigslist.org/a.jpg"]);
    expect(beta.imageUrls).toEqual(["https://images.craigslist.org/b.jpg"]);
  });

  it("keeps positions aligned when one JSON-LD entry is unreadable", () => {
    const ld = {
      itemListElement: [
        { position: "0", item: { image: ["https://images.craigslist.org/nameless.jpg"] } },
        { position: "1", item: { name: "Second", image: ["https://images.craigslist.org/second.jpg"] } },
        { position: "2", item: { name: "Third", image: ["https://images.craigslist.org/third.jpg"] } },
      ],
    };
    const html = page(
      `<ol class="cl-static-search-results">
        <li class="cl-static-search-result"><a href="/a/7700000001.html"><div class="title">First</div></a></li>
        <li class="cl-static-search-result"><a href="/b/7700000002.html"><div class="title">Second</div></a></li>
        <li class="cl-static-search-result"><a href="/c/7700000003.html"><div class="title">Third</div></a></li>
      </ol>`,
      `<script type="application/ld+json" id="ld_searchpage_results">${JSON.stringify(ld)}</script>`,
    );
    expect(parseCraigslistSearch(html, VANCOUVER).map((l) => l.imageUrls[0])).toEqual([
      undefined,
      "https://images.craigslist.org/second.jpg",
      "https://images.craigslist.org/third.jpg",
    ]);
  });

  it("ignores malformed JSON-LD", () => {
    const html = fixture("search-static.html").replace(/(<script[^>]*id="ld_searchpage_results"[^>]*>)[\s\S]*?(<\/script>)/, "$1{not json$2");
    const listings = parseCraigslistSearch(html, VANCOUVER);
    expect(listings).toHaveLength(9);
    expect(listings[0]).toMatchObject({ imageUrls: [], lat: null, currency: "CAD", priceCents: 45_000 });
  });

  it("supports the pre-2023 li.result-row layout", () => {
    const html = page(`<ul class="rows">
      <li class="result-row" data-pid="7600000001">
        <a href="https://seattle.craigslist.org/see/bik/d/old-layout/7600000001.html" class="result-image gallery"><img src="https://images.craigslist.org/old_300x300.jpg"></a>
        <div class="result-info">
          <time class="result-date" datetime="2026-09-28T10:15:00Z" title="Mon 28 Sep 10:15:00 AM">Sep 28</time>
          <h3 class="result-heading"><a href="https://seattle.craigslist.org/see/bik/d/old-layout/7600000001.html" class="result-title hdrlnk">Old layout bike</a></h3>
          <span class="result-meta"><span class="result-price">$1,100</span><span class="result-hood"> (Fremont)</span></span>
        </div>
      </li>
    </ul>`);
    expect(parseCraigslistSearch(html, SEATTLE)).toEqual([
      expect.objectContaining({
        externalId: "7600000001",
        title: "Old layout bike",
        priceCents: 110_000,
        locationText: "Fremont",
        imageUrls: ["https://images.craigslist.org/old_300x300.jpg"],
        postedAt: new Date("2026-09-28T10:15:00Z"),
      }),
    ]);
  });
});
