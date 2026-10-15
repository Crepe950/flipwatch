import { describe, expect, it } from "vitest";
import { cleanText, escapeDiscord, escapeHtml, escapeSlack, fitLines, fitRendered, slackLinkUrl, truncate } from "../escape";
import { HOSTILE_TITLE } from "./fixtures";

describe("escaping", () => {
  it("escapes HTML including quotes", () => {
    expect(escapeHtml(HOSTILE_TITLE)).toBe("&lt;b&gt;x&lt;/b&gt; &amp; *y* @everyone");
    expect(escapeHtml(`"a" 'b'`)).toBe("&quot;a&quot; &#39;b&#39;");
  });

  it("escapes Discord markdown, masked links and mentions", () => {
    expect(escapeDiscord(HOSTILE_TITLE)).toBe("\\<b\\>x\\</b\\> & \\*y\\* \\@everyone");
    expect(escapeDiscord("[click](https://evil.example) `code` ||spoiler|| ~~s~~ __u__")).toBe(
      "\\[click\\]\\(https://evil.example\\) \\`code\\` \\|\\|spoiler\\|\\| \\~\\~s\\~\\~ \\_\\_u\\_\\_",
    );
    expect(escapeDiscord("# heading")).toBe("\\# heading");
    expect(escapeDiscord("1. first")).toBe("1\\. first");
    expect(escapeDiscord("a\\b")).toBe("a\\\\b");
  });

  it("escapes Slack control characters only", () => {
    expect(escapeSlack(HOSTILE_TITLE)).toBe("&lt;b&gt;x&lt;/b&gt; &amp; *y* @everyone");
    expect(escapeSlack("<!channel> <@U123>")).toBe("&lt;!channel&gt; &lt;@U123&gt;");
    expect(slackLinkUrl("https://x.test/a?b=1&c=2|<>")).toBe("https://x.test/a?b=1&amp;c=2%7C%3C%3E");
  });

  it("cleans control and bidi characters into single-line text", () => {
    expect(cleanText("  PS5\n\tDigital‮gpj.exe\u0000 ")).toBe("PS5 Digital gpj.exe");
    expect(cleanText(null)).toBe("");
  });
});

describe("truncate", () => {
  it("keeps short strings and adds an ellipsis within the limit", () => {
    expect(truncate("hello", 10)).toBe("hello");
    const cut = truncate("hello world", 8);
    expect(cut).toBe("hello w…");
    expect(cut.length).toBeLessThanOrEqual(8);
    expect(truncate("abc", 0)).toBe("");
  });

  it("never splits a surrogate pair", () => {
    const cut = truncate("ab😀cd", 4);
    expect(cut).toBe("ab…");
    expect(() => encodeURIComponent(cut)).not.toThrow();
  });
});

describe("fitLines / fitRendered", () => {
  it("truncates the overflowing line before escaping so entities are never cut", () => {
    const out = fitLines(["short", "&&&&&&&&&&&&&&&&&&&&"], 30, escapeHtml);
    expect(out.length).toBeLessThanOrEqual(30);
    expect(out.startsWith("short\n")).toBe(true);
    expect(out).toMatch(/^short\n(&amp;)+…$/);
  });

  it("drops lines after the one that overflows", () => {
    expect(fitLines(["aaaa", "bbbbbbbbbb", "c"], 10, (s) => s)).toBe("aaaa\nbbbb…");
  });

  it("keeps only whole rendered lines", () => {
    expect(fitRendered(["<a>1</a>", "<a>2</a>", "<a>3</a>"], 20)).toBe("<a>1</a>\n<a>2</a>");
  });
});
