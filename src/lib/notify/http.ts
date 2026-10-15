import { NotifyError } from "./errors";
import type { SendContext } from "./types";

export interface HttpRequest {
  url: string;
  headers?: Record<string, string>;
  body: string | URLSearchParams;
}

export interface HttpResponse {
  status: number;
  text: string;
  headers: Headers;
}

export interface PostOptions {
  /** Used in error messages. Never put the URL there: webhook URLs and bot tokens are secrets. */
  service: string;
  /** Wait for Retry-After once on HTTP 429, then fail (Discord/Slack/Telegram). */
  retryOn429?: boolean;
}

const MAX_BODY_IN_ERROR = 200;

/**
 * POST through the global fetch (resolved at call time so tests can spy on it), bounded by the
 * send context's abort signal. Non-2xx responses throw NotifyError; 4xx are permanent except 408/429.
 */
export async function post(req: HttpRequest, ctx: SendContext, opts: PostOptions): Promise<HttpResponse> {
  const first = await attempt(req, ctx, opts.service);
  if (first.status !== 429 || !opts.retryOn429) return checkStatus(first, opts.service);

  const waitMs = Math.ceil((parseRetryAfter(first) ?? 1) * 1000);
  if (Date.now() + waitMs >= ctx.deadline) {
    throw new NotifyError(`${opts.service} rate limited (HTTP 429); retry after ${Math.ceil(waitMs / 1000)}s`, { status: 429 });
  }
  await (ctx.sleep ?? abortableSleep)(waitMs, ctx.signal);
  return checkStatus(await attempt(req, ctx, opts.service), opts.service);
}

async function attempt(req: HttpRequest, ctx: SendContext, service: string): Promise<HttpResponse> {
  let res: Response;
  try {
    // Following a 301/302 would silently turn the POST into a GET and drop the alert.
    res = await globalThis.fetch(req.url, { method: "POST", headers: req.headers, body: req.body, signal: ctx.signal, redirect: "manual" });
  } catch (err) {
    if (ctx.signal.aborted) throw new NotifyError(`${service} request timed out`, { cause: err });
    const code = (err as { cause?: { code?: unknown } })?.cause?.code;
    throw new NotifyError(`${service} network error${typeof code === "string" ? ` (${code})` : ""}`, { cause: err });
  }
  let text = "";
  try {
    text = await res.text();
  } catch {
    // Body unreadable (aborted mid-stream); the status code is still meaningful.
  }
  return { status: res.status, text, headers: res.headers };
}

function checkStatus(res: HttpResponse, service: string): HttpResponse {
  if (res.status >= 200 && res.status < 300) return res;
  if (res.status >= 300 && res.status < 400) {
    throw new NotifyError(`${service} URL redirects (HTTP ${res.status}); use the final URL`, { status: res.status, permanent: true });
  }
  const permanent = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429;
  const detail = describeBody(res.text);
  throw new NotifyError(`${service} returned HTTP ${res.status}${detail ? `: ${detail}` : ""}`, { status: res.status, permanent });
}

/** Pull a readable message out of common JSON error shapes, else a short text excerpt. */
export function describeBody(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  try {
    const json = JSON.parse(trimmed) as Record<string, unknown>;
    const candidate = json.description ?? json.message ?? json.error ?? (Array.isArray(json.errors) ? json.errors.join("; ") : undefined);
    if (typeof candidate === "string" && candidate.trim()) return clip(candidate);
  } catch {
    // Not JSON.
  }
  return clip(trimmed.startsWith("<") ? "" : trimmed);
}

function clip(value: string): string {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > MAX_BODY_IN_ERROR ? `${line.slice(0, MAX_BODY_IN_ERROR - 1)}…` : line;
}

/** Seconds to wait, from Discord/Telegram JSON bodies or the Retry-After header. */
function parseRetryAfter(res: HttpResponse): number | undefined {
  try {
    const json = JSON.parse(res.text) as { retry_after?: unknown; parameters?: { retry_after?: unknown } };
    const fromBody = json.retry_after ?? json.parameters?.retry_after;
    if (typeof fromBody === "number" && Number.isFinite(fromBody) && fromBody >= 0) return fromBody;
  } catch {
    // Not JSON; fall back to the header.
  }
  const header = res.headers.get("retry-after");
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, (date - Date.now()) / 1000);
}

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new NotifyError("Request timed out"));
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new NotifyError("Request timed out"));
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
