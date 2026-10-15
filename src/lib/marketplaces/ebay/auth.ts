import { fetchJson } from "../http";
import type { AdapterContext } from "../types";
import { NotConfiguredError, ParseError } from "../types";
import type { EbayCredentials } from "./credentials";
import { EBAY_SETUP_HINT } from "./credentials";
import { asObject, asString } from "../json";
import { withDetail, withResponseTrace } from "./traced-fetch";

export const EBAY_TOKEN_URL = "https://api.ebay.com/identity/v1/oauth2/token";
export const EBAY_API_SCOPE = "https://api.ebay.com/oauth/api_scope";

/** Refresh this long before eBay says the token expires, so in-flight searches never race the expiry. */
const EXPIRY_MARGIN_SEC = 60;

interface CachedToken {
  accessToken: string;
  /** Epoch ms after which the token must not be used. */
  expiresAt: number;
}

// Process-wide: one application token per keyset, shared by every search.
const tokens = new Map<string, CachedToken>();
const pending = new Map<string, Promise<CachedToken>>();
let generation = 0;

function cacheKey(creds: EbayCredentials): string {
  // Keyed by id *and* secret so a rotated secret never reuses a token minted with the old one.
  return `${creds.clientId}\u0000${creds.clientSecret}`;
}

/** Forget every cached token (tests, or after credentials change). */
export function resetEbayTokenCache(): void {
  tokens.clear();
  pending.clear();
  generation++;
}

/** Drop a token eBay rejected — but only if it is still the cached one (another search may have refreshed it). */
export function invalidateEbayAccessToken(creds: EbayCredentials, accessToken: string): void {
  const key = cacheKey(creds);
  if (tokens.get(key)?.accessToken === accessToken) tokens.delete(key);
}

/**
 * Application access token (OAuth client-credentials grant), cached until shortly before it expires.
 * Concurrent callers share one in-flight token request.
 */
export async function getEbayAccessToken(ctx: AdapterContext, creds: EbayCredentials): Promise<string> {
  const key = cacheKey(creds);
  const cached = tokens.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.accessToken;

  let inflight = pending.get(key);
  if (!inflight) {
    const startedIn = generation;
    const request = requestAccessToken(ctx, creds);
    inflight = request
      .then((token) => {
        if (startedIn === generation && token.expiresAt > Date.now()) tokens.set(key, token);
        return token;
      })
      .finally(() => {
        if (pending.get(key) === inflight) pending.delete(key);
      });
    pending.set(key, inflight);
  }
  return (await inflight).accessToken;
}

async function requestAccessToken(ctx: AdapterContext, creds: EbayCredentials): Promise<CachedToken> {
  const { ctx: traced, trace } = withResponseTrace(ctx);
  const basic = Buffer.from(`${creds.clientId}:${creds.clientSecret}`, "utf8").toString("base64");

  let body: unknown;
  try {
    body = await fetchJson(traced, "ebay", EBAY_TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: `grant_type=client_credentials&scope=${encodeURIComponent(EBAY_API_SCOPE)}`,
    });
  } catch (err) {
    // 401 invalid_client / 400 invalid_scope: the keyset is wrong — retrying won't help until config changes.
    if (trace.status === 400 || trace.status === 401) {
      const reason = trace.detail ?? `HTTP ${trace.status}`;
      throw new NotConfiguredError(`eBay rejected the API keys (${reason}). ${EBAY_SETUP_HINT}`, "ebay");
    }
    throw withDetail(err, trace);
  }

  const root = asObject(body);
  const accessToken = asString(root?.access_token);
  if (!accessToken) throw new ParseError("eBay token response did not include an access_token", "ebay");
  const expiresIn = Number(root?.expires_in);
  const lifetimeSec = Number.isFinite(expiresIn) ? expiresIn - EXPIRY_MARGIN_SEC : 0;
  return { accessToken, expiresAt: Date.now() + lifetimeSec * 1000 };
}
