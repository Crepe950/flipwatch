/** Minimal prefixed logger so engine output is easy to grep in web and worker logs. */
export const log = {
  info: (message: string, ...rest: unknown[]) => console.log(`[engine] ${message}`, ...rest),
  warn: (message: string, ...rest: unknown[]) => console.warn(`[engine] ${message}`, ...rest),
  error: (message: string, ...rest: unknown[]) => console.error(`[engine] ${message}`, ...rest),
};

/**
 * A short, human-readable message for any thrown value. For wrapped errors the innermost cause wins:
 * drizzle's "Failed query: <sql> params: …" hides the database's actual reason ("deadlock detected"),
 * and fetch's "fetch failed" hides the network error.
 */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    let inner: Error = err;
    for (let depth = 0; depth < 5 && inner.cause instanceof Error && inner.cause !== inner; depth++) inner = inner.cause;
    return inner.message || err.message || inner.name;
  }
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return String(err);
  }
}
