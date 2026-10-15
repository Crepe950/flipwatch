import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SESSION_TTL_MS,
  SHARED_CLIENT_KEY,
  checkPassword,
  createLoginThrottle,
  createRateLimiter,
  createSessionToken,
  decideAccess,
  generateSessionSecret,
  isPublicPath,
  loginRateLimitKey,
  loginRedirectPath,
  safeNextPath,
  sessionCookieOptions,
  timingSafeEqual,
  verifySessionToken,
} from "@/lib/auth";
import { config } from "@/lib/config";

const SECRET = "test-secret";
const NOW = Date.UTC(2026, 8, 28, 12, 0, 0);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("session tokens", () => {
  it("signs and verifies a v1 token with a 30-day expiry", async () => {
    const token = await createSessionToken(NOW, SECRET);
    const [version, expires, signature] = token.split(".");
    expect(version).toBe("v1");
    expect(Number(expires)).toBe(NOW + SESSION_TTL_MS);
    expect(signature).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await expect(verifySessionToken(token, NOW, SECRET)).resolves.toBe(true);
    await expect(verifySessionToken(token, NOW + SESSION_TTL_MS - 1, SECRET)).resolves.toBe(true);
  });

  it("rejects expired tokens", async () => {
    const token = await createSessionToken(NOW, SECRET);
    await expect(verifySessionToken(token, NOW + SESSION_TTL_MS, SECRET)).resolves.toBe(false);
    await expect(verifySessionToken(token, NOW + SESSION_TTL_MS + 60_000, SECRET)).resolves.toBe(false);
  });

  it("rejects tampered tokens and other secrets", async () => {
    const token = await createSessionToken(NOW, SECRET);
    const [version, expires, signature] = token.split(".");
    const extended = `${version}.${Number(expires) + SESSION_TTL_MS}.${signature}`;
    const flipped = `${version}.${expires}.${signature.slice(0, -1)}${signature.endsWith("A") ? "B" : "A"}`;
    await expect(verifySessionToken(extended, NOW, SECRET)).resolves.toBe(false);
    await expect(verifySessionToken(flipped, NOW, SECRET)).resolves.toBe(false);
    await expect(verifySessionToken(token, NOW, "another-secret")).resolves.toBe(false);
  });

  it("rejects malformed input", async () => {
    for (const bad of [undefined, null, "", "v1", "v1.123", "v2.9999999999999.sig", "v1.abc.sig", "v1.1.2.3", "x".repeat(300)]) {
      await expect(verifySessionToken(bad, NOW, SECRET)).resolves.toBe(false);
    }
  });

  it("never falls back to APP_PASSWORD as the signing secret", () => {
    vi.stubEnv("APP_PASSWORD", "hunter2");
    vi.stubEnv("SESSION_SECRET", "");
    expect(config.sessionSecret).toBeUndefined();
    vi.stubEnv("SESSION_SECRET", " s3cret ");
    expect(config.sessionSecret).toBe("s3cret");
  });

  it("generates random 256-bit secrets", () => {
    const a = generateSessionSecret();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateSessionSecret()).not.toBe(a);
  });
});

describe("password check", () => {
  it("compares against APP_PASSWORD", async () => {
    vi.stubEnv("APP_PASSWORD", "correct horse");
    await expect(checkPassword("correct horse")).resolves.toBe(true);
    await expect(checkPassword("correct horse ")).resolves.toBe(false);
    await expect(checkPassword("Correct horse")).resolves.toBe(false);
    await expect(checkPassword("")).resolves.toBe(false);
    await expect(checkPassword(null)).resolves.toBe(false);
    await expect(checkPassword(12345)).resolves.toBe(false);
  });

  it("never matches when no password is configured", async () => {
    vi.stubEnv("APP_PASSWORD", "");
    await expect(checkPassword("")).resolves.toBe(false);
    await expect(checkPassword("anything")).resolves.toBe(false);
  });

  it("timingSafeEqual handles different lengths", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
    expect(timingSafeEqual("", "")).toBe(true);
  });
});

describe("safeNextPath", () => {
  it.each([
    ["/searches", "/searches"],
    ["/searches/12/edit?duplicated=1", "/searches/12/edit?duplicated=1"],
    ["/settings#channels", "/settings#channels"],
    ["/listings/%2F%2Fevil.com", "/listings/%2F%2Fevil.com"],
  ])("keeps same-origin path %s", (input, expected) => {
    expect(safeNextPath(input)).toBe(expected);
  });

  it.each([
    "//evil.com",
    "///evil.com",
    "/\\evil.com",
    "\\\\evil.com",
    "/\t/evil.com",
    "/\n/evil.com",
    "https://evil.com",
    "javascript:alert(1)",
    "evil.com",
    "/.//evil.com",
    "/login",
    "/login?next=/x",
    "",
  ])("rejects %j", (input) => {
    expect(safeNextPath(input)).toBe("/");
  });

  it("rejects non-strings and oversized values", () => {
    expect(safeNextPath(undefined)).toBe("/");
    expect(safeNextPath(["/a"])).toBe("/");
    expect(safeNextPath(`/${"a".repeat(3000)}`)).toBe("/");
    expect(safeNextPath("//evil.com", "/searches")).toBe("/searches");
  });

  it("builds login URLs with an encoded next param", () => {
    expect(loginRedirectPath("/searches?x=1&y=2")).toBe("/login?next=%2Fsearches%3Fx%3D1%26y%3D2");
    expect(loginRedirectPath("/")).toBe("/login");
    expect(loginRedirectPath("//evil.com")).toBe("/login");
  });
});

describe("decideAccess", () => {
  const opts = { password: "pw", secret: SECRET };

  it("lets everything through when no password is set", async () => {
    await expect(decideAccess("/settings", undefined, NOW, { password: null, secret: SECRET })).resolves.toEqual({ kind: "allow" });
    await expect(decideAccess("/api/searches", undefined, NOW, { password: "", secret: SECRET })).resolves.toEqual({ kind: "allow" });
  });

  it("reads APP_PASSWORD from the environment by default", async () => {
    vi.stubEnv("APP_PASSWORD", "");
    await expect(decideAccess("/settings", undefined, NOW, { secret: SECRET })).resolves.toEqual({ kind: "allow" });
    vi.stubEnv("APP_PASSWORD", "pw");
    await expect(decideAccess("/settings", undefined, NOW, { secret: SECRET })).resolves.toEqual({ kind: "login", next: "/settings" });
  });

  it("resolves a lazy secret only when there is a cookie to check", async () => {
    const secret = vi.fn(async () => SECRET);
    await expect(decideAccess("/settings", undefined, NOW, { password: "pw", secret })).resolves.toEqual({ kind: "login", next: "/settings" });
    await expect(decideAccess("/login", "garbage", NOW, { password: "pw", secret })).resolves.toEqual({ kind: "allow" });
    expect(secret).not.toHaveBeenCalled();
    const token = await createSessionToken(NOW, SECRET);
    await expect(decideAccess("/settings", token, NOW, { password: "pw", secret })).resolves.toEqual({ kind: "allow" });
    expect(secret).toHaveBeenCalledOnce();
  });

  it.each([
    "/login",
    "/api/cron/tick",
    "/api/health",
    "/_next/static/chunks/app.js",
    "/favicon.ico",
    "/icon.svg",
    "/apple-icon.png",
    "/icons/icon-192.png",
    "/manifest.webmanifest",
    "/sw.js",
  ])(
    "keeps %s public",
    async (path) => {
      await expect(decideAccess(path, undefined, NOW, opts)).resolves.toEqual({ kind: "allow" });
    },
  );

  it("does not treat look-alike prefixes as public", async () => {
    expect(isPublicPath("/loginx")).toBe(false);
    expect(isPublicPath("/api/healthz")).toBe(false);
    expect(isPublicPath("/api/cronjobs")).toBe(false);
    await expect(decideAccess("/sw.js.map", undefined, NOW, opts)).resolves.toEqual({ kind: "login", next: "/sw.js.map" });
  });

  it("redirects pages and rejects APIs without a valid session", async () => {
    await expect(decideAccess("/", undefined, NOW, opts)).resolves.toEqual({ kind: "login", next: "/" });
    await expect(decideAccess("/searches/new", "garbage", NOW, opts)).resolves.toEqual({ kind: "login", next: "/searches/new" });
    await expect(decideAccess("/api/searches", undefined, NOW, opts)).resolves.toEqual({ kind: "unauthorized" });
    await expect(decideAccess("/api", undefined, NOW, opts)).resolves.toEqual({ kind: "unauthorized" });
  });

  it("allows a valid session until it expires", async () => {
    const token = await createSessionToken(NOW, SECRET);
    await expect(decideAccess("/settings", token, NOW, opts)).resolves.toEqual({ kind: "allow" });
    await expect(decideAccess("/api/searches", token, NOW, opts)).resolves.toEqual({ kind: "allow" });
    await expect(decideAccess("/settings", token, NOW + SESSION_TTL_MS + 1, opts)).resolves.toEqual({ kind: "login", next: "/settings" });
  });
});

describe("login rate limiter", () => {
  it("blocks after the limit and recovers when the window slides", () => {
    const limiter = createRateLimiter({ limit: 3, windowMs: 1_000 });
    for (let i = 0; i < 3; i++) {
      expect(limiter.check("1.2.3.4", NOW + i).allowed).toBe(true);
      limiter.recordFailure("1.2.3.4", NOW + i);
    }
    const blocked = limiter.check("1.2.3.4", NOW + 10);
    expect(blocked).toEqual({ allowed: false, retryAfterMs: 990 });
    expect(limiter.check("5.6.7.8", NOW + 10).allowed).toBe(true);
    expect(limiter.check("1.2.3.4", NOW + 1_000).allowed).toBe(true);
  });

  it("reset clears a key after a successful login", () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000 });
    limiter.recordFailure("ip", NOW);
    expect(limiter.check("ip", NOW).allowed).toBe(false);
    limiter.reset("ip");
    expect(limiter.check("ip", NOW).allowed).toBe(true);
  });

  it("bounds memory when many keys appear", () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, maxKeys: 10 });
    for (let i = 0; i < 50; i++) limiter.recordFailure(`ip-${i}`, NOW);
    // The newest keys are kept, the oldest dropped.
    expect(limiter.check("ip-49", NOW).allowed).toBe(false);
    expect(limiter.check("ip-0", NOW).allowed).toBe(true);
  });
});

describe("login throttle", () => {
  it("caps failures per client", () => {
    const throttle = createLoginThrottle({ perClient: 3, global: 10, windowMs: 1_000 });
    for (let i = 0; i < 3; i++) throttle.recordFailure("a", NOW);
    expect(throttle.check("a", NOW)).toEqual({ allowed: false, retryAfterMs: 1_000 });
    expect(throttle.check("b", NOW).allowed).toBe(true);
    throttle.reset("a");
    expect(throttle.check("a", NOW).allowed).toBe(true);
  });

  it("caps failures across all clients, so rotating addresses doesn't help", () => {
    const throttle = createLoginThrottle({ perClient: 3, global: 10, windowMs: 1_000 });
    for (let i = 0; i < 10; i++) {
      expect(throttle.check(`10.9.0.${i}`, NOW + i).allowed).toBe(true);
      throttle.recordFailure(`10.9.0.${i}`, NOW + i);
    }
    expect(throttle.check("10.9.0.99", NOW + 10)).toEqual({ allowed: false, retryAfterMs: 990 });
    // A successful login elsewhere doesn't lift the global cap.
    throttle.reset("10.9.0.0");
    expect(throttle.check("10.9.0.0", NOW + 10).allowed).toBe(false);
    expect(throttle.check("10.9.0.99", NOW + 1_000).allowed).toBe(true);
  });
});

describe("request helpers", () => {
  const spoofed = new Headers({ "x-forwarded-for": " 203.0.113.9 , 10.0.0.1", "x-real-ip": "10.0.0.2" });

  it("ignores client-supplied forwarding headers unless TRUST_PROXY is set", () => {
    vi.stubEnv("TRUST_PROXY", "");
    expect(loginRateLimitKey((n) => spoofed.get(n))).toBe(SHARED_CLIENT_KEY);
    expect(loginRateLimitKey((n) => spoofed.get(n), false)).toBe(SHARED_CLIENT_KEY);
    vi.stubEnv("TRUST_PROXY", "true");
    expect(loginRateLimitKey((n) => spoofed.get(n))).toBe("10.0.0.1");
  });

  it("uses the hop the trusted proxy appended, not the one the client sent", () => {
    expect(loginRateLimitKey((n) => spoofed.get(n), true)).toBe("10.0.0.1");
    expect(loginRateLimitKey((n) => new Headers({ "x-forwarded-for": "198.51.100.7" }).get(n), true)).toBe("198.51.100.7");
    expect(loginRateLimitKey(() => null, true)).toBe(SHARED_CLIENT_KEY);
  });

  it("marks the cookie Secure for https APP_URLs", () => {
    expect(sessionCookieOptions({ appUrl: "https://flip.example.com" })).toMatchObject({ httpOnly: true, sameSite: "lax", secure: true, path: "/" });
    expect(sessionCookieOptions({ appUrl: "http://localhost:3000" }).secure).toBe(false);
    expect(sessionCookieOptions({ appUrl: "http://localhost:3000" }).maxAge).toBe(30 * 24 * 60 * 60);
  });

  it("marks the cookie Secure when the request came over https", () => {
    expect(sessionCookieOptions({ appUrl: "http://localhost:3000", forwardedProto: "https" }).secure).toBe(true);
    expect(sessionCookieOptions({ appUrl: "http://localhost:3000", forwardedProto: "HTTPS, http" }).secure).toBe(true);
    expect(sessionCookieOptions({ appUrl: "http://localhost:3000", forwardedProto: "http" }).secure).toBe(false);
    expect(sessionCookieOptions({ appUrl: "http://localhost:3000", forwardedProto: null }).secure).toBe(false);
  });
});
