/**
 * What to tell the user when a server action or API request fails without an answer (it threw):
 * the device is offline, the session expired (the password gate answers API requests with 401), or
 * the server had a problem. Client-side helpers; safe to import anywhere.
 */
import { unstable_rethrow } from "next/navigation";

export type FailureKind = "offline" | "session" | "server";

/** An error to show next to the control that failed, with a sign-in link when the session is gone. */
export interface ActionFailure {
  message: string;
  signInHref?: string;
}

/** A cheap request behind the password gate: 401 once the session cookie is missing or expired. */
export const SESSION_PROBE_URL = "/api/feed?limit=1";

/** Classify a failed request by probing the server once. */
export async function diagnoseFailure(fetchImpl: typeof fetch = fetch): Promise<FailureKind> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return "offline";
  try {
    const res = await fetchImpl(SESSION_PROBE_URL, { cache: "no-store" });
    return res.status === 401 ? "session" : "server";
  } catch {
    return "offline";
  }
}

/** /login that comes back to `next` (a same-origin path) after signing in. */
export function signInHref(next: string): string {
  return next && next !== "/" ? `/login?next=${encodeURIComponent(next)}` : "/login";
}

/** "Couldn't move the deal" + why. */
export function failureFor(kind: FailureKind, fallback: string, next: string): ActionFailure {
  if (kind === "session") return { message: `${fallback}: your session expired. Sign in again to continue.`, signInHref: signInHref(next) };
  if (kind === "offline") return { message: `${fallback}: you're offline. Check your connection and try again.` };
  return { message: `${fallback}. Try again in a moment.` };
}

/**
 * For the `catch` of a server action call: re-throws Next.js redirects (an action that redirects
 * rejects with one), otherwise works out why the call failed.
 */
export async function describeActionError(error: unknown, fallback: string, fetchImpl: typeof fetch = fetch): Promise<ActionFailure> {
  unstable_rethrow(error);
  const next = typeof window === "undefined" ? "/" : `${window.location.pathname}${window.location.search}`;
  return failureFor(await diagnoseFailure(fetchImpl), fallback, next);
}

/**
 * Wraps a server action for useActionState: when the call throws instead of answering (offline,
 * session expired, server error), the new state is `onFailure(why)`. Otherwise the error would reach
 * the error boundary, replacing the page and everything typed into the form. Next.js redirects (an
 * action that redirects rejects with one) still go through.
 */
export function catchActionFailure<S, P>(
  action: (state: S, payload: P) => Promise<S>,
  fallback: string,
  onFailure: (failure: ActionFailure) => S,
): (state: S, payload: P) => Promise<S> {
  return async (state, payload) => {
    try {
      return await action(state, payload);
    } catch (error) {
      return onFailure(await describeActionError(error, fallback));
    }
  };
}
