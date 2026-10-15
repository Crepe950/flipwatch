/** Data for GET /api/health. Deliberately minimal: no secrets, no search terms, no listing data. */
import { count } from "drizzle-orm";
import { config, type WorkerMode } from "../config";
import type { Db } from "../db";
import { searches } from "../db/schema";
import { listAdapters } from "../marketplaces/registry";
import type { MarketplaceAdapter } from "../marketplaces/types";
import type { MarketplaceId } from "../types";
import { readHeartbeat } from "./heartbeat";
import { loadMarketplaceHealth } from "./marketplace-health";

/** A heartbeat older than this means the poller is down (it beats at least every 30 s). */
export const HEARTBEAT_STALE_SEC = 120;

export interface MarketplaceHealthSummary {
  marketplace: MarketplaceId;
  displayName: string;
  /** adapter.status().ok — credentials present and not disabled. */
  available: boolean;
  statusMessage: string | null;
  consecutiveFailures: number;
  backoffUntil: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
}

export interface HealthSummary {
  ok: boolean;
  workerMode: WorkerMode;
  heartbeatAt: string | null;
  heartbeatAgeSec: number | null;
  heartbeatMode: string | null;
  marketplaces: MarketplaceHealthSummary[];
  searches: { enabled: number; total: number };
}

/** Error messages can contain request URLs (and so search keywords); keep only the gist. */
function redactUrls(message: string | null): string | null {
  return message ? message.replace(/https?:\/\/\S+/g, "<url>") : null;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export async function getHealthSummary(
  db: Db,
  opts: { now?: Date; adapters?: MarketplaceAdapter[] } = {},
): Promise<HealthSummary> {
  const now = opts.now ?? new Date();
  const [heartbeat, health, searchCounts] = await Promise.all([
    readHeartbeat(db),
    loadMarketplaceHealth(db),
    db.select({ enabled: searches.enabled, n: count() }).from(searches).groupBy(searches.enabled),
  ]);

  const heartbeatAgeSec = heartbeat ? Math.max(0, Math.round((now.getTime() - Date.parse(heartbeat.at)) / 1000)) : null;
  const workerMode = config.workerMode;
  const pollerAlive = heartbeatAgeSec !== null && heartbeatAgeSec <= HEARTBEAT_STALE_SEC;

  const marketplaces = (opts.adapters ?? listAdapters()).map((adapter): MarketplaceHealthSummary => {
    let status: { ok: boolean; message?: string };
    try {
      status = adapter.status();
    } catch {
      status = { ok: false, message: "Status check failed" };
    }
    const row = health.get(adapter.id);
    return {
      marketplace: adapter.id,
      displayName: adapter.displayName,
      available: status.ok,
      statusMessage: status.message ?? null,
      consecutiveFailures: row?.consecutiveFailures ?? 0,
      backoffUntil: row?.backoffUntil && row.backoffUntil > now ? row.backoffUntil.toISOString() : null,
      lastSuccessAt: iso(row?.lastSuccessAt),
      lastError: redactUrls(row?.lastError ?? null),
      lastErrorAt: iso(row?.lastErrorAt),
    };
  });

  const enabled = searchCounts.filter((r) => r.enabled).reduce((sum, r) => sum + Number(r.n), 0);
  const total = searchCounts.reduce((sum, r) => sum + Number(r.n), 0);

  return {
    // With WORKER_MODE=off nothing is expected to poll continuously (cron or manual runs).
    ok: workerMode === "off" || pollerAlive,
    workerMode,
    heartbeatAt: heartbeat?.at ?? null,
    heartbeatAgeSec,
    heartbeatMode: heartbeat?.mode ?? null,
    marketplaces,
    searches: { enabled, total },
  };
}
