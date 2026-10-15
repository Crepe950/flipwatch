/**
 * Password gate primitives: signed session tokens, constant-time password checks, safe redirect
 * targets, the proxy's access decision and the login rate limiter.
 *
 * Runtime-agnostic on purpose (Web Crypto only, no Node or Next APIs) so the same code runs in the
 * proxy, server actions, route handlers and tests.
 */
import { config } from "./config";

export const SESSION_COOKIE = "fw_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const TOKEN_VERSION = "v1";
const MAX_TOKEN_LENGTH = 256;
const MAX_PASSWORD_LENGTH = 1024;

const encoder = new TextEncoder();
const hmacKeys = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
  let key = hmacKeys.get(secret);
  if (!key) {
    key = crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    // The secret only changes when the environment does; keep the cache from growing regardless.
    if (hmacKeys.size > 8) hmacKeys.clear();
    hmacKeys.set(secret, key);
  }
  return key;
}

function toBase64Url(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sign(payload: string, secret: string): Promise<string> {
  return toBase64Url(await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(payload)));
}

/** A fresh random 256-bit session signing secret (base64url). */
export function generateSessionSecret(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)).buffer);
}

/**
 * Compare two strings without short-circuiting on the first difference. Only the length of the
 * longer input can leak through timing, which is fine for fixed-length digests and signatures.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const length = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < length; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/**
 * A session token: "v1.<expiresAtMs>.<base64url HMAC-SHA256 of 'v1.<expiresAtMs>'>". The secret is
 * SESSION_SECRET or the generated one from lib/session-secret.ts — never APP_PASSWORD.
 */
export async function createSessionToken(now: number, secret: string): Promise<string> {
  const payload = `${TOKEN_VERSION}.${now + SESSION_TTL_MS}`;
  return `${payload}.${await sign(payload, secret)}`;
}

export async function verifySessionToken(token: string | null | undefined, now: number, secret: string): Promise<boolean> {
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [version, expires, signature] = parts;
  if (version !== TOKEN_VERSION || !/^\d{1,15}$/.test(expires)) return false;
  if (Number(expires) <= now) return false;
  const expected = await sign(`${version}.${expires}`, secret);
  return timingSafeEqual(signature, expected);
}

async function sha256(value: string): Promise<string> {
  return toBase64Url(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

/** Constant-time check against APP_PASSWORD (hashing first so lengths don't leak). */
export async function checkPassword(input: unknown, expected: string | undefined = config.appPassword): Promise<boolean> {
  if (!expected || typeof input !== "string" || input.length === 0 || input.length > MAX_PASSWORD_LENGTH) return false;
  const [a, b] = await Promise.all([sha256(input), sha256(expected)]);
  return timingSafeEqual(a, b);
}

/**
 * Cookie attributes for the session cookie. Secure when APP_URL is https, or when this request came
 * over HTTPS: `forwardedProto` is the x-forwarded-proto header, which Next.js fills in from the
 * connection unless a reverse proxy (or the client) already set it. Trusting it here is safe even
 * without TRUST_PROXY: a spoofed value only changes the flag on the spoofer's own cookie.
 */
export function sessionCookieOptions({ appUrl = config.appUrl, forwardedProto }: { appUrl?: string; forwardedProto?: string | null } = {}) {
  const requestIsHttps = forwardedProto?.split(",")[0]?.trim().toLowerCase() === "https";
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: appUrl.toLowerCase().startsWith("https://") || requestIsHttps,
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  };
}

const NEXT_BASE = "http://flipwatch.invalid";

function isLoginPath(pathname: string): boolean {
  return pathname === "/login" || pathname.startsWith("/login/");
}

/**
 * Sanitize a post-login redirect target. Only same-origin relative paths are allowed
 * ("/searches?x=1"); anything that a browser could resolve to another origin falls back.
 */
export function safeNextPath(raw: unknown, fallback = "/"): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) return fallback;
  // "//evil.com" and "/\evil.com" are protocol-relative in browsers; control chars (tabs, newlines)
  // are stripped by URL parsers and can smuggle the same thing ("/\t/evil.com").
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\") || /[\u0000-\u001f\u007f]/.test(raw)) {
    return fallback;
  }
  let url: URL;
  try {
    url = new URL(raw, NEXT_BASE);
  } catch {
    return fallback;
  }
  if (url.origin !== NEXT_BASE) return fallback;
  // Dot segments can normalize into a protocol-relative path ("/.//evil.com" → "//evil.com").
  if (url.pathname.startsWith("//") || isLoginPath(url.pathname)) return fallback;
  return `${url.pathname}${url.search}${url.hash}`;
}

const PUBLIC_EXACT = new Set(["/favicon.ico", "/icon.svg", "/apple-icon.png", "/manifest.webmanifest", "/sw.js"]);
// /icons: the PWA's manifest icons and the push notification badge, fetched by the browser itself.
const PUBLIC_PREFIXES = ["/login", "/api/cron", "/api/health", "/_next", "/icons"];

/** Paths reachable without a session (login, health/cron endpoints, static assets). */
export function isPublicPath(pathname: string): boolean {
  if (PUBLIC_EXACT.has(pathname)) return true;
  return PUBLIC_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export type AccessDecision = { kind: "allow" } | { kind: "login"; next: string } | { kind: "unauthorized" };

export interface AccessOptions {
  /** Defaults to config.appPassword; the gate is off when empty. */
  password?: string | null;
  /** The session signing secret, or a function resolving it (only called when a cookie needs checking). */
  secret: string | (() => Promise<string>);
}

/**
 * What the proxy should do with a request: let it through, send a page request to /login, or
 * answer an API request with 401.
 */
export async function decideAccess(
  pathname: string,
  cookieValue: string | null | undefined,
  now: number,
  opts: AccessOptions,
): Promise<AccessDecision> {
  const password = opts.password === undefined ? config.appPassword : opts.password;
  if (!password || isPublicPath(pathname)) return { kind: "allow" };
  if (cookieValue) {
    const secret = typeof opts.secret === "function" ? await opts.secret() : opts.secret;
    if (await verifySessionToken(cookieValue, now, secret)) return { kind: "allow" };
  }
  if (pathname === "/api" || pathname.startsWith("/api/")) return { kind: "unauthorized" };
  return { kind: "login", next: pathname };
}

/** Build the /login URL (path + query) for a blocked page request. */
export function loginRedirectPath(next: string): string {
  const safe = safeNextPath(next, "");
  return safe && safe !== "/" ? `/login?next=${encodeURIComponent(safe)}` : "/login";
}

/** The rate-limit key every client shares when client addresses can't be trusted. */
export const SHARED_CLIENT_KEY = "all-clients";

/**
 * Rate-limit key for a login attempt. Clients can send any X-Forwarded-For, so it is only used with
 * TRUST_PROXY=true, and then only its last entry: the address your reverse proxy saw (proxies append
 * to whatever the client sent). Otherwise every client shares one key, so rotating spoofed headers
 * can't reset the limit.
 */
export function loginRateLimitKey(getHeader: (name: string) => string | null | undefined, trustProxy: boolean = config.trustProxy): string {
  if (!trustProxy) return SHARED_CLIENT_KEY;
  const hops = getHeader("x-forwarded-for")?.split(",") ?? [];
  const last = hops[hops.length - 1]?.trim();
  return last ? last.slice(0, 64) : SHARED_CLIENT_KEY;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Milliseconds until the oldest counted attempt expires (0 when allowed). */
  retryAfterMs: number;
}

export interface RateLimiter {
  check(key: string, now?: number): RateLimitResult;
  recordFailure(key: string, now?: number): void;
  reset(key: string): void;
}

/** In-memory sliding-window limiter for failed attempts per key. Per process; resets on restart. */
export function createRateLimiter({ limit, windowMs, maxKeys = 5_000 }: { limit: number; windowMs: number; maxKeys?: number }): RateLimiter {
  const attempts = new Map<string, number[]>();

  const recent = (key: string, now: number): number[] => {
    const list = (attempts.get(key) ?? []).filter((t) => now - t < windowMs);
    if (list.length) attempts.set(key, list);
    else attempts.delete(key);
    return list;
  };

  const prune = (now: number) => {
    for (const key of [...attempts.keys()]) recent(key, now);
    // Still too many distinct keys (e.g. a spray of spoofed IPs): drop the oldest ones.
    const excess = attempts.size - maxKeys;
    if (excess > 0) [...attempts.keys()].slice(0, excess).forEach((key) => attempts.delete(key));
  };

  return {
    check(key, now = Date.now()) {
      const list = recent(key, now);
      if (list.length < limit) return { allowed: true, retryAfterMs: 0 };
      return { allowed: false, retryAfterMs: Math.max(0, windowMs - (now - list[0])) };
    },
    recordFailure(key, now = Date.now()) {
      const list = recent(key, now);
      list.push(now);
      attempts.delete(key);
      attempts.set(key, list);
      if (attempts.size > maxKeys) prune(now);
    },
    reset(key) {
      attempts.delete(key);
    },
  };
}

const GLOBAL_KEY = "*";

/**
 * Login throttle: at most `perClient` failed attempts per key and `global` across all keys within
 * `windowMs`, so an attacker rotating client addresses is still capped. A successful login only
 * clears its own key.
 */
export function createLoginThrottle({ perClient, global, windowMs }: { perClient: number; global: number; windowMs: number }): RateLimiter {
  const clients = createRateLimiter({ limit: perClient, windowMs });
  const everyone = createRateLimiter({ limit: global, windowMs, maxKeys: 1 });
  return {
    check(key, now = Date.now()) {
      const blocked = [clients.check(key, now), everyone.check(GLOBAL_KEY, now)].filter((r) => !r.allowed);
      if (blocked.length === 0) return { allowed: true, retryAfterMs: 0 };
      return { allowed: false, retryAfterMs: Math.max(...blocked.map((r) => r.retryAfterMs)) };
    },
    recordFailure(key, now = Date.now()) {
      clients.recordFailure(key, now);
      everyone.recordFailure(GLOBAL_KEY, now);
    },
    reset(key) {
      clients.reset(key);
    },
  };
}
