import { describe, expect, it } from "vitest";
import {
  filtersToSearchParams,
  hasActiveFilters,
  parseFeedQueryLenient,
  parseFeedQueryStrict,
  queryToFilters,
  typedAfterNavigation,
} from "@/components/feed/filter-params";
import { DEFAULT_FEED_FILTERS } from "@/lib/queries/feed";

describe("feed query params", () => {
  it("parses and coerces valid params", () => {
    const r = parseFeedQueryStrict(
      new URLSearchParams("search=3&marketplace=kijiji&event=price_drop&score=60&initial=0&dismissed=1&q=%20aeron%20&limit=20&since=2026-09-28T12:00:00.000Z"),
    );
    expect(r.success).toBe(true);
    expect(r.data).toEqual({
      search: 3,
      marketplace: "kijiji",
      event: "price_drop",
      score: 60,
      initial: false,
      dismissed: true,
      q: "aeron",
      limit: 20,
      since: "2026-09-28T12:00:00.000Z",
    });
  });

  it("treats blank values as absent and takes the first of repeated values", () => {
    const r = parseFeedQueryStrict({ search: "", marketplace: ["ebay", "kijiji"], q: "   " });
    expect(r.success).toBe(true);
    expect(r.data).toEqual({ marketplace: "ebay" });
  });

  it("rejects invalid values in strict mode", () => {
    for (const qs of [
      "search=abc",
      "search=-1",
      "marketplace=amazon",
      "event=sold",
      "score=101",
      "initial=maybe",
      "limit=0",
      "limit=1000",
      "since=yesterday",
      `q=${"x".repeat(101)}`,
    ]) {
      expect(parseFeedQueryStrict(new URLSearchParams(qs)).success, qs).toBe(false);
    }
  });

  it("drops only the invalid params in lenient mode", () => {
    expect(parseFeedQueryLenient({ search: "abc", marketplace: "ebay", score: "500" })).toEqual({ marketplace: "ebay" });
    expect(parseFeedQueryLenient({})).toEqual({});
  });

  it("maps to filters with defaults and serialises back canonically", () => {
    expect(queryToFilters({})).toEqual({ ...DEFAULT_FEED_FILTERS });
    const filters = queryToFilters(parseFeedQueryLenient({ search: "2", event: "new", initial: "false", q: "ps5" }));
    expect(filters).toMatchObject({ searchId: 2, event: "new", includeInitial: false, includeDismissed: false, q: "ps5" });
    expect(filtersToSearchParams(filters).toString()).toBe("search=2&event=new&initial=0&q=ps5");
    expect(hasActiveFilters(filters)).toBe(true);
    expect(hasActiveFilters(DEFAULT_FEED_FILTERS)).toBe(false);
  });
});

describe("title search box vs. the URL", () => {
  it("keeps typed text when the navigation is its own debounced search", () => {
    expect(typedAfterNavigation("ps5", "ps5")).toBe("ps5");
    // Trailing space still being typed: the URL has the trimmed query.
    expect(typedAfterNavigation("ps5 ", "ps5")).toBe("ps5 ");
    expect(typedAfterNavigation("", "")).toBe("");
  });

  it("follows Back, the Feed link and search chips instead of pushing the old text back", () => {
    expect(typedAfterNavigation("ps5", "")).toBeNull();
    expect(typedAfterNavigation("ps5", "aeron")).toBeNull();
    expect(typedAfterNavigation(null, "ps5")).toBeNull();
  });
});
