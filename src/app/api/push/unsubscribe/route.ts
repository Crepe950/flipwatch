import { z } from "zod";
import { unauthorizedResponse } from "@/app/login/session";
import { getDb } from "@/lib/db";
import { deletePushSubscription } from "@/lib/notify";
import { parseJsonBody } from "../request";

const bodySchema = z.object({ endpoint: z.string().trim().min(1).max(2048) });

/** Forget a browser's push subscription (POST { endpoint }). Unknown endpoints are a no-op. */
export async function POST(request: Request) {
  const denied = await unauthorizedResponse();
  if (denied) return denied;
  const parsed = await parseJsonBody(request, bodySchema);
  if (!parsed.ok) return parsed.response;
  const db = await getDb();
  await deletePushSubscription(db, parsed.data.endpoint);
  return Response.json({ ok: true });
}
