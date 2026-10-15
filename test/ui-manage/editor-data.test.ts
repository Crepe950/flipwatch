import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { skipReasonsFor } from "@/app/searches/editor-data";
import { describeLastError, NOT_SET_UP } from "@/components/searches/run-messages";
import { DISABLED_MESSAGE } from "@/lib/marketplaces/facebook/settings";

beforeEach(() => {
  vi.stubEnv("FACEBOOK_ENABLED", "");
  vi.stubEnv("EBAY_CLIENT_ID", "");
  vi.stubEnv("EBAY_CLIENT_SECRET", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("skipReasonsFor", () => {
  it("knows which marketplaces can't run for a country, in short words", () => {
    const reasons = skipReasonsFor("CA");
    expect(reasons.get("facebook")).toEqual({ reason: DISABLED_MESSAGE, short: NOT_SET_UP });
    expect(reasons.get("ebay")?.short).toBe(NOT_SET_UP);
    expect(reasons.get("offerup")).toEqual({ reason: "OfferUp does not serve CA", short: "OfferUp does not serve CA" });
    expect(reasons.has("craigslist")).toBe(false);
    expect(reasons.has("kijiji")).toBe(false);
  });

  it("turns a stored Facebook setup paragraph into a short skip, not an error", () => {
    const lastError = `craigslist: Backing off until 2026-09-28T22:15:17.730Z (Blocked (403) by craigslist); facebook: ${DISABLED_MESSAGE}`;
    expect(describeLastError(lastError, skipReasonsFor("CA")).map((i) => [i.marketplace, i.kind, i.text])).toEqual([
      ["craigslist", "backoff", "Blocked (403) by craigslist"],
      ["facebook", "skipped", NOT_SET_UP],
    ]);
  });
});
