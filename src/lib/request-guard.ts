/**
 * Which requests FlipWatch answers at all. FlipWatch often runs on 127.0.0.1 without a password, so two
 * browser-based attacks matter:
 *
 * - DNS rebinding: a website re-points its own domain at 127.0.0.1, so its page talks to FlipWatch as if it
 *   were same-origin (the browser sends `Host: evil.example`). Only requests addressed to FlipWatch's own
 *   names are answered: localhost / 127.0.0.1 / [::1] on any port, the APP_URL host, and ALLOWED_HOSTS.
 * - Cross-site requests: a page posting a form or a no-cors fetch to FlipWatch. Requests that can change
 *   something (anything but GET/HEAD/OPTIONS) are refused when the browser says they came from another site.
 *
 * Pure (no Next imports) so it can be tested directly; src/proxy.ts applies it to every request.
 */

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** "Example.com:3000" → { hostname: "example.com", port: "3000" }; null when malformed. */
function splitHost(value: string): { hostname: string; port: string } | null {
  const v = value.trim().toLowerCase();
  if (!v) return null;
  try {
    const url = new URL(`http://${v}`);
    return { hostname: url.hostname, port: url.port };
  } catch {
    return null;
  }
}

export interface GuardConfig {
  /** APP_URL (alert links, the public address behind a reverse proxy or Tailscale). */
  appUrl?: string | null;
  /** Extra host names or host:port pairs, comma-separated (ALLOWED_HOSTS). */
  allowedHosts?: string | null;
}

function allowedHostSet(cfg: GuardConfig): Set<string> {
  const allowed = new Set<string>();
  if (cfg.appUrl) {
    try {
      const url = new URL(cfg.appUrl);
      allowed.add(url.host.toLowerCase());
      allowed.add(url.hostname.toLowerCase());
    } catch {
      // ignore a malformed APP_URL
    }
  }
  for (const entry of (cfg.allowedHosts ?? "").split(",")) {
    const host = entry.trim().toLowerCase();
    if (host) allowed.add(host);
  }
  return allowed;
}

/** Whether a Host header (or an Origin's host) names this FlipWatch. */
export function isAllowedHost(host: string | null | undefined, cfg: GuardConfig): boolean {
  if (!host) return false;
  const parts = splitHost(host);
  if (!parts) return false;
  if (LOCAL_HOSTNAMES.has(parts.hostname)) return true;
  const allowed = allowedHostSet(cfg);
  return allowed.has(host.trim().toLowerCase()) || allowed.has(parts.hostname);
}

export type GuardDecision = { ok: true } | { ok: false; status: number; reason: string };

export function guardRequest(
  req: { method: string; host: string | null; origin: string | null; secFetchSite: string | null },
  cfg: GuardConfig,
): GuardDecision {
  if (!isAllowedHost(req.host, cfg)) {
    return { ok: false, status: 421, reason: "This FlipWatch only answers requests addressed to its own address. Set APP_URL (or ALLOWED_HOSTS) to the address you use." };
  }
  if (SAFE_METHODS.has(req.method.toUpperCase())) return { ok: true };
  if (req.origin && req.origin !== "null") {
    let originHost: string | null = null;
    try {
      originHost = new URL(req.origin).host;
    } catch {
      originHost = null;
    }
    if (!isAllowedHost(originHost, cfg)) return { ok: false, status: 403, reason: "Cross-site request refused." };
  } else if (req.origin === "null" || req.secFetchSite === "cross-site") {
    return { ok: false, status: 403, reason: "Cross-site request refused." };
  }
  return { ok: true };
}
