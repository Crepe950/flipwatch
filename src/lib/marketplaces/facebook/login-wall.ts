/**
 * Signs that Facebook answered with a login wall, checkpoint or temporary block instead of Marketplace.
 * Each returns a short noun phrase naming what was served ("login page"), or null.
 * Page-content checks only run when no listings were found.
 */

/** Redirected (or linked) to /login or /checkpoint — the session cookies are no longer accepted. */
export function loginRedirectReason(finalUrl: string): string | null {
  let path: string;
  try {
    path = new URL(finalUrl).pathname.toLowerCase();
  } catch {
    return null;
  }
  if (path.startsWith("/login")) return "login redirect";
  if (path.startsWith("/checkpoint")) return "security checkpoint redirect";
  return null;
}

const PAGE_SIGNS: Array<[RegExp, string]> = [
  [/<title[^>]*>\s*Log\s*in(?:\s*to)?\s+Facebook/i, "login page"],
  [/<title[^>]*>[^<]*(?:log in or sign up)/i, "login page"],
  [/<title[^>]*>[^<]*(?:Security Check|Checkpoint)/i, "security checkpoint"],
  [/You(?:'|’|&#039;|&#x27;)re Temporarily Blocked/i, "temporary block"],
  [/<form[^>]+id="login_form"/i, "login form"],
  [/<form[^>]+action="[^"]*\/login(?:\/|\.php)/i, "login form"],
  [/<form[^>]+action="[^"]*\/checkpoint\//i, "security checkpoint"],
  // <meta http-equiv="refresh" content="0; URL=/login/?next=…">, served instead of an HTTP redirect.
  [/<meta[^>]+http-equiv=["']?refresh["']?[^>]*url=[^"'>]*\/login\b/i, "login redirect"],
  [/<meta[^>]+http-equiv=["']?refresh["']?[^>]*url=[^"'>]*\/checkpoint\b/i, "security checkpoint redirect"],
];

export function loginWallReason(html: string): string | null {
  for (const [pattern, reason] of PAGE_SIGNS) {
    if (pattern.test(html)) return reason;
  }
  return null;
}
