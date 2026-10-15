/**
 * Kijiji search-results parser: pure (HTML string in, listings out), no I/O.
 *
 * Sources, tried in order. Selectors and state paths were written from saved pages and MUST be
 * re-verified against the live site whenever results drop to zero or ParseErrors start appearing:
 *  1. Next.js page state: script#__NEXT_DATA__ → props.pageProps.__APOLLO_STATE__, a normalised
 *     Apollo cache with entries like "StandardListing:123" / "AutosListing:…" / "RealEstateListing:…"
 *     ({ id, title, description, url, imageUrls[], price { amount (CENTS), type }, location { name,
 *     address, coordinates }, activationDate, sortingDate, flags { topAd } }). Walked defensively
 *     because the nesting changes between releases; when a `searchResults…` object exists only
 *     listings reachable from it count. Sorted newest (bump date) first.
 *  2. Server-rendered cards: [data-testid="listing-card"] (2023+) and legacy
 *     div.search-item[data-listing-id] with title link, price, location, date and description,
 *     gaps filled from the JSON-LD entry with the same id.
 *  3. JSON-LD schema.org ItemList alone (prices in dollars, no dates).
 * Top-ad/featured copies of a listing are dropped in favour of the organic copy (same id).
 * Price types: FIXED → amount, FREE/GIVE_AWAY → 0, CONTACT/SWAP_TRADE → null. Currency is always CAD.
 *
 * Outcomes: explicit zero-results page, an empty search-results object in the page state, or a
 * results container without listings → []; Cloudflare/bot-challenge page (only considered when the
 * page has no results, so listing text quoting one can't trip it) → BlockedError; unrecognised
 * page, cards none of which can be read, or a search-results object listing results none of which
 * can be read (from the state, cards or JSON-LD) → ParseError.
 */
import { load, type CheerioAPI } from "cheerio";
import type { ScrapedListing } from "../../types";
import { BlockedError, ParseError } from "../types";
import { parseApolloState, readNextData } from "./apollo";
import { parseListingCards } from "./cards";
import { dedupeCandidates, type Candidate } from "./common";
import { enrichFromJsonLd, parseJsonLdListings } from "./json-ld";

export interface ParseKijijiOptions {
  /** Reference time for relative card dates ("3 hours ago"); defaults to the current time. */
  now?: Date;
}

/** Markers of challenge/deny pages. Only checked on pages without results: listing text can quote them. */
const BLOCK_PATTERNS = [
  /<title>\s*Just a moment\.\.\.\s*<\/title>/i,
  /window\._cf_chl_opt/,
  /Attention Required! \| Cloudflare/i,
  /id="cf-error-details"/i,
  /Pardon Our Interruption/i,
  /<title>\s*Access Denied\s*<\/title>/i,
  /<title>\s*Access to this page has been denied/i,
];
/** Only trusted when the page has no results markup (normal pages may reference these in scripts). */
const CHALLENGE_PATTERNS = [/captcha/i, /verify (that )?you are (a )?human/i, /are you a robot/i, /unusual (traffic|activity)/i];
/** "We didn't find any results" blocks. Listings shown alongside them are suggestions, not results. */
const ZERO_RESULTS = ['[data-testid="srp-zero-results"]', '[data-testid="srp-no-results"]', "div.no-results"].join(", ");
const RESULTS_CONTAINER = ['[data-testid="srp-search-list"]', '[data-testid="srp-results"]', "div.container-results"].join(", ");

/** Newest bump first; undated listings keep their relative order at the end (sort is stable). */
function byNewest(candidates: Candidate[]): Candidate[] {
  return [...candidates].sort((a, b) => {
    if (a.sortTime === undefined || b.sortTime === undefined) {
      return a.sortTime === b.sortTime ? 0 : a.sortTime === undefined ? 1 : -1;
    }
    return b.sortTime - a.sortTime;
  });
}

function toListings(candidates: Candidate[]): ScrapedListing[] {
  return dedupeCandidates(candidates).map((c) => c.listing);
}

export function parseKijijiSearch(html: string, opts: ParseKijijiOptions = {}): ScrapedListing[] {
  if (typeof html !== "string" || !html.trim()) throw new ParseError("Empty response from Kijiji", "kijiji");

  const $ = load(html);
  const zeroResults = $(ZERO_RESULTS).length > 0;
  const nextData = readNextData($);
  const apollo = nextData === undefined ? undefined : parseApolloState(nextData);
  // Results the search-results object lists but none of which could be read: the state's shape
  // changed. The cards or JSON-LD may still be readable, so try them before giving up.
  const unreadable = apollo?.isSearchPage && apollo.candidates.length === 0 ? apollo.advertisedCount : 0;
  // A search-results object in the page state is authoritative, even when empty (cards next to an
  // empty result are suggestions). Listing-shaped state found elsewhere is only trusted when the
  // page does not say it has no results.
  if (apollo && unreadable === 0 && (apollo.isSearchPage || (apollo.candidates.length > 0 && !zeroResults))) {
    return byNewest(dedupeCandidates(apollo.candidates)).map((c) => c.listing);
  }
  if (zeroResults) return [];

  const jsonLd = parseJsonLdListings($);
  const cards = parseListingCards($, opts.now ?? new Date());
  if (cards.candidates.length > 0) return toListings(enrichFromJsonLd(cards.candidates, jsonLd));
  if (jsonLd.length > 0) return toListings(jsonLd);
  if (cards.cardCount > 0) {
    throw new ParseError(`Found ${cards.cardCount} Kijiji listing cards but could not read any (markup changed?)`, "kijiji");
  }
  if (unreadable > 0) {
    throw new ParseError(`Kijiji page state lists ${unreadable} results but none could be read (page state changed?)`, "kijiji");
  }

  if ($(RESULTS_CONTAINER).length > 0) return [];
  return unrecognised($, html);
}

function unrecognised($: CheerioAPI, html: string): never {
  if (BLOCK_PATTERNS.some((re) => re.test(html))) {
    throw new BlockedError("Kijiji answered with a bot-protection challenge", "kijiji");
  }
  if (CHALLENGE_PATTERNS.some((re) => re.test(html))) {
    throw new BlockedError("Kijiji answered with a captcha/verification page", "kijiji");
  }
  const title = $("title").first().text().trim().slice(0, 80);
  throw new ParseError(`Unrecognised Kijiji page${title ? ` ("${title}")` : ""}`, "kijiji");
}
