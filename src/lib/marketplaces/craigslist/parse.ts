/**
 * Craigslist search-results parser: pure (HTML string in, listings out), no I/O.
 *
 * Supported markup variants — selectors were written from saved pages and MUST be re-verified
 * against the live site whenever results drop to zero or ParseErrors start appearing:
 *  1. No-JS static list (what plain HTTP clients receive):
 *     ol.cl-static-search-results > li.cl-static-search-result > a[href] with div.title, div.price,
 *     div.location. Carries no images or dates.
 *  2. JS-rendered gallery/list cards (e.g. a page saved from a browser):
 *     div.cl-search-result[data-pid] / li.cl-search-result with a.posting-title or a.main,
 *     span.priceinfo / .price, and .meta holding the location and a time[datetime] or [title] date
 *     (or a bare "3h ago" label). The pre-2023 li.result-row layout is covered by fallback selectors.
 *  3. JSON-LD script#ld_searchpage_results (schema.org ItemList). It has no URLs or ids, so it only
 *     enriches rows from 1/2 with images, coordinates, locality and currency — matched by position
 *     when the counts line up, otherwise by exact title.
 *
 * Outcomes: recognised results page with zero rows → []; IP-block or captcha page (only considered
 * when there is no results markup, so a listing quoting the block page can't trip it) → BlockedError;
 * unrecognised page, result rows none of which can be read, or a page that advertises results
 * (JSON-LD entries, static result items) without any recognisable row → ParseError.
 */
import { load, type CheerioAPI } from "cheerio";
import type { ScrapedListing } from "../../types";
import { parsePriceToCents } from "../http";
import { BlockedError, ParseError } from "../types";
import { matchJsonLd, readSearchJsonLd, type CraigslistLdItem } from "./json-ld";
import { readCardRows, readStaticRows, type CraigslistRow } from "./rows";

export interface ParseCraigslistOptions {
  /** Site origin used to resolve relative links, e.g. https://vancouver.craigslist.org */
  origin: string;
  /** Currency when the page does not state one (CAD for Canadian sites, else USD). */
  currency: string;
  /** Reference time for relative dates ("3h ago"); defaults to the current time. */
  now?: Date;
}

/** Craigslist's block page. Only checked on pages without results: listing titles can quote it. */
const BLOCK_PATTERNS = [/This IP has been automatically blocked/i, /<title>\s*blocked\s*<\/title>/i, /blocks-[\w.-]*@craigslist\.org/i];
/** Only trusted when the page has no results markup (scripts on normal pages may mention these). */
const CHALLENGE_PATTERNS = [/captcha/i, /verify (that )?you are (a )?human/i, /unusual (traffic|activity)/i];
const RESULTS_CONTAINER = "ol.cl-static-search-results, .cl-search-results, .cl-results-page, #search-results, .cl-no-results, script#ld_searchpage_results";
/** Entries of the static results list other than the "see also" links shown on every page. */
const STATIC_RESULT_ITEMS = "ol.cl-static-search-results > li:not(.cl-static-hub-links)";
const POSTING_ID = /\/(\d{6,})\.html$/;
/** Posting links since 2026: https://www.craigslist.org/view/d/<slug>/<opaque id>, no numeric id. */
const VIEW_POSTING_ID = /^\/view\/d\/[^/]+\/([A-Za-z0-9]{8,})\/?$/;

export function parseCraigslistSearch(html: string, opts: ParseCraigslistOptions): ScrapedListing[] {
  if (typeof html !== "string" || !html.trim()) throw new ParseError("Empty response from Craigslist", "craigslist");

  const $ = load(html);
  const staticRows = readStaticRows($);
  const rows = staticRows.length > 0 ? staticRows : readCardRows($, opts.now ?? new Date());
  if (rows.length === 0) return emptyOrError($, html);

  const ld = matchJsonLd(rows, readSearchJsonLd($));
  const seen = new Set<string>();
  const listings: ScrapedListing[] = [];
  rows.forEach((row, i) => {
    const listing = toListing(row, ld[i], opts);
    if (!listing || seen.has(listing.externalId)) return;
    seen.add(listing.externalId);
    listings.push(listing);
  });

  if (listings.length === 0) {
    throw new ParseError(`Found ${rows.length} Craigslist result rows but could not read any (markup changed?)`, "craigslist");
  }
  return listings;
}

function emptyOrError($: CheerioAPI, html: string): ScrapedListing[] {
  // A page that lists results we can't find rows for changed its markup: saying "no results" would hide that.
  const advertised = Math.max(readSearchJsonLd($).length, $(STATIC_RESULT_ITEMS).length);
  if (advertised > 0) {
    throw new ParseError(`Craigslist page lists ${advertised} results but no result rows were recognised (markup changed?)`, "craigslist");
  }
  if ($(RESULTS_CONTAINER).length > 0) return [];
  if (BLOCK_PATTERNS.some((re) => re.test(html))) {
    throw new BlockedError("Craigslist has blocked this IP address", "craigslist");
  }
  if (CHALLENGE_PATTERNS.some((re) => re.test(html))) {
    throw new BlockedError("Craigslist answered with a captcha/verification page", "craigslist");
  }
  const title = $("title").first().text().trim().slice(0, 80);
  throw new ParseError(`Unrecognised Craigslist page${title ? ` ("${title}")` : ""}`, "craigslist");
}

/** Resolve a link against the site and keep it only if it is an http(s) Craigslist URL. */
function listingUrl(href: string | null, origin: string): URL | null {
  if (!href) return null;
  try {
    const url = new URL(href.trim(), origin);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return host === "craigslist.org" || host.endsWith(".craigslist.org") ? url : null;
  } catch {
    return null;
  }
}

function imageUrls(srcs: string[], origin: string): string[] {
  const urls: string[] = [];
  for (const src of srcs) {
    try {
      const url = new URL(src.trim(), origin);
      if (url.protocol === "https:" || url.protocol === "http:") urls.push(url.href);
    } catch {
      // ignore unparseable src
    }
  }
  return [...new Set(urls)];
}

function toListing(row: CraigslistRow, ld: CraigslistLdItem | undefined, opts: ParseCraigslistOptions): ScrapedListing | null {
  const url = listingUrl(row.href, opts.origin);
  const urlId = url?.pathname.match(POSTING_ID)?.[1];
  const viewId = urlId ? undefined : url?.pathname.match(VIEW_POSTING_ID)?.[1];
  const pid = row.pid?.trim();
  // A data-pid that disagrees with the link means the link belongs to something else. /view/ links
  // carry an opaque id that can't be compared with the numeric data-pid.
  const externalId = urlId && (!pid || pid === urlId) ? urlId : viewId;
  const title = row.title || ld?.name || "";
  if (!url || !externalId || !title) return null;

  const rowImages = imageUrls(row.imageSrcs, opts.origin);
  return {
    marketplace: "craigslist",
    externalId,
    url: url.href,
    title,
    priceCents: parsePriceToCents(row.priceText) ?? ld?.priceCents ?? null,
    currency: ld?.currency ?? opts.currency,
    imageUrls: ld?.imageUrls.length ? ld.imageUrls : rowImages,
    locationText: row.locationText || ld?.locationText || null,
    lat: ld?.lat ?? null,
    lng: ld?.lng ?? null,
    postedAt: row.postedAt,
    raw: {
      variant: row.variant,
      pid: externalId,
      price: row.priceText || null,
      location: row.locationText || null,
      jsonLd: ld ? { name: ld.name, currency: ld.currency, images: ld.imageUrls.length } : null,
    },
  };
}
