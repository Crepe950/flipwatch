import { describe, expect, it } from "vitest";
import { BlockedError, MarketplaceError, NotConfiguredError, ParseError, RateLimitedError } from "@/lib/marketplaces/types";
import { TimeoutError } from "../async";
import { backoffDelayMs, backoffUntil, classifyFailure } from "../backoff";

const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

describe("backoff", () => {
  it("classifies marketplace errors", () => {
    expect(classifyFailure(new RateLimitedError("429", "ebay"))).toBe("rate_limited");
    expect(classifyFailure(new BlockedError("403", "facebook"))).toBe("blocked");
    expect(classifyFailure(new NotConfiguredError("no creds", "ebay"))).toBe("not_configured");
    expect(classifyFailure(new ParseError("redesign", "kijiji"))).toBe("other");
    expect(classifyFailure(new TypeError("boom"))).toBe("other");
    expect(classifyFailure("string error")).toBe("other");
  });

  it("classifies by name when instanceof fails across module copies", () => {
    const foreign = Object.assign(new Error("429"), { name: "RateLimitedError" });
    expect(classifyFailure(foreign)).toBe("rate_limited");
  });

  it("honours Retry-After for rate limits, capped at 1 h", () => {
    expect(backoffDelayMs(new RateLimitedError("429", "ebay", 90), 1)).toBe(90 * SEC);
    expect(backoffDelayMs(new RateLimitedError("429", "ebay", 7.2), 1)).toBe(8 * SEC);
    expect(backoffDelayMs(new RateLimitedError("429", "ebay", 99_999), 1)).toBe(HOUR);
  });

  it("uses 2^n × 60 s for rate limits without Retry-After (max 1 h)", () => {
    expect(backoffDelayMs(new RateLimitedError("429", "ebay"), 1)).toBe(2 * MIN);
    expect(backoffDelayMs(new RateLimitedError("429", "ebay", 0), 3)).toBe(8 * MIN);
    expect(backoffDelayMs(new RateLimitedError("429", "ebay"), 10)).toBe(HOUR);
  });

  it("uses 15 min × n for blocks (max 6 h)", () => {
    expect(backoffDelayMs(new BlockedError("403", "craigslist"), 1)).toBe(15 * MIN);
    expect(backoffDelayMs(new BlockedError("403", "craigslist"), 4)).toBe(HOUR);
    expect(backoffDelayMs(new BlockedError("403", "craigslist"), 100)).toBe(6 * HOUR);
  });

  it("does not back off for configuration errors", () => {
    expect(backoffDelayMs(new NotConfiguredError("missing key", "ebay"), 5)).toBeNull();
    expect(backoffUntil(new NotConfiguredError("missing key", "ebay"), 5, new Date())).toBeNull();
  });

  it("uses 2^n × 30 s for everything else (max 30 min)", () => {
    expect(backoffDelayMs(new MarketplaceError("500", "offerup"), 1)).toBe(MIN);
    expect(backoffDelayMs(new TimeoutError(1000), 2)).toBe(2 * MIN);
    expect(backoffDelayMs(new Error("x"), 50)).toBe(30 * MIN);
    expect(backoffDelayMs(new Error("x"), 1e9)).toBe(30 * MIN);
  });

  it("treats a bogus failure count as the first failure", () => {
    expect(backoffDelayMs(new Error("x"), 0)).toBe(MIN);
    expect(backoffDelayMs(new Error("x"), Number.NaN)).toBe(MIN);
  });

  it("returns an absolute time", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    expect(backoffUntil(new BlockedError("403", "craigslist"), 1, now)?.toISOString()).toBe("2026-01-01T00:15:00.000Z");
  });
});
