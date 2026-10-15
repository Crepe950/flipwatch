/**
 * Escaping and truncation helpers. Marketplace text (titles, seller names, AI summaries quoting
 * them) is untrusted and must be escaped for every target format.
 */

// C0/C1 control characters and Unicode bidi overrides/isolates (used for filename/title spoofing).
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** Collapse whitespace/control characters into single spaces. Always returns a single line. */
export function cleanText(value: string | null | undefined): string {
  if (!value) return "";
  return value.replace(UNSAFE_CHARS, " ").replace(/\s+/g, " ").trim();
}

/** Cut to at most `max` UTF-16 units, ending with "…", without splitting a surrogate pair. */
export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  if (max <= 0) return "";
  let end = max - 1;
  const code = value.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return `${value.slice(0, end).trimEnd()}…`;
}

/** HTML text and attribute escaping (Telegram HTML, Pushover html=1, email). */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => HTML_ENTITIES[c]);
}

const HTML_ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * Discord markdown escaping: neutralises emphasis, code, spoilers, masked links, headings,
 * quotes, list markers and mention syntax (<@id>, @everyone) by backslash-escaping.
 */
export function escapeDiscord(value: string): string {
  return value.replace(/[\\*_~`|[\]()<>#@-]/g, "\\$&").replace(/^(\d+)\./gm, "$1\\.");
}

/** Slack mrkdwn: only &, < and > are control characters (they form links and mentions). */
export function escapeSlack(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** A URL safe to embed in Slack's <url|label> syntax. */
export function slackLinkUrl(url: string): string {
  return url.replace(/&/g, "&amp;").replace(/\|/g, "%7C").replace(/</g, "%3C").replace(/>/g, "%3E");
}

/**
 * Escape and join plain-text lines within `max` characters. The line that overflows is truncated
 * before escaping (so no entity or escape sequence is ever cut in half); later lines are dropped.
 */
export function fitLines(lines: string[], max: number, escape: (value: string) => string, sep = "\n"): string {
  let out = "";
  for (const line of lines) {
    const prefix = out ? sep : "";
    const escaped = escape(line);
    if (out.length + prefix.length + escaped.length <= max) {
      out += prefix + escaped;
      continue;
    }
    const room = max - out.length - prefix.length;
    let limit = room;
    let shortened = escape(truncate(line, limit));
    while (shortened.length > room && limit > 1) {
      // Escaping expands text; shrink proportionally, but always by at least one character.
      limit = Math.min(limit - 1, Math.floor((limit * room) / shortened.length));
      shortened = escape(truncate(line, limit));
    }
    if (shortened && shortened.length <= room) out += prefix + shortened;
    break;
  }
  return out;
}

/** Join pre-rendered markup lines within `max` characters, keeping only whole lines. */
export function fitRendered(lines: string[], max: number, sep = "\n"): string {
  let out = "";
  for (const line of lines) {
    const next = out ? `${out}${sep}${line}` : line;
    if (next.length > max) break;
    out = next;
  }
  return out;
}
