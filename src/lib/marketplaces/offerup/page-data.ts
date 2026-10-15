/**
 * Pulls the embedded app state out of an offerup.com HTML page. OfferUp's web app is a Next.js site:
 * pages-router builds ship one `script#__NEXT_DATA__` JSON blob; app-router builds stream React Server
 * Component rows through `self.__next_f.push([1, "…"])`. We read both so a framework migration on
 * their side doesn't silently empty our results. Re-verify against a live page when results dry up.
 */
import { load } from "cheerio";

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** JSON values from RSC flight rows (`<id>:<json>` lines). Non-JSON rows (imports, text chunks) are skipped. */
function parseFlightRows(payload: string): unknown[] {
  const values: unknown[] = [];
  for (const line of payload.split("\n")) {
    const match = /^[0-9a-f]+:(?=[[{])(.*)$/.exec(line);
    if (!match) continue;
    const value = tryParse(match[1]);
    if (value !== undefined) values.push(value);
  }
  return values;
}

/** Every JSON value embedded in the page, or [] when there is none (e.g. a bot-challenge page). */
export function readOfferUpPageData(html: string): unknown[] {
  const $ = load(html);
  const nextData = tryParse($("script#__NEXT_DATA__").first().text());
  if (nextData !== undefined) return [nextData];

  let flight = "";
  $("script:not([src])").each((_, el) => {
    const text = $(el).text().trim();
    if (!text.startsWith("self.__next_f.push(")) return;
    const args = tryParse(text.slice("self.__next_f.push(".length, text.lastIndexOf(")")));
    if (Array.isArray(args) && args[0] === 1 && typeof args[1] === "string") flight += args[1];
  });
  return flight ? parseFlightRows(flight) : [];
}
