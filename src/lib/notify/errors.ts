/** A delivery failure. `permanent` failures (bad config, 4xx) won't succeed on retry within this run. */
export class NotifyError extends Error {
  readonly permanent: boolean;
  readonly status?: number;

  constructor(message: string, opts: { permanent?: boolean; status?: number; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "NotifyError";
    this.permanent = opts.permanent ?? false;
    this.status = opts.status;
  }
}

/** The channel (or the server env it relies on) is missing required configuration. */
export class ChannelNotConfiguredError extends NotifyError {
  constructor(message: string) {
    super(message, { permanent: true });
    this.name = "ChannelNotConfiguredError";
  }
}

export class NotifyTimeoutError extends NotifyError {
  constructor(ms: number) {
    super(`Timed out after ${ms >= 1000 ? `${Math.round(ms / 1000)}s` : `${ms}ms`}`);
    this.name = "NotifyTimeoutError";
  }
}

export function isPermanent(err: unknown): boolean {
  return err instanceof NotifyError && err.permanent;
}

/** Human-readable, single-line error message capped for storage in notification_log / lastError. */
export function errorMessage(err: unknown, max = 500): string {
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : "Unknown error";
  const line = raw.replace(/\s+/g, " ").trim() || "Unknown error";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Look up a required config value, throwing a permanent error naming the missing field. */
export function requireConfig(config: Record<string, string>, key: string, label: string): string {
  const value = typeof config[key] === "string" ? config[key].trim() : "";
  if (!value) throw new ChannelNotConfiguredError(`Missing ${label}`);
  return value;
}

/** Validate a user-configured http(s) URL. */
export function requireHttpUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ChannelNotConfiguredError(`${label} is not a valid URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ChannelNotConfiguredError(`${label} must start with https://`);
  }
  return url;
}
