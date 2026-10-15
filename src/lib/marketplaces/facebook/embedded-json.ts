/**
 * Facebook server-renders Relay query results into the page as JSON: mostly
 * `<script type="application/json" data-sjs data-content-len="…">{"require":[…]}</script>` blobs, and on
 * some page variants inline `…handle({"require":[…]})` calls inside ordinary scripts. We collect both.
 * The wrapper format is undocumented — re-verify against a live page if listings stop being found.
 */
import { load } from "cheerio";

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The JSON object/array starting at `start`, found by bracket matching that respects string literals. */
export function sliceBalancedJson(text: string, start: number): string | null {
  const open = text[start];
  if (open !== "{" && open !== "[") return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === "{" || ch === "[") {
      depth++;
    } else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Payloads of `.handle({...})` calls (ServerJS bootstrapping) inside inline JavaScript. */
function inlineHandlePayloads(script: string): unknown[] {
  const values: unknown[] = [];
  const pattern = /\.handle\(\s*(?=\{)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(script))) {
    const json = sliceBalancedJson(script, match.index + match[0].length);
    if (!json) continue;
    const value = tryParse(json);
    if (value !== undefined) values.push(value);
    pattern.lastIndex = match.index + match[0].length + json.length;
  }
  return values;
}

/** Every parseable JSON document embedded in the page. Malformed blobs are skipped, never fatal. */
export function extractEmbeddedJson(html: string): unknown[] {
  const $ = load(html);
  const values: unknown[] = [];
  $("script:not([src])").each((_, el) => {
    const type = ($(el).attr("type") ?? "").trim().toLowerCase();
    const text = $(el).text();
    if (type === "application/json") {
      const value = tryParse(text);
      if (value !== undefined) values.push(value);
    } else if ((type === "" || type === "text/javascript") && text.includes(".handle(")) {
      values.push(...inlineHandlePayloads(text));
    }
  });
  return values;
}
