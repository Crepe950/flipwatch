import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";
import type { Db } from "@/lib/db";

const state = vi.hoisted(() => ({
  db: null as Db | null,
  headers: new Headers(),
  cookies: new Map<string, { value: string; options: Record<string, unknown> }>(),
}));
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return { ...actual, getDb: async () => state.db! };
});
vi.mock("next/headers", () => ({
  headers: async () => state.headers,
  cookies: async () => ({
    get: (name: string) => (state.cookies.has(name) ? { name, value: state.cookies.get(name)!.value } : undefined),
    set: (name: string, value: string, options: Record<string, unknown>) => state.cookies.set(name, { value, options }),
    delete: (name: string) => state.cookies.delete(name),
  }),
}));

const { createTestDb } = await import("@/lib/db");
const { getSessionSecret } = await import("@/lib/session-secret");

let close: () => Promise<void>;
beforeAll(async () => {
  ({ db: state.db, close } = await createTestDb());
});
afterAll(() => close());

let loginAction: typeof import("./actions").loginAction;
beforeEach(async () => {
  vi.stubEnv("APP_PASSWORD", "hunter2");
  vi.stubEnv("SESSION_SECRET", "");
  vi.stubEnv("TRUST_PROXY", "");
  vi.stubEnv("APP_URL", "http://localhost:3000");
  state.headers = new Headers();
  state.cookies.clear();
  // The throttle lives on globalThis (per process); start every test with a fresh one.
  delete (globalThis as { __flipwatchLoginThrottle?: unknown }).__flipwatchLoginThrottle;
  vi.resetModules();
  ({ loginAction } = await import("./actions"));
});
afterEach(() => {
  vi.unstubAllEnvs();
});

async function attempt(password: string, headers: Record<string, string> = {}): Promise<string> {
  state.headers = new Headers(headers);
  const form = new FormData();
  form.set("password", password);
  form.set("next", "/settings");
  try {
    const result = await loginAction({}, form);
    return result.error ?? "no error";
  } catch (error) {
    const digest = (error as { digest?: string }).digest ?? "";
    if (digest.startsWith("NEXT_REDIRECT")) return `redirect ${digest.split(";")[2]}`;
    throw error;
  }
}

describe("loginAction rate limiting", () => {
  it("can't be bypassed by rotating a spoofed X-Forwarded-For", async () => {
    for (let i = 1; i <= 10; i++) {
      await expect(attempt(`wrong-${i}`, { "x-forwarded-for": `10.9.0.${i}` })).resolves.toBe("Incorrect password.");
    }
    await expect(attempt("wrong-11", { "x-forwarded-for": "10.9.0.11" })).resolves.toMatch(/^Too many attempts/);
    await expect(attempt("hunter2", { "x-forwarded-for": "10.9.0.12" })).resolves.toMatch(/^Too many attempts/);
  });

  it("can't be bypassed by firing attempts in parallel", async () => {
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => attempt(`wrong-${i}`)));
    expect(results.filter((r) => r === "Incorrect password.")).toHaveLength(10);
    expect(results.filter((r) => r.startsWith("Too many attempts"))).toHaveLength(10);
  });

  it("with TRUST_PROXY, limits each client and still caps all clients together", async () => {
    vi.stubEnv("TRUST_PROXY", "true");
    // The client-supplied first hop is ignored; the address the proxy appended is the key.
    for (let i = 1; i <= 10; i++) await attempt("wrong", { "x-forwarded-for": `1.1.1.${i}, 198.51.100.1` });
    await expect(attempt("wrong", { "x-forwarded-for": "198.51.100.1" })).resolves.toMatch(/^Too many attempts/);
    await expect(attempt("wrong", { "x-forwarded-for": "198.51.100.2" })).resolves.toBe("Incorrect password.");

    for (let i = 3; i <= 41; i++) await attempt("wrong", { "x-forwarded-for": `198.51.100.${i}` });
    // 50 failures in the window: nobody gets another guess, even from a fresh address.
    await expect(attempt("wrong", { "x-forwarded-for": "203.0.113.1" })).resolves.toMatch(/^Too many attempts/);
  });
});

describe("loginAction session cookie", () => {
  it("signs the cookie with the generated secret, never APP_PASSWORD", async () => {
    await expect(attempt("hunter2")).resolves.toBe("redirect /settings");
    const cookie = state.cookies.get(SESSION_COOKIE)!;
    const secret = await getSessionSecret(state.db!);
    await expect(verifySessionToken(cookie.value, Date.now(), secret)).resolves.toBe(true);
    await expect(verifySessionToken(cookie.value, Date.now(), "hunter2")).resolves.toBe(false);
    expect(cookie.options).toMatchObject({ httpOnly: true, secure: false });
  });

  it("marks the cookie Secure when the request came over https", async () => {
    await expect(attempt("hunter2", { "x-forwarded-proto": "https" })).resolves.toBe("redirect /settings");
    expect(state.cookies.get(SESSION_COOKIE)!.options).toMatchObject({ secure: true });
  });
});
