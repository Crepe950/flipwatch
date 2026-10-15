import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";
import { config } from "@/lib/config";
import { getDb } from "@/lib/db";
import { getSessionSecret } from "@/lib/session-secret";

/** The key that signs session cookies: SESSION_SECRET, or the random one stored in the database. */
export async function sessionSecret(): Promise<string> {
  return getSessionSecret(await getDb());
}

/**
 * Server-side session checks for server actions, route handlers and pages. The proxy already gates
 * requests, but actions are reachable by any POST to a page, so each one verifies again.
 */
export async function isAuthenticated(): Promise<boolean> {
  if (!config.appPassword) return true;
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return false;
  return verifySessionToken(token, Date.now(), await sessionSecret());
}

/** For server actions and pages: send unauthenticated callers to /login. */
export async function requireAuth(): Promise<void> {
  if (!(await isAuthenticated())) redirect("/login");
}

/** For route handlers: a 401 response when unauthenticated, otherwise null. */
export async function unauthorizedResponse(): Promise<Response | null> {
  if (await isAuthenticated()) return null;
  return Response.json({ error: "Unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
}
