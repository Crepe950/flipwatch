import type { Cheerio, CheerioAPI } from "cheerio";
import type { Element } from "domhandler";
import { cleanText, isRelativeDateLabel, parseAbsoluteDate, parseRelativeDate } from "./text";

/** One search result as read from the HTML, before validation/normalisation. */
export interface CraigslistRow {
  variant: "static" | "card";
  href: string | null;
  pid: string | null;
  title: string;
  priceText: string;
  locationText: string;
  postedAt: Date | null;
  /** Raw src values; resolved and filtered later. */
  imageSrcs: string[];
}

/** First non-empty match, trying selectors in priority order (a selector union would use document order). */
function firstMatch(scope: Cheerio<Element>, selectors: string[]): Cheerio<Element> | undefined {
  for (const selector of selectors) {
    const found = scope.find(selector).first();
    if (found.length) return found;
  }
  return undefined;
}

function firstText(scope: Cheerio<Element>, selectors: string[]): string {
  for (const selector of selectors) {
    const text = cleanText(scope.find(selector).first().text());
    if (text) return text;
  }
  return "";
}

/** Variant 1: the no-JS list, `ol.cl-static-search-results > li.cl-static-search-result`. */
export function readStaticRows($: CheerioAPI): CraigslistRow[] {
  return $("li.cl-static-search-result")
    .toArray()
    .map((el) => {
      const li = $(el);
      return {
        variant: "static",
        href: li.find("a[href]").first().attr("href") ?? null,
        pid: li.attr("data-pid") ?? null,
        title: cleanText(li.find(".title").first().text()) || cleanText(li.attr("title")),
        priceText: cleanText(li.find(".price").first().text()),
        locationText: cleanText(li.find(".location").first().text()),
        postedAt: null,
        imageSrcs: [],
      };
    });
}

const CARD_SELECTOR = "div.cl-search-result[data-pid], li.cl-search-result, li.result-row[data-pid]";
const LINK_SELECTORS = ["a.posting-title[href]", "a.titlestring[href]", "a.result-title[href]", "a.main[href]", "a[href]"];
const TITLE_SELECTORS = [".posting-title .label", ".posting-title", ".titlestring", ".result-title"];
const PRICE_SELECTORS = [".priceinfo", ".price", ".result-price"];
const LOCATION_SELECTORS = [".meta .location", ".location", ".result-hood"];

/**
 * Split a card's `.meta` line ("3h ago · Burnaby · $650") into its parts. Dates may be bare
 * relative text or an element carrying an absolute date in `datetime`/`title`.
 */
function readMeta($: CheerioAPI, card: Cheerio<Element>, now: Date): { location: string; postedAt: Date | null } {
  const meta = card.find(".meta").first();
  if (!meta.length) return { location: "", postedAt: null };

  const clone = meta.clone();
  let postedAt: Date | null = null;
  for (const el of clone.find("time, [title], [datetime]").toArray()) {
    const node = $(el);
    const date = parseAbsoluteDate(node.attr("datetime")) ?? parseAbsoluteDate(node.attr("title"));
    if (!date) continue;
    postedAt ??= date;
    node.replaceWith("|");
  }
  clone.find("button, svg, img, .priceinfo, .price, .separator").replaceWith("|");

  const parts = clone
    .text()
    .split(/[|•·]/)
    .map(cleanText)
    .filter(Boolean);
  const relative = parts.find(isRelativeDateLabel);
  if (!postedAt && relative) postedAt = parseRelativeDate(relative, now);
  return { location: parts.find((p) => !isRelativeDateLabel(p)) ?? "", postedAt };
}

/** Variant 2: JS-rendered gallery/list cards (and the pre-2023 `li.result-row` layout). */
export function readCardRows($: CheerioAPI, now: Date): CraigslistRow[] {
  return $(CARD_SELECTOR)
    .toArray()
    .map((el) => {
      const card = $(el);
      const meta = readMeta($, card, now);
      const time = card.find("time[datetime]").first();
      const location = firstText(card, LOCATION_SELECTORS).replace(/^\((.*)\)$/, "$1").trim();
      const imageSrcs = card
        .find("img")
        .toArray()
        // Lazy-loaded images keep the real URL in data-src and a placeholder in src.
        .map((img) => $(img).attr("data-src") || $(img).attr("src") || "")
        .filter((src) => src && !src.startsWith("data:"));

      return {
        variant: "card",
        href: firstMatch(card, LINK_SELECTORS)?.attr("href") ?? null,
        pid: card.attr("data-pid") ?? null,
        title: firstText(card, TITLE_SELECTORS) || cleanText(card.attr("title")),
        priceText: firstText(card, PRICE_SELECTORS),
        locationText: location || meta.location,
        postedAt: parseAbsoluteDate(time.attr("datetime")) ?? meta.postedAt,
        imageSrcs,
      };
    });
}
