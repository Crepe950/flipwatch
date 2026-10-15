/** The standalone entry points (`npm run worker`, `db:migrate`, `db:seed`), run as real processes. */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { and, count, isNotNull, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db";
import { PGLITE_LOCK_FILE } from "@/lib/db/pglite-lock";
import * as schema from "@/lib/db/schema";
import { runSearch } from "@/lib/engine";
import { fakeAdapter, noWaitGate, scraped } from "@/lib/engine/__tests__/helpers";

const ROOT = path.resolve(import.meta.dirname, "..");
const TSX = path.join(ROOT, "node_modules/tsx/dist/cli.mjs");

let tmp: string;
/** A running process other than the scripts, standing in for the app that holds a PGlite directory. */
let app: ChildProcess;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fw-scripts-"));
  app = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120_000)"], { stdio: "ignore" });
  await new Promise((resolve, reject) => app.once("spawn", resolve).once("error", reject));
});
afterAll(() => {
  app.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Run an entry point like `npm run …` from a shell would (not NODE_ENV=test, no inherited DB settings). */
function run(script: string, { cwd = ROOT, env = {} }: { cwd?: string; env?: Record<string, string> } = {}) {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "PGLITE_DIR"));
  return spawnSync(process.execPath, [TSX, path.join(ROOT, script)], {
    cwd,
    env: { ...inherited, NODE_ENV: "development", DATABASE_URL: "", ...env },
    encoding: "utf8",
    timeout: 90_000,
  });
}

function lockedDir(name: string): string {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir);
  fs.writeFileSync(
    path.join(dir, PGLITE_LOCK_FILE),
    JSON.stringify({ pid: app.pid, hostname: os.hostname(), since: new Date().toISOString() }),
  );
  return dir;
}

describe("npm run worker", () => {
  it("refuses the embedded database, which only one process can open", () => {
    const result = run("src/worker/index.ts");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("DATABASE_URL is not set");
    expect(result.stderr).toContain("WORKER_MODE=inline");
  });
});

describe("npm run db:migrate", () => {
  it("reads settings from .env.local like the Next.js server does", () => {
    const project = path.join(tmp, "project");
    fs.mkdirSync(project);
    fs.cpSync(path.join(ROOT, "drizzle"), path.join(project, "drizzle"), { recursive: true });
    fs.writeFileSync(path.join(project, ".env.local"), "PGLITE_DIR=db-from-env-file\n");
    const result = run("src/scripts/migrate.ts", { cwd: project });
    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(path.join(project, "db-from-env-file", "PG_VERSION"))).toBe(true);
  }, 90_000);
});

describe.each(["migrate", "seed"])("npm run db:%s", (script) => {
  it("fails with a clear message while the app has the embedded database open", () => {
    const dir = lockedDir(`locked-${script}`);
    const result = run(`src/scripts/${script}.ts`, { env: { PGLITE_DIR: dir } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`already in use by process ${app.pid}`);
    expect(result.stderr).toContain("stop that process first");
    expect(result.stderr).not.toMatch(/^\s+at /m); // a message, not a stack trace
    expect(fs.readdirSync(dir)).toEqual([PGLITE_LOCK_FILE]);
  }, 90_000);
});

describe("npm run db:seed", () => {
  it("creates paused demo searches whose first real run records existing listings silently", async () => {
    const dir = path.join(tmp, "seeded");
    const result = run("src/scripts/seed.ts", { env: { PGLITE_DIR: dir } });
    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(path.join(dir, PGLITE_LOCK_FILE))).toBe(false);

    const client = new PGlite(dir);
    try {
      const db = drizzle(client, { schema }) as unknown as Db;
      const demo = await db.select().from(schema.searches);
      expect(demo.length).toBeGreaterThan(0);
      expect(demo.every((s) => !s.enabled)).toBe(true);
      const [primed] = await db
        .select({ n: count() })
        .from(schema.scrapeRuns)
        .where(and(isNotNull(schema.scrapeRuns.searchId), isNull(schema.scrapeRuns.error)));
      expect(primed.n).toBe(0);

      // What the marketplaces return once the user turns the search on: listings that were already up.
      const drill = demo.find((s) => s.name === "DeWalt drill")!;
      const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);
      const live = Array.from({ length: 6 }, (_, n) =>
        scraped("craigslist", `live-${n}`, { title: `DeWalt 20V drill kit #${n}`, priceCents: 6_000 + n * 500, postedAt: hoursAgo(2 + n) }),
      );
      const firstRun = await runSearch(db, drill.id, {
        adapters: { craigslist: fakeAdapter("craigslist", { results: live }), kijiji: fakeAdapter("kijiji"), ebay: fakeAdapter("ebay") },
        gate: noWaitGate(),
        notify: false,
      });
      expect(firstRun.events.length).toBe(live.length);
      expect(firstRun.events.filter((e) => !e.silent)).toEqual([]);
    } finally {
      await client.close();
    }
  }, 90_000);
});
