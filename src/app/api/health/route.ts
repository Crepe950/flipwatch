/** Liveness/readiness for uptime monitors and the Settings page. No secrets, no listing data. */
import { getDb } from "@/lib/db";
import { getHealthSummary } from "@/lib/engine";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET() {
  try {
    const db = await getDb();
    return Response.json(await getHealthSummary(db), { headers: NO_STORE });
  } catch (err) {
    console.error("[health] database check failed", err);
    return Response.json({ ok: false, error: "Database unavailable" }, { status: 503, headers: NO_STORE });
  }
}
