/**
 * Every server action and API route re-checks the session itself (requireAuth /
 * unauthorizedResponse): actions are reachable by a POST to any page and the proxy is only the first
 * gate. Files are discovered from disk so new actions and routes are covered automatically.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE, createSessionToken } from "@/lib/auth";
import type { Db } from "@/lib/db";

// Next's server modules expect the AsyncLocalStorage global its own runtime installs.
(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage ??= AsyncLocalStorage;

const state = vi.hoisted(() => ({ db: null as Db | null, cookie: undefined as string | undefined }));
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return { ...actual, getDb: async () => state.db! };
});
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({
    get: (name: string) => (name === SESSION_COOKIE && state.cookie ? { name, value: state.cookie } : undefined),
    set: () => {},
    delete: () => {},
  }),
}));

const { createTestDb } = await import("@/lib/db");
const { NextRequest } = await import("next/server");
const { getSessionSecret } = await import("@/lib/session-secret");

const SRC = path.resolve(import.meta.dirname, "..");
const rel = (file: string) => path.relative(SRC, file).split(path.sep).join("/");

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

const sourceFiles = walk(SRC).filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f));
const actionFiles = sourceFiles.filter((f) => /^["']use server["']/.test(fs.readFileSync(f, "utf8").trimStart()));
const routeFiles = walk(path.join(SRC, "app/api")).filter((f) => path.basename(f) === "route.ts");

/** Reachable without a session on purpose. */
const PUBLIC_ACTIONS = new Set(["app/login/actions.ts#loginAction", "app/login/actions.ts#logoutAction"]);
// /api/cron/tick checks CRON_SECRET itself; /api/health is for uptime monitors.
const PUBLIC_ROUTES = new Set(["app/api/cron/tick/route.ts", "app/api/health/route.ts"]);
const HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

type Handler = (...args: unknown[]) => Promise<unknown>;

async function exportedFunctions(file: string): Promise<Array<[string, Handler]>> {
  const mod = (await import(/* @vite-ignore */ file)) as Record<string, unknown>;
  return Object.entries(mod).filter((entry): entry is [string, Handler] => typeof entry[1] === "function");
}

let close: () => Promise<void>;
beforeAll(async () => {
  ({ db: state.db, close } = await createTestDb());
});
afterAll(() => close());

beforeEach(() => {
  vi.stubEnv("APP_PASSWORD", "hunter2");
  vi.stubEnv("SESSION_SECRET", "");
  state.cookie = undefined;
});
afterEach(() => {
  vi.unstubAllEnvs();
});

it("finds the server actions and API routes to check", () => {
  expect(actionFiles.map(rel)).toEqual(
    expect.arrayContaining(["components/feed/actions.ts", "app/listings/[id]/actions.ts", "app/pipeline/actions.ts", "app/searches/actions.ts", "app/settings/actions.ts"]),
  );
  expect(routeFiles.map(rel)).toEqual(expect.arrayContaining(["app/api/feed/route.ts", "app/api/push/subscribe/route.ts", "app/api/push/unsubscribe/route.ts"]));
});

// A cookie minted offline with APP_PASSWORD as the HMAC key must not count as a session either.
const cookies = {
  "no session cookie": async () => undefined,
  "a cookie signed with APP_PASSWORD": async () => createSessionToken(Date.now(), "hunter2"),
};

describe.each(Object.entries(cookies))("with %s", (_label, makeCookie) => {
  it.each(actionFiles.map(rel))("server actions in %s redirect to /login", async (file) => {
    state.cookie = await makeCookie();
    for (const [name, action] of await exportedFunctions(path.join(SRC, file))) {
      if (PUBLIC_ACTIONS.has(`${file}#${name}`)) continue;
      const outcome = await action().then(
        (value) => ({ returned: value }),
        (error: { digest?: string }) => ({ digest: error?.digest }),
      );
      expect(outcome, `${file}#${name}`).toEqual({ digest: expect.stringMatching(/^NEXT_REDIRECT;[a-z]+;\/login;/) });
    }
  });

  it.each(routeFiles.map(rel).filter((file) => !PUBLIC_ROUTES.has(file)))("%s answers 401", async (file) => {
    state.cookie = await makeCookie();
    const mod = (await import(/* @vite-ignore */ path.join(SRC, file))) as Record<string, unknown>;
    const handlers = HTTP_METHODS.filter((method) => typeof mod[method] === "function");
    expect(handlers.length).toBeGreaterThan(0);
    for (const method of handlers) {
      const body = method === "GET" || method === "HEAD" ? undefined : "{}";
      const request = new NextRequest("http://localhost/api/x", { method, body, headers: { "content-type": "application/json" } });
      const response = (await (mod[method] as Handler)(request, { params: Promise.resolve({ id: "1" }) })) as Response;
      expect(response.status, `${method} ${file}`).toBe(401);
    }
  });
});

it("lets a real session through", async () => {
  const { isAuthenticated, unauthorizedResponse } = await import("./login/session");
  state.cookie = await createSessionToken(Date.now(), await getSessionSecret(state.db!));
  await expect(isAuthenticated()).resolves.toBe(true);
  await expect(unauthorizedResponse()).resolves.toBeNull();
});
