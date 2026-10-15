import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, decideAccess, loginRedirectPath } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { guardRequest } from "@/lib/request-guard";
import { getSessionSecret } from "@/lib/session-secret";

/**
 * Optional password gate (APP_PASSWORD). Server actions and route handlers verify the session again
 * themselves.
 *
 * The cookie's HMAC is checked here in full, not just its presence: pages have no per-page check.
 * The signing key is SESSION_SECRET or, when that is unset, a random secret stored in the database
 * (see lib/session-secret.ts). Next 16 always runs the proxy in the Node.js runtime, inside the
 * server process, so it can read it the same way server actions do. The lookup only happens when a
 * cookie is presented, and only once per process — after that the key comes from memory.
 */
export async function proxy(request: NextRequest) {
  // Before anything else: refuse requests not addressed to FlipWatch (DNS rebinding) and cross-site writes.
  const guard = guardRequest(
    {
      method: request.method,
      host: request.headers.get("host") ?? request.nextUrl.host,
      origin: request.headers.get("origin"),
      secFetchSite: request.headers.get("sec-fetch-site"),
    },
    { appUrl: process.env.APP_URL, allowedHosts: process.env.ALLOWED_HOSTS },
  );
  if (!guard.ok) {
    return new NextResponse(guard.reason, { status: guard.status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  }

  const { pathname, searchParams } = request.nextUrl;
  const decision = await decideAccess(pathname, request.cookies.get(SESSION_COOKIE)?.value, Date.now(), {
    secret: async () => getSessionSecret(await getDb()),
  });

  if (decision.kind === "allow") return NextResponse.next();
  if (decision.kind === "unauthorized") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }

  const query = new URLSearchParams(searchParams);
  query.delete("_rsc");
  const search = query.size ? `?${query.toString()}` : "";
  return NextResponse.redirect(new URL(loginRedirectPath(`${decision.next}${search}`), request.url));
}

export const config = {
  // Static build assets never need the gate (anchored so e.g. "/sw.jsx" is still checked);
  // everything else, including /login and the public API routes, is decided by decideAccess().
  matcher: ["/((?!_next/static/|_next/image|favicon\\.ico$|icon\\.svg$|apple-icon\\.png$|icons/|manifest\\.webmanifest$|sw\\.js$).*)"],
};
