import { config } from "../../config";

/**
 * One fixed desktop Chrome identity. The session cookie belongs to a real browser, so rotating user agents
 * between polls (as the generic scraper helper does) would look like session hijacking to Facebook.
 */
const CHROME_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36";

/** Exactly what Chrome 154 sends (the GREASE brand and the order change with every major version). */
const CHROME_CLIENT_HINTS: Record<string, string> = {
  "Sec-CH-UA": '"Chromium";v="154", "Google Chrome";v="154", "Not A(Brand";v="99"',
  "Sec-CH-UA-Mobile": "?0",
  "Sec-CH-UA-Platform": '"Windows"',
};

/** Headers of a top-level navigation typed into the address bar of a logged-in browser. */
export function facebookNavigationHeaders(cookies: string): Record<string, string> {
  const pinned = config.scraperUserAgent;
  return {
    "User-Agent": pinned ?? CHROME_USER_AGENT,
    // Client hints must match the UA; only send ours when we're also sending our UA.
    ...(pinned ? {} : CHROME_CLIENT_HINTS),
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    Cookie: cookies,
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
  };
}

/** Headers of the Marketplace page's own GraphQL requests (same browser identity as the navigation). */
export function facebookGraphqlHeaders(cookies: string, lsd: string, operation: string, referer: string): Record<string, string> {
  const pinned = config.scraperUserAgent;
  return {
    "User-Agent": pinned ?? CHROME_USER_AGENT,
    ...(pinned ? {} : CHROME_CLIENT_HINTS),
    Accept: "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Content-Type": "application/x-www-form-urlencoded",
    Cookie: cookies,
    Origin: "https://www.facebook.com",
    Referer: referer,
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "X-FB-Friendly-Name": operation,
    "X-FB-LSD": lsd,
  };
}
