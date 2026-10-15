import { config } from "../../config";
import type { AdapterContext, AdapterStatus } from "../types";
import { accountLimit, facebookUsage, type BudgetAccount } from "./budget";

const RISK =
  "Facebook Marketplace has no public API: FlipWatch can only read it through a logged-in browser session, " +
  "which is against Meta's Terms of Service and can get the account checkpointed, restricted or banned. " +
  "If you opt in, use a secondary account you can afford to lose.";

export const DISABLED_MESSAGE =
  `Off. ${RISK} To use it anyway, open Settings → Facebook, confirm the risk, and connect your account.`;

export const MISSING_COOKIES_MESSAGE =
  "Facebook is turned on but no account is connected: open Settings → Facebook and click “Connect Facebook” to log in.";

export const INVALID_COOKIES_MESSAGE =
  "The saved Facebook session contains characters that can't be sent (often from a truncated copy-paste). " +
  "Reconnect it in Settings → Facebook.";

export const REFRESH_COOKIES_HINT =
  "Your Facebook session is no longer accepted — open Settings → Facebook and click “Reconnect Facebook” " +
  "(clear any security check on facebook.com first).";
/**
 * A single-line Cookie header value. Accepts a pasted "Cookie: …" line and strips line breaks that would
 * otherwise make the header invalid.
 */
export function normalizeCookieHeader(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const value = raw
    .replace(/[\r\n]+/g, " ")
    .trim()
    .replace(/^cookie:\s*/i, "")
    .trim();
  return value || undefined;
}

/** Context credentials win; the environment is the fallback for hand-built contexts. */
export function resolveFacebookCookies(ctx?: AdapterContext): string | undefined {
  return normalizeCookieHeader(ctx?.credentials.facebookCookies) ?? normalizeCookieHeader(config.facebookCookies);
}

export interface FacebookAccount extends BudgetAccount {
  cookies: string;
}

/**
 * The accounts to search with and their traffic shares (normalized to sum to 1). A context that brings its
 * own cookies (tests, hand-built contexts) uses just those.
 */
export function facebookAccounts(ctx?: AdapterContext): FacebookAccount[] {
  const own = normalizeCookieHeader(ctx?.credentials.facebookCookies);
  if (own) return [{ key: "context", label: "the Facebook account", share: 1, cookies: own }];
  const configured = config.facebookAccountCookies
    .map(({ slot, cookies }) => ({ slot, cookies: normalizeCookieHeader(cookies) }))
    .filter((a): a is { slot: number; cookies: string } => Boolean(a.cookies));
  const shares = config.facebookAccountShares;
  const weights = configured.map(({ slot }) => (Number.isFinite(shares[slot - 1]) ? shares[slot - 1] : Number.NaN));
  // Accounts without a valid share get the average of the others (or equal shares when none are set).
  const known = weights.filter(Number.isFinite);
  const fallback = known.length ? known.reduce((a, b) => a + b, 0) / known.length : 1;
  const filled = weights.map((w) => (Number.isFinite(w) ? w : fallback));
  const sum = filled.reduce((a, b) => a + b, 0) || 1;
  return configured.map(({ slot, cookies }, i) => ({
    key: `account-${slot}`,
    label: `Facebook account ${slot}`,
    share: filled[i] / sum,
    cookies,
  }));
}

/** fetch() rejects header values outside printable ASCII, so catch them as a config problem, not a network error. */
export function isSendableCookieHeader(cookies: string): boolean {
  return /^[\x20-\x7e\t]+$/.test(cookies);
}

/** Facebook's session is carried by c_user (account id) and xs (session secret). */
export function hasSessionCookies(cookies: string): boolean {
  const names = new Set(cookies.split(";").map((part) => part.split("=", 1)[0].trim()));
  return names.has("c_user") && names.has("xs");
}

export function facebookStatus(): AdapterStatus {
  if (!config.facebookEnabled) return { ok: false, message: DISABLED_MESSAGE };
  const accounts = facebookAccounts();
  if (accounts.length === 0) return { ok: false, message: MISSING_COOKIES_MESSAGE };
  const unsendable = accounts.find((a) => !isSendableCookieHeader(a.cookies));
  if (unsendable) return { ok: false, message: `${unsendable.label}: ${INVALID_COOKIES_MESSAGE}` };
  const loggedOut = accounts.filter((a) => !hasSessionCookies(a.cookies)).map((a) => a.label);
  const warning = loggedOut.length ? ` Warning: ${loggedOut.join(", ")} has no c_user/xs cookies, so it is probably not a logged-in session.` : "";
  const usage = new Map(facebookUsage(accounts).map((u) => [u.key, u]));
  const split = accounts
    .map((a) => {
      const u = usage.get(a.key);
      const resting = u?.restingUntil ? `, resting ${Math.ceil((u.restingUntil - Date.now()) / 60_000)} min` : "";
      return `${a.label} ${Math.round(a.share * 100)}% (${u?.lastHour ?? 0}/${accountLimit(a.share, true)} requests in the last hour${resting})`;
    })
    .join("; ");
  return {
    ok: true,
    message:
      `Enabled with ${accounts.length === 1 ? "one account" : `${accounts.length} accounts`}: ${split}. This breaks Meta's Terms of ` +
      `Service and risks the accounts being restricted or banned; searches are capped per account per hour.${warning}`,
  };
}
