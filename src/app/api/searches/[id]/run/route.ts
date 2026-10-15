import { revalidatePath } from "next/cache";
import { unauthorizedResponse } from "@/app/login/session";
import { summarizeRun } from "@/components/searches/run-views";
import { getDb } from "@/lib/db";
import { runSearch } from "@/lib/engine";
import { getSearch, parseSearchId } from "@/lib/queries/searches";
import { jsonError } from "../../http";

export const maxDuration = 120;

/** POST /api/searches/:id/run — poll every marketplace now (ignores backoff) and return a summary. */
export async function POST(_request: Request, ctx: RouteContext<"/api/searches/[id]/run">) {
  const denied = await unauthorizedResponse();
  if (denied) return denied;
  const id = parseSearchId((await ctx.params).id);
  const db = await getDb();
  const search = id ? await getSearch(db, id) : null;
  if (!search) return jsonError(404, "Search not found");
  try {
    const result = await runSearch(db, search.id, { force: true });
    return Response.json({ summary: summarizeRun(result, search.name) });
  } catch (err) {
    console.error(`[api] run failed for search ${search.id}`, err);
    return jsonError(500, err instanceof Error ? err.message : "Run failed");
  } finally {
    revalidatePath("/searches");
  }
}
