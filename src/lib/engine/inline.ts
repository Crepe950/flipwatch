/** Boots the polling scheduler inside the Next.js server when WORKER_MODE=inline (see src/instrumentation.ts). */
import { config } from "../config";
import { getDb } from "../db";
import { log } from "./log";
import { startScheduler } from "./scheduler";

export function startInlineWorker(): void {
  if (config.workerMode !== "inline") {
    log.info(`WORKER_MODE=${config.workerMode}: not polling from the web server`);
    return;
  }
  startScheduler(getDb, { mode: "inline" });
  // The Discord bot edits searches, so it lives in the process that owns the (possibly embedded) database.
  void import("../discord-bot").then(({ startDiscordBot }) => startDiscordBot(getDb));
}
