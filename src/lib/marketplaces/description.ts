/**
 * The seller's full description from a single listing page. Search results only carry titles (and, on
 * Kijiji, a shortened description), which is not enough to value a vague "i7 / GTX gaming PC".
 */
import { load } from "cheerio";
import { walkObjects } from "./http";

const MAX_DESCRIPTION = 5_000;

function tidy(text: string): string | null {
  const out = text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_DESCRIPTION);
  return out || null;
}

/** Craigslist: the #postingbody section, minus its print-only QR code block. */
export function parseCraigslistDescription(html: string): string | null {
  // Each line ends in "<br>" plus a source newline: keep one line break, not two.
  const $ = load(html.replace(/<br\s*\/?>[ \t]*\r?\n/gi, "<br>"));
  const body = $("#postingbody").first();
  if (!body.length) return null;
  body.find(".print-information, .print-qrcode-container, script, style").remove();
  body.find("br").replaceWith("\n");
  return tidy(body.text());
}

/** Kijiji: the schema.org Product the listing page embeds as JSON-LD. */
export function parseKijijiDescription(html: string): string | null {
  const $ = load(html);
  for (const el of $('script[type="application/ld+json"]').toArray()) {
    let json: unknown;
    try {
      json = JSON.parse($(el).text());
    } catch {
      continue;
    }
    for (const obj of walkObjects(json)) {
      const type = obj["@type"];
      const isProduct = type === "Product" || (Array.isArray(type) && type.includes("Product"));
      if (isProduct && typeof obj.description === "string") return tidy(obj.description);
    }
  }
  return null;
}

/** Facebook: the listing's redacted_description in the item page's embedded Relay data. */
export function parseFacebookDescription(html: string): string | null {
  const match = html.match(/"redacted_description":\{"text":("(?:[^"\\]|\\.)*")/);
  if (!match) return null;
  try {
    return tidy(JSON.parse(match[1]) as string);
  } catch {
    return null;
  }
}

/** Only listing pages on the marketplace's own site are fetched (the URL comes from scraped data). */
export function isListingUrlFor(marketplace: "craigslist" | "kijiji" | "facebook", url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  if (marketplace === "craigslist") return host === "craigslist.org" || host.endsWith(".craigslist.org");
  if (marketplace === "kijiji") return host === "www.kijiji.ca" || host === "kijiji.ca";
  return (host === "www.facebook.com" || host === "facebook.com") && /^\/marketplace\/item\/\d+\/?$/.test(u.pathname);
}
