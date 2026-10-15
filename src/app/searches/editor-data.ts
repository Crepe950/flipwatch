import type { SearchFormProps } from "@/components/searches/search-form";
import type { MarketplaceOption } from "@/components/searches/marketplace-picker";
import { NOT_SET_UP, type SkipReasons } from "@/components/searches/run-messages";
import { aiStatus, type AiStatus } from "@/lib/ai";
import { config } from "@/lib/config";
import type { Db } from "@/lib/db";
import { countEnabledEbaySearches, ebayConfigured } from "@/lib/engine";
import { adapterUnavailableReason } from "@/lib/engine/fetch";
import { CRAIGSLIST_SITES, MAX_SITE_DISTANCE_KM } from "@/lib/marketplaces/craigslist/sites";
import { listAdapters } from "@/lib/marketplaces/registry";
import type { MarketplaceAdapter } from "@/lib/marketplaces/types";
import { listChannels } from "@/lib/queries/settings";

export function marketplaceOption(adapter: MarketplaceAdapter): MarketplaceOption {
  let status: { ok: boolean; message?: string };
  try {
    status = adapter.status();
  } catch (err) {
    status = { ok: false, message: `Status check failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  return {
    id: adapter.id,
    displayName: adapter.displayName,
    countries: [...adapter.countries],
    ok: status.ok,
    ...(status.message ? { message: status.message } : {}),
    minIntervalSec: adapter.minIntervalSec,
  };
}

/**
 * Why each marketplace would be skipped for a search in `countryCode`, in the engine's words (to
 * recognise them in run results and `lastError`) and short ones for display.
 */
export function skipReasonsFor(countryCode: string): SkipReasons {
  const reasons = new Map<MarketplaceAdapter["id"], { reason: string; short: string }>();
  for (const adapter of listAdapters()) {
    const reason = adapterUnavailableReason(adapter, countryCode);
    if (reason) reasons.set(adapter.id, { reason, short: marketplaceOption(adapter).ok ? reason : NOT_SET_UP });
  }
  return reasons;
}

export function safeAiStatus(): AiStatus {
  try {
    return aiStatus();
  } catch (err) {
    return { configured: false, model: "", message: err instanceof Error ? err.message : "AI status unavailable" };
  }
}

/** Everything the search editor needs besides the values themselves (`searchId`: the search being edited). */
export async function loadEditorOptions(db: Db, searchId: number | null = null): Promise<Omit<SearchFormProps, "searchId" | "initialValues">> {
  const [channels, ebayOtherSearches] = await Promise.all([
    listChannels(db),
    // The eBay quota only binds when eBay is set up.
    ebayConfigured() ? countEnabledEbaySearches(db, searchId ?? undefined) : null,
  ]);
  const ai = safeAiStatus();
  return {
    marketplaces: listAdapters().map(marketplaceOption),
    channels: channels.map((c) => ({ id: c.id, name: c.name, type: c.type, enabled: c.enabled })),
    ai: { configured: ai.configured, model: ai.model, ...(ai.message ? { message: ai.message } : {}) },
    minPollIntervalSec: Math.max(30, config.minPollIntervalSec),
    ebayOtherSearches,
    craigslist: {
      sites: CRAIGSLIST_SITES.map(({ site, label, countryCode, lat, lng }) => ({ site, label, countryCode, lat, lng })),
      maxDistanceKm: MAX_SITE_DISTANCE_KM,
    },
  };
}
