import Anthropic from "@anthropic-ai/sdk";

/** Thrown when ANTHROPIC_API_KEY is missing. Callers can show a "configure AI" hint instead of an error. */
export class AiNotConfiguredError extends Error {
  constructor() {
    super("AI is not set up yet: choose an AI engine in Settings → AI (a Claude or OpenAI API key, or Claude Code / Codex on this computer).");
    this.name = "AiNotConfiguredError";
  }
}

/** A failed or unusable Claude request. The message is short, user-presentable and never contains secrets. */
export class AiRequestError extends Error {
  readonly status: number | null;
  readonly type: string | null;

  constructor(message: string, opts: { status?: number | null; type?: string | null; cause?: unknown } = {}) {
    super(message, { cause: opts.cause });
    this.name = "AiRequestError";
    this.status = opts.status ?? null;
    this.type = opts.type ?? null;
  }
}

const MAX_DETAIL_LENGTH = 160;

/** Remove anything that looks like a credential before a message leaves this module. */
export function redactSecrets(text: string): string {
  return text
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{16,}/g, "[redacted]")
    .replace(/(x-api-key|authorization)\s*[:=]\s*(?:bearer\s+)?\S+/gi, "$1: [redacted]");
}

function apiErrorDetail(err: InstanceType<typeof Anthropic.APIError>): string | null {
  const body = err.error as { error?: { message?: unknown } } | undefined;
  const message = body?.error?.message;
  if (typeof message !== "string" || !message.trim()) return null;
  const oneLine = redactSecrets(message.replace(/\s+/g, " ").trim());
  return oneLine.length > MAX_DETAIL_LENGTH ? `${oneLine.slice(0, MAX_DETAIL_LENGTH - 1)}…` : oneLine;
}

/** Map any error thrown while talking to Claude to a concise AiRequestError (idempotent). */
export function toAiError(err: unknown): Error {
  if (err instanceof AiRequestError || err instanceof AiNotConfiguredError) return err;
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return new AiRequestError("Claude API request timed out", { cause: err });
  }
  if (err instanceof Anthropic.APIUserAbortError) {
    return new AiRequestError("Claude API request was aborted", { cause: err });
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new AiRequestError("Could not reach the Claude API", { cause: err });
  }
  if (err instanceof Anthropic.APIError) {
    const status = typeof err.status === "number" ? err.status : null;
    const type = err.type ?? null;
    const head = ["Claude API error", status, type].filter((part) => part !== null).join(" ");
    const detail = apiErrorDetail(err);
    return new AiRequestError(detail ? `${head}: ${detail}` : head, { status, type, cause: err });
  }
  if (err instanceof Error) return err;
  return new AiRequestError(`Unexpected AI error: ${redactSecrets(String(err)).slice(0, MAX_DETAIL_LENGTH)}`);
}
