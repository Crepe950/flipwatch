import type { AdapterContext } from "../types";
import { asArray, asObject, asString } from "../json";

/** What the last response looked like, for decisions the shared request() error classes can't express. */
export interface ResponseTrace {
  status?: number;
  /** eBay's own error message from a non-2xx body, when it sent one. */
  detail?: string;
}

/**
 * Wraps ctx.fetch so a caller can tell a 401 from a 403 (request() maps both to BlockedError)
 * and surface eBay's error message instead of a bare "HTTP 400".
 */
export function withResponseTrace(ctx: AdapterContext): { ctx: AdapterContext; trace: ResponseTrace } {
  const trace: ResponseTrace = {};
  const tracedFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const res = await ctx.fetch(input, init);
    trace.status = res.status;
    trace.detail = res.ok ? undefined : await readEbayErrorMessage(res.clone());
    return res;
  };
  return { ctx: { ...ctx, fetch: tracedFetch }, trace };
}

/**
 * eBay REST errors look like {"errors":[{"errorId":12001,"message":"…","longMessage":"…"}]};
 * the OAuth endpoint uses {"error":"invalid_client","error_description":"…"}.
 */
export async function readEbayErrorMessage(res: Response): Promise<string | undefined> {
  let body: unknown;
  try {
    body = JSON.parse(await res.text());
  } catch {
    return undefined;
  }
  const root = asObject(body);
  if (!root) return undefined;
  const first = asObject(asArray(root.errors)[0]);
  const restMessage = first && (asString(first.longMessage) ?? asString(first.message));
  if (restMessage) {
    const id = asString(first.errorId);
    return truncate(id ? `${restMessage} (errorId ${id})` : restMessage);
  }
  const oauthError = asString(root.error);
  if (oauthError) {
    const description = asString(root.error_description);
    return truncate(description ? `${oauthError}: ${description}` : oauthError);
  }
  return undefined;
}

function truncate(message: string, max = 240): string {
  return message.length > max ? `${message.slice(0, max - 1)}…` : message;
}

/** Append eBay's explanation to a classified error without changing its class or retry semantics. */
export function withDetail<E>(err: E, trace: ResponseTrace): E {
  if (err instanceof Error && trace.detail && !err.message.includes(trace.detail)) {
    err.message = `${err.message}: ${trace.detail}`;
  }
  return err;
}
