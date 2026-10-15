import { AsyncLocalStorage } from "node:async_hooks";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE, createSessionToken } from "@/lib/auth";
import type { Db } from "@/lib/db";
import { SESSION_SECRET_KEY } from "@/lib/session-secret";

// The proxy reads the generated session secret from the database when SESSION_SECRET is unset.
const state = vi.hoisted(() => ({ db: null as Db | null }));
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return { ...actual, getDb: async () => state.db! };
});

// Next's server modules expect the AsyncLocalStorage global its own runtime installs.
(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage ??= AsyncLocalStorage;

type ProxyModule = typeof import("@/proxy");
type NextServer = typeof import("next/server");
type Testing = typeof import("next/experimental/testing/server");

let mod: ProxyModule;
let server: NextServer;
let testing: Testing;
let closeDb: () => Promise<void>;

beforeAll(async () => {
  [mod, server, testing] = await Promise.all([import("@/proxy"), import("next/server"), import("next/experimental/testing/server")]);
  const { createTestDb } = await import("@/lib/db");
  ({ db: state.db, close: closeDb } = await createTestDb());
});

afterAll(() => closeDb());

beforeEach(() => {
  // The test server's own address; anything else is refused before auth (see the request-guard tests).
  vi.stubEnv("ALLOWED_HOSTS", "flip.test");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function request(path: string, cookie?: string, extra: Record<string, string> = {}, method = "GET") {
  const headers: Record<string, string> = { host: "flip.test", ...extra };
  if (cookie) headers.cookie = `${SESSION_COOKIE}=${cookie}`;
  return new server.NextRequest(new URL(path, "http://flip.test"), { headers, method });
}

describe("request guard in the proxy", () => {
  it("refuses requests for another host name (DNS rebinding) before anything else", async () => {
    vi.stubEnv("APP_PASSWORD", "");
    const res = await mod.proxy(request("/settings", undefined, { host: "evil.example:3000" }));
    expect(res.status).toBe(421);
  });

  it("refuses cross-site writes, even without a password", async () => {
    vi.stubEnv("APP_PASSWORD", "");
    const res = await mod.proxy(request("/api/searches/1/run", undefined, { origin: "https://evil.example" }, "POST"));
    expect(res.status).toBe(403);
    const ok = await mod.proxy(request("/api/searches/1/run", undefined, { origin: "http://flip.test" }, "POST"));
    expect(ok.headers.get("x-middleware-next")).toBe("1");
  });
});

describe("proxy matcher", () => {
  it.each([
    ["/", true],
    ["/searches/1/edit", true],
    ["/api/searches", true],
    ["/login", true],
    ["/sw.jsx", true],
    ["/_next/static/chunks/app.js", false],
    ["/_next/image", false],
    ["/favicon.ico", false],
    ["/icon.svg", false],
    ["/apple-icon.png", false],
    ["/icons/badge-96.png", false],
    ["/manifest.webmanifest", false],
    ["/sw.js", false],
  ])("%s runs the proxy: %s", (url, expected) => {
    expect(testing.unstable_doesMiddlewareMatch({ config: mod.config, url, nextConfig: {} })).toBe(expected);
  });
});

describe("proxy", () => {
  it("passes everything through when APP_PASSWORD is unset", async () => {
    vi.stubEnv("APP_PASSWORD", "");
    const res = await mod.proxy(request("/settings"));
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("redirects pages to /login with the original path and query", async () => {
    vi.stubEnv("APP_PASSWORD", "pw");
    const res = await mod.proxy(request("/searches/new?q=ps5&_rsc=abc"));
    expect(res.status).toBe(307);
    expect(testing.getRedirectUrl(res)).toBe("http://flip.test/login?next=%2Fsearches%2Fnew%3Fq%3Dps5");
    expect(testing.getRedirectUrl(await mod.proxy(request("/")))).toBe("http://flip.test/login");
  });

  it("answers API requests with 401 JSON", async () => {
    vi.stubEnv("APP_PASSWORD", "pw");
    const res = await mod.proxy(request("/api/searches"));
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("lets public paths and valid sessions through", async () => {
    vi.stubEnv("APP_PASSWORD", "pw");
    vi.stubEnv("SESSION_SECRET", "s3cret");
    expect((await mod.proxy(request("/login"))).headers.get("x-middleware-next")).toBe("1");
    expect((await mod.proxy(request("/api/cron/tick"))).headers.get("x-middleware-next")).toBe("1");
    const token = await createSessionToken(Date.now(), "s3cret");
    expect((await mod.proxy(request("/api/searches", token))).headers.get("x-middleware-next")).toBe("1");
    vi.stubEnv("SESSION_SECRET", "rotated");
    expect((await mod.proxy(request("/api/searches", token))).status).toBe(401);
  });

  it("without SESSION_SECRET, verifies cookies against the generated secret, not APP_PASSWORD", async () => {
    vi.stubEnv("APP_PASSWORD", "hunter2");
    vi.stubEnv("SESSION_SECRET", "");
    // A cookie minted offline with the app password as the HMAC key (the old fallback) is rejected.
    const forged = await createSessionToken(Date.now(), "hunter2");
    expect((await mod.proxy(request("/settings", forged))).status).toBe(307);
    expect((await mod.proxy(request("/api/searches", forged))).status).toBe(401);

    const { getSetting } = await import("@/lib/queries/settings");
    const secret = await getSetting(state.db!, SESSION_SECRET_KEY);
    expect(secret).toEqual(expect.stringMatching(/^[A-Za-z0-9_-]{43}$/));
    const token = await createSessionToken(Date.now(), secret as string);
    expect((await mod.proxy(request("/settings", token))).headers.get("x-middleware-next")).toBe("1");
  });
});
