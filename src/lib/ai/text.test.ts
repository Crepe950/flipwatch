import { describe, expect, it } from "vitest";
import { cleanText, countWords, limitSentences, shortItemName, stripEmoji, truncate } from "./text";

describe("cleanText", () => {
  it("removes invisible/control characters and normalises whitespace", () => {
    const zwsp = String.fromCharCode(0x200b);
    const rlo = String.fromCharCode(0x202e);
    expect(cleanText(`  a${zwsp}b${rlo}c\u0007 d \r\n\r\n\r\n\re  `)).toBe("abc d\n\ne");
    expect(cleanText(null)).toBe("");
    expect(cleanText(undefined)).toBe("");
  });

  it("caps length at a word boundary", () => {
    expect(cleanText("one two three four five", 16)).toBe("one two three…");
    expect(truncate("abcdefghij klm", 12)).toBe("abcdefghij…");
    expect(truncate("abcdefghij", 5)).toBe("abcd…");
    expect(truncate("short", 10)).toBe("short");
  });
});

describe("emoji helpers", () => {
  it("strips emoji including modifiers, flags and ZWJ sequences", () => {
    expect(stripEmoji("Hi 👍🏽 there 🇨🇦 family 👨‍👩‍👧 ok ❤️!")).toBe("Hi there family ok!");
    expect(stripEmoji("Price is 100 # 1 * 2")).toBe("Price is 100 # 1 * 2");
  });

  it("can keep the first emoji", () => {
    expect(stripEmoji("Hi 😊 thanks 🙏", 1)).toBe("Hi 😊 thanks");
  });
});

describe("limitSentences", () => {
  it("keeps the first sentences", () => {
    expect(limitSentences("A b. C d! E f? G.", 2)).toBe("A b. C d!");
    expect(limitSentences("Only one sentence", 2)).toBe("Only one sentence");
    expect(limitSentences("Costs $1.5k. Fine.", 1)).toBe("Costs $1.5k.");
  });
});

describe("shortItemName", () => {
  it("drops decoration and trailing sales talk", () => {
    expect(shortItemName("🔥🔥 PS5 DISC EDITION — MUST GO!!! 🔥🔥")).toBe("PS5 DISC EDITION");
    expect(shortItemName("iPhone 13 | 128GB | Unlocked")).toBe("iPhone 13");
    expect(shortItemName("**Trek Marlin 5** mountain bike")).toBe("Trek Marlin 5 mountain bike");
    expect(shortItemName("A - vintage chair")).toBe("A - vintage chair");
    expect(shortItemName("[NEW] Nintendo Switch OLED {OBO}")).toBe("Nintendo Switch OLED");
  });

  it("shortens long titles and never returns an empty name", () => {
    const name = shortItemName("Solid oak dining table with six matching chairs and two leaf extensions barely used");
    expect(name.length).toBeLessThanOrEqual(60);
    expect(name.endsWith("…")).toBe(false);
    expect(shortItemName("🔥🔥")).toBe("item");
    expect(shortItemName("")).toBe("item");
  });
});

describe("countWords", () => {
  it("counts whitespace-separated words", () => {
    expect(countWords("  one two\nthree ")).toBe(3);
    expect(countWords("")).toBe(0);
  });
});
