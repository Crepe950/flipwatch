import { describe, expect, it } from "vitest";
import { parseKijijiDate } from "./dates";

const NOW = new Date("2026-09-28T18:00:00Z");

describe("parseKijijiDate", () => {
  it.each([
    ["just now", "2026-09-28T18:00:00.000Z"],
    ["< 1 minute ago", "2026-09-28T17:59:00.000Z"],
    ["<9 minutes ago", "2026-09-28T17:51:00.000Z"],
    ["an hour ago", "2026-09-28T17:00:00.000Z"],
    ["3 hours ago", "2026-09-28T15:00:00.000Z"],
    ["a day ago", "2026-09-27T18:00:00.000Z"],
    ["2 days ago", "2026-09-26T18:00:00.000Z"],
    ["Yesterday", "2026-09-27T18:00:00.000Z"],
    ["27/09/2026", "2026-09-27T12:00:00.000Z"],
    ["1/2/2026", "2026-02-01T12:00:00.000Z"],
    ["2026-09-28T09:12:44.000Z", "2026-09-28T09:12:44.000Z"],
  ])("%s", (label, expected) => {
    expect(parseKijijiDate(label, NOW)?.toISOString()).toBe(expected);
  });

  it("returns null for unknown or impossible dates", () => {
    expect(parseKijijiDate("31/02/2026", NOW)).toBeNull();
    expect(parseKijijiDate("Toronto", NOW)).toBeNull();
    expect(parseKijijiDate("", NOW)).toBeNull();
    expect(parseKijijiDate(null, NOW)).toBeNull();
  });
});
