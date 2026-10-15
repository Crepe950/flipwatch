import { revalidatePath } from "next/cache";
import { unauthorizedResponse } from "@/app/login/session";
import { getDb } from "@/lib/db";
import { createSearch, listSearchesWithStats } from "@/lib/queries/searches";
import { searchInputSchema } from "@/lib/search-schema";
import { readJson, validationError } from "./http";

/** GET /api/searches — every saved search with match counts. */
export async function GET() {
  const denied = await unauthorizedResponse();
  if (denied) return denied;
  const searches = await listSearchesWithStats(await getDb());
  return Response.json({ searches }, { headers: { "Cache-Control": "no-store" } });
}

/** POST /api/searches — create a search from a SearchInput JSON body (money in cents). */
export async function POST(request: Request) {
  const denied = await unauthorizedResponse();
  if (denied) return denied;
  const read = await readJson(request);
  if (!read.ok) return read.response;
  const parsed = searchInputSchema.safeParse(read.body);
  if (!parsed.success) return validationError(parsed.error);
  const search = await createSearch(await getDb(), parsed.data);
  revalidatePath("/searches");
  return Response.json({ search }, { status: 201 });
}
