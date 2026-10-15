import { asc, desc, eq, isNotNull } from "drizzle-orm";
import type { WorkerMode } from "../config";
import type { Db } from "../db";
import {
  appSettings,
  marketplaceHealth,
  notificationChannels,
  scrapeRuns,
  searches,
  type MarketplaceHealth,
  type NotificationChannel,
  type ScrapeRun,
} from "../db/schema";
import { DEFAULT_LOCATION } from "../locations";
import { searchLocationSchema } from "../search-schema";
import type { MarketplaceId, NotificationChannelType, SearchLocation } from "../types";

export const DEFAULT_LOCATION_KEY = "defaultLocation";
export const WORKER_HEARTBEAT_KEY = "worker.heartbeat";
/** The worker is considered stalled when its heartbeat is older than this. */
export const HEARTBEAT_STALE_MS = 2 * 60 * 1000;

// ---- app_settings ---------------------------------------------------------

export async function getSetting(db: Db, key: string): Promise<unknown> {
  const [row] = await db.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, key)).limit(1);
  return row?.value;
}

export async function setSetting(db: Db, key: string, value: unknown, now: Date = new Date()): Promise<void> {
  await db
    .insert(appSettings)
    .values({ key, value, updatedAt: now })
    .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: now } });
}

/** The default location for new searches; falls back to DEFAULT_LOCATION when unset or invalid. */
export async function getDefaultLocation(db: Db): Promise<SearchLocation> {
  const parsed = searchLocationSchema.safeParse(await getSetting(db, DEFAULT_LOCATION_KEY));
  return parsed.success ? parsed.data : DEFAULT_LOCATION;
}

export async function setDefaultLocation(db: Db, location: SearchLocation, now: Date = new Date()): Promise<SearchLocation> {
  const valid = searchLocationSchema.parse(location);
  await setSetting(db, DEFAULT_LOCATION_KEY, valid, now);
  return valid;
}

export interface WorkerHeartbeat {
  at: Date;
  pid?: number;
  mode?: string;
  hostname?: string;
}

/** Last heartbeat written by the scheduler ({ at: ISO, pid, mode, hostname? }), or null. */
export async function getWorkerHeartbeat(db: Db): Promise<WorkerHeartbeat | null> {
  const value = await getSetting(db, WORKER_HEARTBEAT_KEY);
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const at = typeof record.at === "string" || typeof record.at === "number" ? new Date(record.at) : null;
  if (!at || Number.isNaN(at.getTime())) return null;
  return {
    at,
    pid: typeof record.pid === "number" ? record.pid : undefined,
    mode: typeof record.mode === "string" ? record.mode : undefined,
    hostname: typeof record.hostname === "string" ? record.hostname : undefined,
  };
}

export type HeartbeatStatus = "live" | "stalled" | "off" | "none";

/**
 * Live when a beat arrived in the last two minutes (an external worker or a cron-driven tick can poll
 * even when this process has WORKER_MODE=off). Otherwise off when polling is disabled here (an old
 * beat, e.g. from before switching to WORKER_MODE=off or from `npm run db:seed`, is no reason to
 * worry), stalled when a beat stopped coming, or none when there never was one.
 */
export function heartbeatStatus(heartbeat: WorkerHeartbeat | null, mode: WorkerMode, now: Date): HeartbeatStatus {
  if (heartbeat && now.getTime() - heartbeat.at.getTime() < HEARTBEAT_STALE_MS) return "live";
  if (mode === "off") return "off";
  return heartbeat ? "stalled" : "none";
}

// ---- notification channels ----------------------------------------------

export async function listChannels(db: Db): Promise<NotificationChannel[]> {
  return db.select().from(notificationChannels).orderBy(asc(notificationChannels.createdAt), asc(notificationChannels.id));
}

export async function getChannel(db: Db, id: number): Promise<NotificationChannel | null> {
  const [row] = await db.select().from(notificationChannels).where(eq(notificationChannels.id, id)).limit(1);
  return row ?? null;
}

export interface ChannelValues {
  name: string;
  type: NotificationChannelType;
  config: Record<string, string>;
  enabled?: boolean;
}

export async function createChannel(db: Db, values: ChannelValues): Promise<NotificationChannel> {
  const [row] = await db
    .insert(notificationChannels)
    .values({ name: values.name, type: values.type, config: values.config, enabled: values.enabled ?? true })
    .returning();
  return row;
}

/** Update name/config (the type of an existing channel never changes). Clears the last error. */
export async function updateChannel(
  db: Db,
  id: number,
  values: { name: string; config: Record<string, string> },
): Promise<NotificationChannel | null> {
  const [row] = await db
    .update(notificationChannels)
    .set({ name: values.name, config: values.config, lastError: null })
    .where(eq(notificationChannels.id, id))
    .returning();
  return row ?? null;
}

export async function setChannelEnabled(db: Db, id: number, enabled: boolean): Promise<boolean> {
  const rows = await db
    .update(notificationChannels)
    .set({ enabled })
    .where(eq(notificationChannels.id, id))
    .returning({ id: notificationChannels.id });
  return rows.length > 0;
}

/**
 * Delete a channel and drop it from every search's channel selection. A search left with no
 * selected channels goes back to null ("all enabled channels") instead of notifying nobody.
 */
export async function deleteChannel(db: Db, id: number): Promise<boolean> {
  return db.transaction(async (tx) => {
    const rows = await tx.delete(notificationChannels).where(eq(notificationChannels.id, id)).returning({ id: notificationChannels.id });
    if (rows.length === 0) return false;
    const selecting = await tx
      .select({ id: searches.id, channelIds: searches.notifyChannelIds })
      .from(searches)
      .where(isNotNull(searches.notifyChannelIds));
    for (const search of selecting) {
      if (!search.channelIds?.includes(id)) continue;
      const remaining = search.channelIds.filter((channelId) => channelId !== id);
      await tx
        .update(searches)
        .set({ notifyChannelIds: remaining.length ? remaining : null })
        .where(eq(searches.id, search.id));
    }
    return true;
  });
}

// ---- marketplaces & worker health ---------------------------------------

export async function listMarketplaceHealth(db: Db): Promise<MarketplaceHealth[]> {
  return db.select().from(marketplaceHealth);
}

/** Reset a marketplace's failure streak and backoff so the next run queries it again. */
export async function clearMarketplaceBackoff(db: Db, marketplace: MarketplaceId): Promise<void> {
  await db.update(marketplaceHealth).set({ backoffUntil: null, consecutiveFailures: 0 }).where(eq(marketplaceHealth.marketplace, marketplace));
}

export interface ScrapeRunWithSearch extends ScrapeRun {
  searchName: string | null;
}

export async function listRecentScrapeRuns(db: Db, limit = 50): Promise<ScrapeRunWithSearch[]> {
  const rows = await db
    .select({ run: scrapeRuns, searchName: searches.name })
    .from(scrapeRuns)
    .leftJoin(searches, eq(scrapeRuns.searchId, searches.id))
    .orderBy(desc(scrapeRuns.startedAt), desc(scrapeRuns.id))
    .limit(Math.max(1, Math.min(limit, 500)));
  return rows.map(({ run, searchName }) => ({ ...run, searchName }));
}
