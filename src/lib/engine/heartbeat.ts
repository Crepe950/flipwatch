/** Worker liveness, stored in app_settings so the web app can show whether polling is alive. */
import os from "node:os";
import { eq } from "drizzle-orm";
import type { Db } from "../db";
import { appSettings } from "../db/schema";

export const HEARTBEAT_KEY = "worker.heartbeat";

export interface Heartbeat {
  /** ISO timestamp of the last beat. */
  at: string;
  pid: number;
  /** "inline" | "external" | "cron" … */
  mode: string;
  hostname?: string;
}

export async function writeHeartbeat(db: Db, { mode, now = new Date() }: { mode: string; now?: Date }): Promise<void> {
  const value: Heartbeat = { at: now.toISOString(), pid: process.pid, mode, hostname: os.hostname() };
  await db
    .insert(appSettings)
    .values({ key: HEARTBEAT_KEY, value, updatedAt: now })
    .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: now } });
}

function isHeartbeat(value: unknown): value is Heartbeat {
  const v = value as Partial<Heartbeat> | null;
  return !!v && typeof v === "object" && typeof v.at === "string" && !Number.isNaN(Date.parse(v.at));
}

export async function readHeartbeat(db: Db): Promise<Heartbeat | null> {
  const [row] = await db.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, HEARTBEAT_KEY));
  return row && isHeartbeat(row.value) ? row.value : null;
}
