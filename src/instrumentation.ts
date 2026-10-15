/**
 * Runs once when a Next.js server instance starts. With WORKER_MODE=inline (the default) this starts
 * the polling scheduler inside the web server; external/off modes leave polling to others.
 */
export async function register() {
  // The nodejs-only import sits inside this condition so it is compiled out of the edge bundle,
  // and we never poll during `next build`.
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NEXT_PHASE !== "phase-production-build") {
    const { startInlineWorker } = await import("./lib/engine/inline");
    startInlineWorker();
  }
}
