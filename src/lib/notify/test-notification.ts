import { eq } from "drizzle-orm";
import { config } from "../config";
import type { Db } from "../db";
import { notificationChannels } from "../db/schema";
import { deliver, logAttempts, updateChannelStatus, type Attempt, type DeliveryOptions } from "./delivery";
import { errorMessage } from "./errors";
import { buildSampleAlert, normalizeAppUrl } from "./format";

export interface TestNotificationOptions extends DeliveryOptions {
  now?: Date;
  appUrl?: string;
}

/**
 * Send a sample alert through one channel (enabled or not), record the attempt and update the
 * channel's lastSuccessAt/lastError. Never throws.
 */
export async function sendTestNotification(
  db: Db,
  channelId: number,
  opts: TestNotificationOptions = {},
): Promise<{ ok: boolean; error?: string }> {
  try {
    const [channel] = await db.select().from(notificationChannels).where(eq(notificationChannels.id, channelId)).limit(1);
    if (!channel) return { ok: false, error: "Channel not found" };

    const now = opts.now ?? new Date();
    const alert = buildSampleAlert({ appUrl: normalizeAppUrl(opts.appUrl ?? config.appUrl), now });
    const result = await deliver(db, channel, alert, opts);
    const attempt: Attempt = { alert, ...result, skipped: false, at: new Date() };
    await logAttempts(db, channel.id, [attempt]);
    await updateChannelStatus(db, channel.id, [attempt]);
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}
