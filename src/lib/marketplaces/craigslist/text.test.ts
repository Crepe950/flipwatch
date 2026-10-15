import { describe, expect, it } from "vitest";
import { isRelativeDateLabel, parseAbsoluteDate, parseRelativeDate, titleKey } from "./text";

const NOW = new Date("2026-09-28T18:00:00Z");
const iso = (d: Date | null) => d?.toISOString() ?? null;

describe("parseRelativeDate", () => {
  it.each([
    ["just now", "2026-09-28T18:00:00.000Z"],
    ["45s ago", "2026-09-28T17:59:15.000Z"],
    ["12m ago", "2026-09-28T17:48:00.000Z"],
    ["3h ago", "2026-09-28T15:00:00.000Z"],
    ["2 hours ago", "2026-09-28T16:00:00.000Z"],
    ["2d ago", "2026-09-26T18:00:00.000Z"],
    ["9/26", "2026-09-26T12:00:00.000Z"],
    ["9/29", "2026-09-29T12:00:00.000Z"],
    // More than a day in the future means last year's date.
    ["12/31", "2025-12-31T12:00:00.000Z"],
  ])("%s", (label, expected) => {
    expect(isRelativeDateLabel(label)).toBe(true);
    expect(iso(parseRelativeDate(label, NOW))).toBe(expected);
  });

  it("rejects impossible or unknown labels", () => {
    expect(parseRelativeDate("2/30", NOW)).toBeNull();
    expect(parseRelativeDate("13/01", NOW)).toBeNull();
    expect(parseRelativeDate("Ballard", NOW)).toBeNull();
    expect(isRelativeDateLabel("Capitol Hill")).toBe(false);
  });
});

describe("parseAbsoluteDate", () => {
  it("parses ISO timestamps and Date#toString output", () => {
    expect(iso(parseAbsoluteDate("2026-09-28T09:15:00-07:00"))).toBe("2026-09-28T16:15:00.000Z");
    expect(iso(parseAbsoluteDate("Mon Sep 28 2026 08:42:10 GMT-0700 (Pacific Daylight Time)"))).toBe("2026-09-28T15:42:10.000Z");
  });

  it("refuses strings without a year rather than letting Date.parse guess", () => {
    expect(parseAbsoluteDate("Mon 28 Sep 10:15:00 AM")).toBeNull();
    expect(parseAbsoluteDate("add to favorites list")).toBeNull();
    expect(parseAbsoluteDate(undefined)).toBeNull();
  });
});

describe("titleKey", () => {
  it("ignores case, whitespace runs and Unicode normalisation form", () => {
    expect(titleKey("  Trek Marlin 7  - XL ")).toBe(titleKey("trek marlin 7 - xl"));
    expect(titleKey("Vélo")).toBe(titleKey("Vélo"));
  });
});
