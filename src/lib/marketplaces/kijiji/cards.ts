/** Server-rendered listing cards on a Kijiji results page (current and legacy markup). */
import type { Cheerio, CheerioAPI } from "cheerio";
import type { Element } from "domhandler";
import type { ScrapedListing } from "../../types";
import { parsePriceToCents } from "../http";
import { cleanText, idFromUrl, imageUrls, kijijiUrl, viewUrl, type Candidate } from "./common";
import { parseKijijiDate } from "./dates";

const CARD_SELECTOR = '[data-testid="listing-card"], div.search-item[data-listing-id]';
const LINK_SELECTORS = ['a[data-testid="listing-link"][href]', "a.title[href]", ".title a[href]", "a[href]"];
const TITLE_SELECTORS = ['[data-testid="listing-title"]', '[data-testid="listing-link"]', "a.title", ".title"];
const PRICE_SELECTORS = ['[data-testid="listing-price"]', ".price"];
const LOCATION_SELECTORS = ['[data-testid="listing-location"]', ".location > span:not(.date-posted)", ".location"];
const DATE_SELECTORS = ['[data-testid="listing-date"]', ".date-posted"];
const DESCRIPTION_SELECTORS = ['[data-testid="listing-description"]', ".description"];

function firstText(scope: Cheerio<Element>, selectors: string[]): string {
  for (const selector of selectors) {
    const text = cleanText(scope.find(selector).first().text());
    if (text) return text;
  }
  return "";
}

function firstHref(scope: Cheerio<Element>, selectors: string[]): string | undefined {
  for (const selector of selectors) {
    const href = scope.find(selector).first().attr("href");
    if (href) return href;
  }
  return undefined;
}

function isFeaturedCard(card: Cheerio<Element>): boolean {
  return (
    card.hasClass("top-feature") ||
    card.attr("data-top-ad") === "true" ||
    card.find('[data-testid="listing-card-top-ad"], [data-testid*="top-ad"]').length > 0
  );
}

export interface CardResult {
  candidates: Candidate[];
  /** Cards found, parseable or not (distinguishes "no results" from "markup changed"). */
  cardCount: number;
}

/** Server-rendered cards: current `[data-testid="listing-card"]` and legacy `div.search-item`. */
export function parseListingCards($: CheerioAPI, now: Date): CardResult {
  const cards = $(CARD_SELECTOR).toArray();
  const candidates: Candidate[] = [];
  for (const el of cards) {
    const card = $(el);
    const link = kijijiUrl(firstHref(card, LINK_SELECTORS) ?? card.attr("data-vip-url"));
    const linkId = idFromUrl(link);
    const id = cleanText(card.attr("data-listingid") ?? card.attr("data-listing-id")) || linkId;
    const title = firstText(card, TITLE_SELECTORS);
    if (!id || !/^[\w-]{1,64}$/.test(id) || !title) continue;
    // A link naming another ad (e.g. a fallback match on a seller link) is not this card's.
    const url = link && linkId === id ? link.href : viewUrl(id);

    const dateText = firstText(card, DATE_SELECTORS) || card.find("time[datetime]").first().attr("datetime") || "";
    let location = firstText(card, LOCATION_SELECTORS);
    const legacyDate = cleanText(card.find(".location .date-posted").first().text());
    if (legacyDate && location.endsWith(legacyDate)) location = location.slice(0, -legacyDate.length).trim();
    const priceText = firstText(card, PRICE_SELECTORS);
    const images = card
      .find("img")
      .toArray()
      .map((img) => $(img).attr("data-src") || $(img).attr("src"));

    const featured = isFeaturedCard(card);
    const listing: ScrapedListing = {
      marketplace: "kijiji",
      externalId: id,
      url,
      title,
      priceCents: parsePriceToCents(priceText),
      currency: "CAD",
      description: firstText(card, DESCRIPTION_SELECTORS) || null,
      imageUrls: imageUrls(images),
      locationText: location || null,
      postedAt: parseKijijiDate(dateText, now),
      raw: { source: "card", id, price: priceText || null, date: dateText || null, featured },
    };
    candidates.push({ listing, featured });
  }
  return { candidates, cardCount: cards.length };
}
