import type { NextRequest } from "next/server";
import { unauthorizedResponse } from "@/app/login/session";
import { parseFeedQueryStrict, queryToFilters } from "@/components/feed/filter-params";
import { getDb } from "@/lib/db";
import { countUnseen, decodeFeedCursor, getFeedPage, type FeedApiResponse } from "@/lib/queries/feed";

const NO_STORE = { "Cache-Control": "no-store" };

function badRequest(error: string, issues?: Array<{ path: string; message: string }>) {
  return Response.json({ error, issues }, { status: 400, headers: NO_STORE });
}

/**
 * GET /api/feed — feed cards as JSON, same filters as the page (search, marketplace, event, score,
 * initial, dismissed, q). `cursor` continues to the next (older) page; `since` (ISO time, for live
 * polling) limits the results to newer events, and can be combined with `cursor` to page through a
 * burst bigger than `limit`.
 */
export async function GET(request: NextRequest) {
  const denied = await unauthorizedResponse();
  if (denied) return denied;
  const parsed = parseFeedQueryStrict(request.nextUrl.searchParams);
  if (!parsed.success) {
    return badRequest(
      "Invalid query parameters",
      parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  const query = parsed.data;
  const cursor = query.cursor ? decodeFeedCursor(query.cursor) : null;
  if (query.cursor && !cursor) return badRequest("Invalid cursor");

  try {
    const db = await getDb();
    const filters = queryToFilters(query);
    const since = query.since ? new Date(query.since) : undefined;
    const [page, unseenCount] = await Promise.all([
      getFeedPage(db, filters, { cursor, limit: query.limit, since }),
      countUnseen(db, filters),
    ]);
    const body: FeedApiResponse = { ...page, unseenCount, serverTime: new Date().toISOString() };
    return Response.json(body, { headers: NO_STORE });
  } catch (error) {
    console.error("[api/feed] query failed:", error);
    return Response.json({ error: "Failed to load the feed" }, { status: 500, headers: NO_STORE });
  }
}
