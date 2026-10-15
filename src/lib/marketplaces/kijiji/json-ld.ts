/** Listings from the schema.org ItemList that Kijiji embeds in its results pages. */
import type { CheerioAPI } from "cheerio";
import type { ScrapedListing } from "../../types";
import { parsePriceToCents, walkObjects } from "../http";
import { asRecord, asString, idFromUrl, imageUrls, kijijiUrl, type Candidate, type Json } from "./common";

function isItemList(obj: Json): boolean {
  const type = obj["@type"];
  return (type === "ItemList" || (Array.isArray(type) && type.includes("ItemList"))) && Array.isArray(obj.itemListElement);
}

function ldImages(value: unknown): unknown[] {
  const values = Array.isArray(value) ? value : [value];
  return values.map((v) => (typeof v === "string" ? v : (asRecord(v)?.url ?? asRecord(v)?.contentUrl)));
}

function ldCandidate(element: unknown): Candidate | null {
  const el = asRecord(element);
  const item = asRecord(el?.item) ?? el;
  const title = asString(item?.name);
  const link = kijijiUrl(asString(item?.url));
  const id = idFromUrl(link) ?? asString(item?.productID ?? item?.sku);
  if (!item || !title || !link || !id || !/^[\w-]{1,64}$/.test(id)) return null;

  const offersValue = item.offers;
  const offers = asRecord(Array.isArray(offersValue) ? offersValue[0] : offersValue);
  const priceValue = offers?.price;
  // JSON-LD prices are in dollars, unlike the Apollo state.
  const priceCents = typeof priceValue === "number" || typeof priceValue === "string" ? parsePriceToCents(priceValue) : null;
  const address = asRecord(asRecord(offers?.availableAtOrFrom)?.address);
  const locality = [asString(address?.addressLocality), asString(address?.addressRegion)].filter(Boolean).join(", ");

  const listing: ScrapedListing = {
    marketplace: "kijiji",
    externalId: id,
    url: link.href,
    title,
    priceCents,
    currency: "CAD",
    description: asString(item.description) ?? null,
    imageUrls: imageUrls(ldImages(item.image)),
    locationText: locality || null,
    postedAt: null,
    raw: { source: "json-ld", id, price: asString(priceValue) ?? null },
  };
  return { listing, featured: false };
}

/** Candidates from every schema.org ItemList in the page's JSON-LD blocks, in list order. */
export function parseJsonLdListings($: CheerioAPI): Candidate[] {
  const candidates: Candidate[] = [];
  for (const script of $('script[type="application/ld+json"]').toArray()) {
    let data: unknown;
    try {
      data = JSON.parse($(script).text());
    } catch {
      continue;
    }
    for (const obj of walkObjects(data)) {
      if (!isItemList(obj)) continue;
      for (const element of obj.itemListElement as unknown[]) {
        const candidate = ldCandidate(element);
        if (candidate) candidates.push(candidate);
      }
    }
  }
  return candidates;
}

function longer(a: string | null | undefined, b: string | null | undefined): string | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return b.length > a.length ? b : a;
}

/**
 * Fill gaps in card listings from the JSON-LD entry with the same id: cards truncate descriptions
 * and may lazy-load images, while JSON-LD has no dates or top-ad flags, so cards stay the base.
 */
export function enrichFromJsonLd(cards: Candidate[], jsonLd: Candidate[]): Candidate[] {
  const byId = new Map(jsonLd.map((c) => [c.listing.externalId, c.listing]));
  return cards.map((card) => {
    const extra = byId.get(card.listing.externalId);
    if (!extra) return card;
    const base = card.listing;
    return {
      ...card,
      listing: {
        ...base,
        priceCents: base.priceCents ?? extra.priceCents,
        description: longer(base.description, extra.description),
        imageUrls: base.imageUrls.length > 0 ? base.imageUrls : extra.imageUrls,
        locationText: base.locationText ?? extra.locationText,
      },
    };
  });
}
