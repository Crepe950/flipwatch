import { z } from "zod";
import { unauthorizedResponse } from "@/app/login/session";
import { getDb } from "@/lib/db";
import { browserPushSubscriptionSchema, getVapidPublicKey, savePushSubscription } from "@/lib/notify";
import { parseJsonBody } from "../request";

const bodySchema = z.object({ subscription: browserPushSubscriptionSchema });

/** Store this browser's push subscription (POST { subscription: PushSubscription.toJSON() }). */
export async function POST(request: Request) {
  const denied = await unauthorizedResponse();
  if (denied) return denied;
  const parsed = await parseJsonBody(request, bodySchema);
  if (!parsed.ok) return parsed.response;
  if (!getVapidPublicKey()) {
    return Response.json({ error: "Browser push is not configured on the server (VAPID keys missing)" }, { status: 503 });
  }
  const { endpoint, keys } = parsed.data.subscription;
  const db = await getDb();
  await savePushSubscription(db, { endpoint, keys }, request.headers.get("user-agent"));
  return Response.json({ ok: true });
}
