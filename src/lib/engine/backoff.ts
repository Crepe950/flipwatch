/** How long to leave a marketplace alone after a failure. Shared by all searches via marketplace_health. */
import { BlockedError, NotConfiguredError, RateLimitedError } from "../marketplaces/types";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

export type FailureKind = "rate_limited" | "blocked" | "not_configured" | "other";

// `name` checks keep classification working if an error crosses a module-duplication boundary.
export function classifyFailure(err: unknown): FailureKind {
  if (err instanceof RateLimitedError || (err instanceof Error && err.name === "RateLimitedError")) return "rate_limited";
  if (err instanceof BlockedError || (err instanceof Error && err.name === "BlockedError")) return "blocked";
  if (err instanceof NotConfiguredError || (err instanceof Error && err.name === "NotConfiguredError")) return "not_configured";
  return "other";
}

/** Exponential step, with the exponent clamped so huge failure counts can't overflow. */
function exponential(baseMs: number, failures: number, maxMs: number): number {
  return Math.min(maxMs, baseMs * 2 ** Math.min(Math.max(failures, 1), 20));
}

/**
 * Backoff duration in ms after the `failures`-th consecutive failure, or null for "don't back off".
 * - RateLimitedError → Retry-After when given, else 2^n × 60 s (max 1 h)
 * - BlockedError → 15 min × n (max 6 h)
 * - NotConfiguredError → none (only lastError is recorded; the fix is a config change, not waiting)
 * - anything else → 2^n × 30 s (max 30 min)
 */
export function backoffDelayMs(err: unknown, failures: number): number | null {
  const n = Math.max(1, Math.floor(failures) || 1);
  switch (classifyFailure(err)) {
    case "rate_limited": {
      const retryAfter = (err as RateLimitedError).retryAfterSec;
      if (typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter > 0) {
        return Math.min(HOUR, Math.ceil(retryAfter) * SECOND);
      }
      return exponential(MINUTE, n, HOUR);
    }
    case "blocked":
      return Math.min(6 * HOUR, 15 * MINUTE * n);
    case "not_configured":
      return null;
    default:
      return exponential(30 * SECOND, n, 30 * MINUTE);
  }
}

export function backoffUntil(err: unknown, failures: number, now: Date): Date | null {
  const delay = backoffDelayMs(err, failures);
  return delay === null ? null : new Date(now.getTime() + delay);
}
