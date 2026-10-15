/** Text helpers for untrusted marketplace content and model output. */

// Zero-width and bidi-control characters can hide or reorder text shown to the model or the user.
const INVISIBLE_CHARS = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;
// Control characters other than tab and newline.
const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F]/g;
const EMOJI = /\p{Extended_Pictographic}(?:\p{Emoji_Modifier}|\uFE0F|\u200D\p{Extended_Pictographic})*|\p{Regional_Indicator}{2}/gu;
const EMOJI_MODIFIERS = /[\uFE0F\u200D\u{1F3FB}-\u{1F3FF}]/gu;

/** Strip invisible/control characters, normalise newlines and trim. Optionally cap the length. */
export function cleanText(value: string | null | undefined, maxLength?: number): string {
  if (!value) return "";
  const cleaned = value
    .replace(/\r\n?/g, "\n")
    .replace(INVISIBLE_CHARS, "")
    .replace(CONTROL_CHARS, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return maxLength !== undefined ? truncate(cleaned, maxLength) : cleaned;
}

/** Cut at a word boundary when possible and append an ellipsis. */
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const slice = text.slice(0, Math.max(0, maxLength - 1));
  const lastSpace = slice.lastIndexOf(" ");
  const cut = lastSpace > maxLength * 0.6 ? slice.slice(0, lastSpace) : slice;
  return `${cut.trimEnd()}…`;
}

export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

/** Remove emoji, optionally keeping the first `keep` of them. */
export function stripEmoji(text: string, keep = 0): string {
  let seen = 0;
  const result = text.replace(EMOJI, (match) => (seen++ < keep ? match : ""));
  return (keep === 0 ? result.replace(EMOJI_MODIFIERS, "") : result).replace(/[ \t]{2,}/g, " ").replace(/ +([,.!?])/g, "$1").trim();
}

/** Keep at most `max` sentences (split after ., ! or ? followed by whitespace). */
export function limitSentences(text: string, max: number): string {
  const sentences = text.trim().split(/(?<=[.!?])\s+/);
  return sentences.length <= max ? text.trim() : sentences.slice(0, max).join(" ");
}

/**
 * A short, human way to refer to the item in a message to the seller. Listing titles are often
 * shouty or keyword-stuffed ("🔥 PS5 DISC — MUST GO!!! 🔥", "iPhone 13 | 128GB | Unlocked"), so keep
 * the part before the first separator and drop emoji and decoration.
 */
export function shortItemName(title: string, maxLength = 60): string {
  const trimEdges = (text: string) => text.replace(/^[\s\-–—,:;.!/]+|[\s\-–—,:;.!/]+$/gu, "");
  const cleaned = trimEdges(
    stripEmoji(cleanText(title))
      .replace(/\[[^\]]*\]|\{[^}]*\}/g, " ") // "[NEW]", "{OBO}" tags would read like placeholders
      .replace(/\s+/g, " "),
  );
  const [head] = cleaned.split(/\s+[-–—•]\s+|\s*\|\s*/u);
  const name = trimEdges((head.length >= 3 ? head : cleaned).replace(/[*~|#_=<>^]+/g, " ").replace(/\s+/g, " "));
  if (!name) return "item";
  return trimEdges(truncate(name, maxLength).replace(/…$/, ""));
}

/**
 * Candidate ids ("(c4)", "c12") the model sometimes leaks into prose despite being told not to. An id in
 * brackets just tags something already described, so it goes; a bare id stands for the listing itself,
 * so it becomes that listing's name from `names` (dropped when unknown).
 */
export function stripCandidateIds(text: string, names?: ReadonlyMap<string, string>): string {
  return text
    .replace(/\s*\((?:c\d+(?:\s*,\s*)?)+\)/g, "")
    .replace(/\bc\d+\b/g, (id) => names?.get(id) ?? "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ +([,.;:!?])/g, "$1")
    .trim();
}