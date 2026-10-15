import { config } from "../config";
import type { MarketplaceId } from "../types";
import craigslist from "./craigslist";
import ebay from "./ebay";
import facebook from "./facebook";
import kijiji from "./kijiji";
import offerup from "./offerup";
import type { AdapterContext, MarketplaceAdapter } from "./types";

export const ADAPTERS: Record<MarketplaceId, MarketplaceAdapter> = {
  craigslist,
  kijiji,
  ebay,
  offerup,
  facebook,
};

export function getAdapter(id: MarketplaceId): MarketplaceAdapter {
  return ADAPTERS[id];
}

export function listAdapters(): MarketplaceAdapter[] {
  return Object.values(ADAPTERS);
}

/** Build the runtime context adapters receive, from environment configuration. */
export function createAdapterContext(overrides: Partial<AdapterContext> = {}): AdapterContext {
  return {
    fetch: globalThis.fetch.bind(globalThis),
    log: (m) => console.log(`[marketplace] ${m}`),
    credentials: {
      ebayClientId: config.ebayClientId,
      ebayClientSecret: config.ebayClientSecret,
      ebayMarketplaceId: config.ebayMarketplaceId,
      // No facebookCookies: the Facebook adapter reads every configured account (FACEBOOK_COOKIES, _2, _3) and
      // splits traffic by FACEBOOK_ACCOUNT_SHARES. Cookies set here would pin all traffic to that one account.
    },
    ...overrides,
  };
}
