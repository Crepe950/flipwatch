/**
 * Standalone polling worker for WORKER_MODE=external: `npm run worker`.
 * Runs the same scheduler the web server would run inline, and shuts down gracefully on SIGINT/SIGTERM.
 * Needs Postgres (DATABASE_URL): the embedded PGlite database can only be opened by one process.
 */
import { loadEnvConfig } from "@next/env";
import { aiStatus } from "../lib/ai";
import { config } from "../lib/config";
import { closeDb, getDb } from "../lib/db";
import { startDiscordBot } from "../lib/discord-bot";
import { startScheduler } from "../lib/engine";
import { listAdapters } from "../lib/marketplaces/registry";

// Same .env files as `next dev` / `next start` (.env.local, .env, …); real environment variables win.
loadEnvConfig(process.cwd(), process.env.NODE_ENV !== "production");

const SHUTDOWN_TIMEOUT_MS = 30_000;

function describeDatabase(url: string): string {
  try {
    const { protocol, hostname, port, pathname } = new URL(url);
    return `${protocol}//${hostname}${port ? `:${port}` : ""}${pathname}`;
  } catch {
    return "Postgres (DATABASE_URL could not be parsed for display)";
  }
}

function describeAi(): string {
  try {
    const status = aiStatus();
    return status.configured ? `configured (${status.model})` : `off${status.message ? ` (${status.message})` : ""}`;
  } catch {
    return "unknown";
  }
}

function describeMarketplaces(): string {
  return listAdapters()
    .map((adapter) => {
      try {
        const status = adapter.status();
        return status.ok ? adapter.id : `${adapter.id} (off${status.message ? `: ${status.message}` : ""})`;
      } catch {
        return `${adapter.id} (status check failed)`;
      }
    })
    .join(", ");
}

function logStartup(databaseUrl: string): void {
  const mode = config.workerMode;
  console.log("[worker] FlipWatch worker starting");
  console.log(`[worker]   database:        ${describeDatabase(databaseUrl)}`);
  console.log(`[worker]   WORKER_MODE:     ${mode}`);
  console.log(`[worker]   tick every:      ${config.schedulerTickMs} ms`);
  console.log(`[worker]   min poll:        ${config.minPollIntervalSec} s`);
  console.log(`[worker]   marketplaces:    ${describeMarketplaces()}`);
  console.log(`[worker]   AI evaluation:   ${describeAi()}`);
  if (mode === "inline") {
    console.warn(
      "[worker] WORKER_MODE is 'inline' here. If the web server has the same setting it polls too: searches are " +
        "claimed atomically in Postgres, so none runs twice, but that is wasted work. Set WORKER_MODE=external " +
        "for the web app when using this worker.",
    );
  } else if (mode === "off") {
    console.warn("[worker] WORKER_MODE is 'off', but this worker was started explicitly, so it will poll.");
  }
}

async function main(): Promise<void> {
  const databaseUrl = config.databaseUrl;
  if (!databaseUrl) {
    console.error(
      "[worker] DATABASE_URL is not set. The standalone worker needs Postgres, shared with the web app: the " +
        "embedded PGlite database can only be opened by one process, and a second one would silently lose " +
        "writes. Set DATABASE_URL for both, or don't run this worker and let the web server poll " +
        "(WORKER_MODE=inline, the default).",
    );
    process.exitCode = 1;
    return;
  }
  logStartup(databaseUrl);
  await getDb(); // connect + migrate up front so misconfiguration fails fast
  const scheduler = startScheduler(getDb, { mode: "external" });
  const bot = startDiscordBot(getDb);

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      console.warn(`[worker] ${signal} again, exiting immediately`);
      process.exit(1);
    }
    shuttingDown = true;
    console.log(`[worker] ${signal} received, finishing the current tick…`);
    setTimeout(() => {
      console.error("[worker] Shutdown timed out, exiting");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS).unref();
    try {
      bot?.stop();
      await scheduler.stop();
      await closeDb();
      console.log("[worker] Stopped cleanly");
      process.exit(0);
    } catch (err) {
      console.error("[worker] Error during shutdown", err);
      process.exit(1);
    }
  };
  process.on("SIGINT", (s) => void shutdown(s));
  process.on("SIGTERM", (s) => void shutdown(s));
}

process.on("unhandledRejection", (reason) => console.error("[worker] Unhandled rejection", reason));

main().catch(async (err) => {
  console.error("[worker] Failed to start", err);
  await closeDb().catch(() => undefined);
  process.exit(1);
});
