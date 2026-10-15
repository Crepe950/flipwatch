import { revalidatePath } from "next/cache";
import { z } from "zod";
import { unauthorizedResponse } from "@/app/login/session";
import { getDb } from "@/lib/db";
import { deleteSearch, getSearch, parseSearchId, setSearchEnabled, updateSearch } from "@/lib/queries/searches";
import { searchInputSchema } from "@/lib/search-schema";
import { jsonError, readJson, validationError } from "../http";

type Context = RouteContext<"/api/searches/[id]">;

const patchSchema = z.object({ enabled: z.boolean() }).strict();

/** GET /api/searches/:id */
export async function GET(_request: Request, ctx: Context) {
  const denied = await unauthorizedResponse();
  if (denied) return denied;
  const id = parseSearchId((await ctx.params).id);
  const search = id ? await getSearch(await getDb(), id) : null;
  if (!search) return jsonError(404, "Search not found");
  return Response.json({ search }, { headers: { "Cache-Control": "no-store" } });
}

/** PUT /api/searches/:id — replace the definition with a full SearchInput body. */
export async function PUT(request: Request, ctx: Context) {
  const denied = await unauthorizedResponse();
  if (denied) return denied;
  const id = parseSearchId((await ctx.params).id);
  if (!id) return jsonError(404, "Search not found");
  const read = await readJson(request);
  if (!read.ok) return read.response;
  const parsed = searchInputSchema.safeParse(read.body);
  if (!parsed.success) return validationError(parsed.error);
  const search = await updateSearch(await getDb(), id, parsed.data);
  if (!search) return jsonError(404, "Search not found");
  revalidatePath("/searches");
  return Response.json({ search });
}

/** PATCH /api/searches/:id — `{ "enabled": boolean }` to pause or resume. */
export async function PATCH(request: Request, ctx: Context) {
  const denied = await unauthorizedResponse();
  if (denied) return denied;
  const id = parseSearchId((await ctx.params).id);
  if (!id) return jsonError(404, "Search not found");
  const read = await readJson(request);
  if (!read.ok) return read.response;
  const parsed = patchSchema.safeParse(read.body);
  if (!parsed.success) return validationError(parsed.error);
  const db = await getDb();
  if (!(await setSearchEnabled(db, id, parsed.data.enabled))) return jsonError(404, "Search not found");
  revalidatePath("/searches");
  return Response.json({ search: await getSearch(db, id) });
}

/** DELETE /api/searches/:id — removes the search and its matches. */
export async function DELETE(_request: Request, ctx: Context) {
  const denied = await unauthorizedResponse();
  if (denied) return denied;
  const id = parseSearchId((await ctx.params).id);
  if (!id || !(await deleteSearch(await getDb(), id))) return jsonError(404, "Search not found");
  revalidatePath("/searches");
  return new Response(null, { status: 204 });
}
