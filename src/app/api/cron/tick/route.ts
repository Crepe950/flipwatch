/**
 * Serverless scheduling hook (Vercel Cron, GitHub Actions, any uptime pinger):
 * `curl -H "Authorization: Bearer $CRON_SECRET" https://…/api/cron/tick` runs one scheduler tick.
 */
import { config } from "@/lib/config";
import { getDb } from "@/lib/db";
import { isAuthorizedCronRequest, runRetentionIfDue, tick, writeHeartbeat } from "@/lib/engine";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Stop starting/awaiting marketplace work a little before the platform kills the function. */
const TICK_BUDGET_MS = 50_000;

async function handle(request: Request): Promise<Response> {
  if (!isAuthorizedCronRequest(request.headers.get("authorization"), config.cronSecret)) {
    return Response.json({ ok: false, error: "Forbidden" }, { status: 403 });
  }

  const started = Date.now();
  try {
    const db = await getDb();
    const now = new Date();
    await writeHeartbeat(db, { mode: "cron", now }).catch((err) => console.warn("[cron] heartbeat failed", err));
    await runRetentionIfDue(db, now).catch((err) => console.error("[cron] retention failed", err));
    const result = await tick(db, { now, signal: AbortSignal.timeout(TICK_BUDGET_MS) });
    return Response.json(
      { ok: result.errors.length === 0, ...result, durationMs: Date.now() - started },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.error("[cron] tick failed", err);
    return Response.json({ ok: false, error: "Tick failed", durationMs: Date.now() - started }, { status: 500 });
  }
}

export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}
