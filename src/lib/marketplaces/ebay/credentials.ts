import { config } from "../../config";
import type { AdapterContext, AdapterStatus } from "../types";
import type { EbaySearchOptions } from "./browse-request";
import { normalizeMarketplaceId } from "./marketplace";

export interface EbayCredentials {
  clientId: string;
  clientSecret: string;
}

export const EBAY_SETUP_HINT =
  "Create a free developer account at https://developer.ebay.com, create an application and copy its " +
  "Production keyset (App ID and Cert ID) into Settings → eBay.";

const QUOTA_NOTE =
  "The Browse API's default quota is 5,000 calls/day, shared by all eBay searches " +
  "(one search polled every 60 s uses about 1,440).";

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Context credentials win; the environment is the fallback for hand-built contexts. */
export function resolveEbayCredentials(ctx?: AdapterContext): EbayCredentials | null {
  const clientId = clean(ctx?.credentials.ebayClientId) ?? config.ebayClientId;
  const clientSecret = clean(ctx?.credentials.ebayClientSecret) ?? config.ebayClientSecret;
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

/** Raw marketplace id override (EBAY_MARKETPLACE_ID), before validation. */
export function marketplaceIdOverride(ctx?: AdapterContext): string | undefined {
  return clean(ctx?.credentials.ebayMarketplaceId) ?? config.ebayMarketplaceId;
}

/** What to search for (EBAY_INCLUDE_AUCTIONS, EBAY_LOCAL_PICKUP_ONLY). */
export function ebaySearchOptions(): EbaySearchOptions {
  return { includeAuctions: config.ebayIncludeAuctions, localPickupOnly: config.ebayLocalPickupOnly };
}

export function missingCredentialsMessage(hasId: boolean, hasSecret: boolean): string {
  const missing = [!hasId && "App ID", !hasSecret && "Cert ID"].filter(Boolean).join(" and ");
  return `eBay needs its free API keys (${missing} missing). ${EBAY_SETUP_HINT} ${QUOTA_NOTE}`;
}

export function invalidMarketplaceIdMessage(raw: string): string {
  return `EBAY_MARKETPLACE_ID "${raw}" is not an eBay marketplace id (expected e.g. EBAY_US or EBAY_CA); unset it to pick one from the search's country.`;
}

export function ebayStatus(): AdapterStatus {
  const clientId = config.ebayClientId;
  const clientSecret = config.ebayClientSecret;
  if (!clientId || !clientSecret) {
    return { ok: false, message: missingCredentialsMessage(Boolean(clientId), Boolean(clientSecret)) };
  }
  const override = config.ebayMarketplaceId;
  if (override && !normalizeMarketplaceId(override)) {
    return { ok: false, message: invalidMarketplaceIdMessage(override) };
  }
  const site = override ? `the ${normalizeMarketplaceId(override)} marketplace` : "EBAY_US / EBAY_CA by search country";
  return { ok: true, message: `Using the official eBay Browse API (${site}). ${QUOTA_NOTE}` };
}
