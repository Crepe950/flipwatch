/**
 * Keeps FlipWatch's Facebook traffic within what a person's account can do without Facebook throttling
 * Marketplace search for that account (which also breaks search in the user's own app — Sep 2026: ~1,700
 * searches in a day got the account "Rate limit exceeded").
 *
 * - Traffic is spread over the configured accounts by their share (e.g. 65 % / 35 %): each search goes to the
 *   account furthest below its share, so over an hour the split matches.
 * - Each account has its own rolling hourly budget (its share of FACEBOOK_MAX_REQUESTS_PER_HOUR), counting
 *   page loads and API calls alike. Scheduled polling may only use two thirds of it, so a Deal Hunt or price
 *   check the user asks for still has room.
 * - When Facebook says an account is rate limited, that account rests for a cool-down; the others carry on.
 */
import { config } from "../../config";
import { RateLimitedError } from "../types";

const HOUR_MS = 3_600_000;
/** How long to leave an account alone after Facebook rate-limits it. */
export const RATE_LIMIT_COOLDOWN_MS = 2 * HOUR_MS;

/** An account as far as the budget is concerned: a stable key and its share of the traffic (0–1). */
export interface BudgetAccount {
  key: string;
  label: string;
  share: number;
}

const state = globalThis as unknown as {
  __flipwatchFbAccountRequests?: Map<string, number[]>;
  __flipwatchFbAccountCooldowns?: Map<string, number>;
};
const requests = () => (state.__flipwatchFbAccountRequests ??= new Map<string, number[]>());
const cooldowns = () => (state.__flipwatchFbAccountCooldowns ??= new Map<string, number>());

/** This account's hourly limit: its share of the total, two thirds of that for scheduled polling. */
export function accountLimit(share: number, interactive: boolean): number {
  const total = Math.max(1, Math.round(config.facebookMaxRequestsPerHour * share));
  return interactive ? total : Math.max(1, Math.floor((total * 2) / 3));
}

/** Test hook. */
export function resetFacebookBudget(): void {
  requests().clear();
  cooldowns().clear();
}

function recentRequests(key: string, now: number): number[] {
  const recent = (requests().get(key) ?? []).filter((t) => now - t < HOUR_MS);
  requests().set(key, recent);
  return recent;
}

/** Why `account` can't take a request now (and when it can), or null when it can. */
function unavailable(account: BudgetAccount, interactive: boolean, now: number): { message: string; retryAfterSec: number } | null {
  const until = cooldowns().get(account.key) ?? 0;
  if (now < until) {
    return {
      message: `Facebook rate-limited ${account.label}; resting it for another ${Math.ceil((until - now) / 60_000)} min`,
      retryAfterSec: Math.ceil((until - now) / 1000),
    };
  }
  const recent = recentRequests(account.key, now);
  const limit = accountLimit(account.share, interactive);
  if (recent.length < limit) return null;
  // The slot frees when the oldest request that counts against this limit leaves the window.
  const oldest = recent[recent.length - limit];
  const retryAfterSec = Math.max(60, Math.ceil((oldest + HOUR_MS - now) / 1000));
  return {
    message: `${account.label}'s Facebook budget of ${limit} requests/hour${interactive ? "" : " for scheduled searches"} is used up (protects the account); next slot in ${Math.ceil(retryAfterSec / 60)} min`,
    retryAfterSec,
  };
}

/**
 * The account the next search should use: of those not resting and with budget left, the one with the
 * fewest recent requests relative to its share. Throws RateLimitedError (the scheduler then backs off
 * Facebook until `retryAfterSec`) when none can. `exclude`: accounts already tried for this search.
 */
export function pickFacebookAccount<T extends BudgetAccount>(
  accounts: readonly T[],
  interactive: boolean,
  now = Date.now(),
  exclude: ReadonlySet<string> = new Set(),
): T {
  let best: T | null = null;
  let bestLoad = Infinity;
  const reasons: Array<{ message: string; retryAfterSec: number }> = [];
  for (const account of accounts) {
    if (exclude.has(account.key)) continue;
    const reason = unavailable(account, interactive, now);
    if (reason) {
      reasons.push(reason);
      continue;
    }
    const load = (recentRequests(account.key, now).length + 1) / Math.max(account.share, 0.001);
    if (load < bestLoad) {
      best = account;
      bestLoad = load;
    }
  }
  if (best) return best;
  const soonest = reasons.sort((a, b) => a.retryAfterSec - b.retryAfterSec)[0];
  throw new RateLimitedError(
    soonest ? (reasons.length > 1 ? `Every Facebook account is resting or out of budget: ${soonest.message}` : soonest.message) : "No Facebook account available",
    "facebook",
    soonest?.retryAfterSec,
  );
}

/** Count one request against `account`, or throw RateLimitedError when it can't take one now. */
export function takeFacebookRequest(account: BudgetAccount, interactive: boolean, now = Date.now()): void {
  const reason = unavailable(account, interactive, now);
  if (reason) throw new RateLimitedError(reason.message, "facebook", reason.retryAfterSec);
  recentRequests(account.key, now).push(now);
}

/** Facebook said `account` is rate limited: rest it for a while (the others keep going). */
export function startFacebookCooldown(account: BudgetAccount, now = Date.now()): RateLimitedError {
  cooldowns().set(account.key, now + RATE_LIMIT_COOLDOWN_MS);
  return new RateLimitedError(
    `Facebook rate-limited ${account.label} (too many searches); resting it for ${RATE_LIMIT_COOLDOWN_MS / 60_000} min`,
    "facebook",
    RATE_LIMIT_COOLDOWN_MS / 1000,
  );
}

/** Requests each account made in the last hour (for Settings). */
export function facebookUsage(accounts: readonly BudgetAccount[], now = Date.now()): Array<{ key: string; lastHour: number; restingUntil: number | null }> {
  return accounts.map((a) => {
    const until = cooldowns().get(a.key) ?? 0;
    return { key: a.key, lastHour: recentRequests(a.key, now).length, restingUntil: until > now ? until : null };
  });
}

/** Whether a Facebook error message means the account is being rate limited. */
export function isRateLimitMessage(message: string): boolean {
  return /rate limit|too many requests|temporarily (blocked|limited|restricted)|try again later|you're going too fast/i.test(message);
}
