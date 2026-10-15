import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RateLimitedError } from "../types";
import {
  accountLimit,
  facebookUsage,
  isRateLimitMessage,
  pickFacebookAccount,
  RATE_LIMIT_COOLDOWN_MS,
  resetFacebookBudget,
  startFacebookCooldown,
  takeFacebookRequest,
  type BudgetAccount,
} from "./budget";

const T0 = Date.parse("2026-09-30T12:00:00Z");
const solo: BudgetAccount = { key: "a", label: "Account A", share: 1 };
const old: BudgetAccount = { key: "old", label: "Old account", share: 0.35 };
const fresh: BudgetAccount = { key: "new", label: "New account", share: 0.65 };

beforeEach(() => {
  vi.stubEnv("FACEBOOK_MAX_REQUESTS_PER_HOUR", "6");
  resetFacebookBudget();
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetFacebookBudget();
});

describe("facebook request budget", () => {
  it("leaves a third of the hourly budget to searches the user is waiting on", () => {
    expect(accountLimit(1, true)).toBe(6);
    expect(accountLimit(1, false)).toBe(4);
    for (let i = 0; i < 4; i++) takeFacebookRequest(solo, false, T0 + i);
    expect(() => takeFacebookRequest(solo, false, T0 + 10)).toThrow(RateLimitedError);
    takeFacebookRequest(solo, true, T0 + 11);
    takeFacebookRequest(solo, true, T0 + 12);
    expect(() => takeFacebookRequest(solo, true, T0 + 13)).toThrow(/budget of 6 requests\/hour/);
  });

  it("says when the next slot frees, and frees it after an hour", () => {
    for (let i = 0; i < 4; i++) takeFacebookRequest(solo, false, T0 + i * 60_000);
    try {
      takeFacebookRequest(solo, false, T0 + 10 * 60_000);
      expect.unreachable();
    } catch (err) {
      expect((err as RateLimitedError).retryAfterSec).toBe(50 * 60); // the first request leaves the window at T0 + 60 min
    }
    expect(() => takeFacebookRequest(solo, false, T0 + 60 * 60_000 + 1)).not.toThrow();
  });

  it("rests an account Facebook rate-limited, interactive searches included", () => {
    const err = startFacebookCooldown(solo, T0);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect(err.retryAfterSec).toBe(RATE_LIMIT_COOLDOWN_MS / 1000);
    expect(() => takeFacebookRequest(solo, true, T0 + 60_000)).toThrow(/rate-limited Account A/);
    expect(() => takeFacebookRequest(solo, true, T0 + RATE_LIMIT_COOLDOWN_MS + 1)).not.toThrow();
  });

  it("recognises Facebook's rate-limit messages", () => {
    expect(isRateLimitMessage("Rate limit exceeded")).toBe(true);
    expect(isRateLimitMessage("You're Temporarily Blocked")).toBe(true);
    expect(isRateLimitMessage("PersistedQueryNotFound")).toBe(false);
  });
});

describe("splitting searches between accounts", () => {
  beforeEach(() => vi.stubEnv("FACEBOOK_MAX_REQUESTS_PER_HOUR", "1000"));

  it("sends each account its share of the traffic (65 / 35)", () => {
    const accounts = [old, fresh];
    for (let i = 0; i < 100; i++) takeFacebookRequest(pickFacebookAccount(accounts, false, T0 + i), false, T0 + i);
    const usage = Object.fromEntries(facebookUsage(accounts, T0 + 100).map((u) => [u.key, u.lastHour]));
    expect(usage.new).toBeGreaterThanOrEqual(64);
    expect(usage.new).toBeLessThanOrEqual(66);
    expect(usage.old + usage.new).toBe(100);
  });

  it("moves everything to the other account while one is resting", () => {
    startFacebookCooldown(fresh, T0);
    expect(pickFacebookAccount([old, fresh], false, T0 + 1).key).toBe("old");
    expect(facebookUsage([old, fresh], T0 + 1).find((u) => u.key === "new")?.restingUntil).toBe(T0 + RATE_LIMIT_COOLDOWN_MS);
  });

  it("skips accounts already tried, and fails only when none is left", () => {
    expect(pickFacebookAccount([old, fresh], true, T0, new Set(["new"])).key).toBe("old");
    startFacebookCooldown(old, T0);
    startFacebookCooldown(fresh, T0);
    expect(() => pickFacebookAccount([old, fresh], true, T0 + 1)).toThrow(/Every Facebook account is resting/);
  });
});
