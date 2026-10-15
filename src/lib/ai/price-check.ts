/**
 * Market price check: Claude identifies the item (and, for a computer, its resellable parts), FlipWatch
 * searches the marketplaces for current listings of each, and Claude prices the item and every part from
 * those comparables. Facebook Marketplace is searched with the configured session cookie.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db";
import { priceChecks, searches, type Listing } from "../db/schema";
import { adapterUnavailableReason, fetchMarketplace } from "../engine/fetch";
import { mapWithConcurrency } from "../engine/async";
import { withFullDescription } from "../engine/listing-details";
import { errorMessage } from "../engine/log";
import { formatPrice } from "../format";
import { getDefaultLocation } from "../queries/settings";
import { getAdapter } from "../marketplaces/registry";
import { getBestMatchSearchId } from "../queries/listings";
import type { MarketplaceId, ScrapedListing, SearchLocation } from "../types";
import { getAiClient, isAiConfigured, resolveModel } from "./client";
import { loadListing } from "./context";
import { AiNotConfiguredError, AiRequestError, toAiError } from "./errors";
import { aiLimiter } from "./limiter";
import { responseText } from "./response";
import { stripCandidateIds } from "./text";

/**
 * Searched in this order; Facebook uses the session cookie from FACEBOOK_COOKIES. eBay (official Browse API,
 * country-wide) is used when EBAY_CLIENT_ID/SECRET are set — it fills in rare items local markets barely list.
 */
export const PRICE_CHECK_MARKETPLACES: MarketplaceId[] = ["facebook", "craigslist", "ebay"];
/** Comparison sources that are simply skipped (not reported as a problem) when they aren't set up. */
const OPTIONAL_SOURCES: ReadonlySet<MarketplaceId> = new Set(["ebay"]);
export const MAX_PARTS = 6;
const COMPS_PER_QUERY = 25;
const MAX_TOKENS = 16_000;
const MAX_CENTS = 2_000_000_000;

export type PriceCheckKind = "computer" | "part" | "other";

export interface PriceCheckComp {
  id: string;
  marketplace: MarketplaceId;
  title: string;
  priceCents: number;
  url: string;
}

export interface PriceEstimate {
  /** "item" for the listing as a whole, "p0".."p5" for parts. */
  key: string;
  /** Component type for parts ("GPU", "CPU", …); null for the whole item. */
  component: string | null;
  name: string;
  query: string;
  lowCents: number | null;
  typicalCents: number | null;
  highCents: number | null;
  /** Comparable listings Claude based the estimate on (ids into PriceCheckResult.comps). */
  compIds: string[];
  note: string;
}

export interface PriceCheckResult {
  kind: PriceCheckKind;
  currency: string;
  askingPriceCents: number | null;
  item: PriceEstimate;
  parts: PriceEstimate[];
  /** Sum of the parts' typical prices, when every part has one. */
  partOutTotalCents: number | null;
  summary: string;
  /** Per marketplace: how many listings came back, or why it failed. */
  sources: Array<{ marketplace: MarketplaceId; results: number; errors: string[] }>;
  comps: PriceCheckComp[];
}

// --- step 1: identify the item and its parts ---------------------------------------------------

const PLAN_SCHEMA = {
  type: "object",
  properties: {
    kind: {
      type: "string",
      enum: ["computer", "part", "other"],
      description: "computer = a complete desktop/laptop/server/mini PC; part = a single component or peripheral; other = anything else.",
    },
    item: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short name of the item as listed, e.g. 'Lenovo Legion Y520 (i7-7700HQ, GTX 1060)'." },
        searchQuery: { type: "string", description: "2-5 word marketplace search phrase for the same item, e.g. 'legion y520'." },
      },
      required: ["name", "searchQuery"],
      additionalProperties: false,
    },
    parts: {
      type: "array",
      description: `Only for kind=computer and only desktops/servers whose parts can be resold separately (not laptops or all-in-ones): up to ${MAX_PARTS} components identified in the listing that have resale value (CPU, GPU, RAM, storage, motherboard, PSU, case). Empty otherwise.`,
      items: {
        type: "object",
        properties: {
          component: { type: "string", description: "CPU, GPU, RAM, SSD, HDD, Motherboard, PSU, Case, Cooler or Monitor." },
          name: { type: "string", description: "Specific part as described, e.g. 'RTX 3070 8GB' or '16GB DDR4 3200 (2x8GB)'." },
          searchQuery: { type: "string", description: "2-4 word search phrase for that exact part, e.g. 'rtx 3070', 'i7 9700k', '16gb ddr4'." },
        },
        required: ["component", "name", "searchQuery"],
        additionalProperties: false,
      },
    },
  },
  required: ["kind", "item", "parts"],
  additionalProperties: false,
};

const PLAN_SYSTEM = [
  "You identify second-hand marketplace listings so their market value can be looked up.",
  "Read the title and description, decide what the item is and write short search phrases that a buyer would type into Facebook Marketplace or Craigslist to find the same item.",
  "Search phrases must be specific enough to find the same model (include model numbers, capacity or generation) but short: marketplaces match loosely.",
  "Only list parts that the listing actually names or clearly implies; never invent specs.",
].join(" ");

const planSchema = z.object({
  kind: z.enum(["computer", "part", "other"]).catch("other"),
  item: z.object({ name: z.string(), searchQuery: z.string() }),
  parts: z
    .array(z.object({ component: z.string(), name: z.string(), searchQuery: z.string() }))
    .catch([]),
});
type Plan = z.infer<typeof planSchema>;

// --- step 2: price from comparables ------------------------------------------------------------

const estimateProperties = {
  key: { type: "string", description: "The target key exactly as given (item, p0, p1, …)." },
  low: { type: ["number", "null"], description: "Low end of what it realistically sells for, major units of the listing currency." },
  typical: { type: ["number", "null"], description: "Typical realistic selling price, major units." },
  high: { type: ["number", "null"], description: "High end of what it realistically sells for, major units." },
  compIds: { type: "array", items: { type: "string" }, description: "Ids (c1, c2, …) of the comparable listings you relied on." },
  note: { type: "string", description: "One short sentence: how many good comps, and any caveat (few comps, wide spread, used own knowledge)." },
};

const PRICE_SCHEMA = {
  type: "object",
  properties: {
    estimates: {
      type: "array",
      description: "One entry per target, in the order given.",
      items: { type: "object", properties: estimateProperties, required: Object.keys(estimateProperties), additionalProperties: false },
    },
    summary: {
      type: "string",
      description: "Two sentences max: is the asking price below, at or above market, and (for computers with parts) whether parting it out beats selling it whole.",
    },
  },
  required: ["estimates", "summary"],
  additionalProperties: false,
};

const PRICE_SYSTEM = [
  "You price second-hand items for a reseller using current marketplace listings as comparables.",
  "For each target, keep only comparables that are the same item (same model, generation and capacity) in working condition; ignore accessories, bundles with other items, wanted/ISO posts, broken or for-parts units (unless the target is), and obvious outliers.",
  "Listings show asking prices, and items usually sell 10-20% below asking: low/typical/high must be realistic selling prices, not asking prices.",
  "eBay comparables are country-wide asking prices before shipping and fees, and usually run above local pick-up prices: the reseller sells locally, so weight local (Facebook, Craigslist) comparables first and use eBay mainly when local ones are scarce, as for rare or niche items.",
  "If fewer than two comparables fit, estimate from your own knowledge of the used market, keep the range wide and say so in the note.",
  "Use null only when the item cannot be identified at all.",
  "Never mention comparable ids (c1, c2, …) in the summary or notes: list them only in compIds.",
].join(" ");

const moneyValue = z.preprocess((v) => (typeof v === "string" ? Number(v.replace(/[^0-9.]/g, "")) : v), z.number().nullable()).catch(null);
const priceSchema = z.object({
  estimates: z.array(
    z.object({
      key: z.string(),
      low: moneyValue,
      typical: moneyValue,
      high: moneyValue,
      compIds: z.array(z.string()).catch([]),
      note: z.string().catch(""),
    }),
  ),
  summary: z.string().catch(""),
});

// --- helpers -----------------------------------------------------------------------------------

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  try {
    return JSON.parse(start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed);
  } catch {
    throw new AiRequestError("Claude returned a price check that is not valid JSON");
  }
}

/** "item" / "p0".."p5" out of whatever Claude wrote in the key field, or the raw key when there is none. */
export function normalizeTargetKey(key: string): string {
  return key.match(/\b(item|p\d+)\b/i)?.[1].toLowerCase() ?? key.trim().toLowerCase();
}

function toCents(major: number | null): number | null {
  if (major === null || !Number.isFinite(major) || major < 0) return null;
  const cents = Math.round(major * 100);
  return cents > MAX_CENTS ? null : cents;
}

async function ask(system: string, text: string, schema: object): Promise<string> {
  const client = getAiClient();
  const body: Anthropic.MessageCreateParamsNonStreaming = {
    model: resolveModel(),
    max_tokens: MAX_TOKENS,
    system,
    messages: [{ role: "user", content: text }],
    output_config: { format: { type: "json_schema", schema: schema as Record<string, unknown> } },
  };
  try {
    return responseText(await aiLimiter.run(() => client.messages.create(body), { priority: "high" }));
  } catch (err) {
    throw toAiError(err);
  }
}

function describeListing(listing: Listing): string {
  const price = listing.priceCents === null ? "no price" : formatPrice(listing.priceCents, listing.currency);
  const description = (listing.description ?? "").trim().slice(0, 3000);
  return [`Title: ${listing.title}`, `Asking price: ${price} (${listing.currency})`, description ? `Description:\n${description}` : "No description."].join("\n");
}

async function searchLocation(db: Db, listingId: number): Promise<SearchLocation> {
  const searchId = await getBestMatchSearchId(db, listingId);
  if (searchId !== null) {
    const [row] = await db.select({ location: searches.location }).from(searches).where(eq(searches.id, searchId)).limit(1);
    if (row?.location) return row.location;
  }
  return getDefaultLocation(db);
}

interface Target {
  key: string;
  component: string | null;
  name: string;
  query: string;
}

function targetsFrom(plan: Plan): Target[] {
  const targets: Target[] = [{ key: "item", component: null, name: plan.item.name.trim(), query: plan.item.searchQuery.trim() }];
  const parts = plan.kind === "computer" ? plan.parts.slice(0, MAX_PARTS) : [];
  parts.forEach((p, i) => targets.push({ key: `p${i}`, component: p.component.trim(), name: p.name.trim(), query: p.searchQuery.trim() }));
  return targets.filter((t) => t.query);
}

/**
 * Search results shared by several price checks (e.g. every pick of one Deal Hunt), keyed by marketplace,
 * location and query: three PCs with a GTX 1070 search "gtx 1070" once, which keeps the number of requests
 * made with the Facebook session down.
 */
export type CompCache = Map<string, Promise<ScrapedListing[]>>;

/** Current listings for every target's query on every usable marketplace. */
async function gatherComps(listing: Listing, targets: Target[], location: SearchLocation, cache: CompCache = new Map()) {
  const sources = new Map<MarketplaceId, { marketplace: MarketplaceId; results: number; errors: string[] }>();
  const adapters = PRICE_CHECK_MARKETPLACES.map(getAdapter).filter((adapter) => {
    const reason = adapterUnavailableReason(adapter, location.countryCode);
    if (reason && !OPTIONAL_SOURCES.has(adapter.id)) sources.set(adapter.id, { marketplace: adapter.id, results: 0, errors: [reason] });
    return !reason;
  });
  for (const adapter of adapters) sources.set(adapter.id, { marketplace: adapter.id, results: 0, errors: [] });

  const jobs = targets.flatMap((target) => adapters.map((adapter) => ({ target, adapter })));
  // The shared gate spaces requests to the same marketplace; different marketplaces run in parallel.
  const settled = await mapWithConcurrency(jobs, Math.max(1, jobs.length), async ({ target, adapter }) => {
    try {
      const key = `${adapter.id}|${location.label}|${location.radiusKm}|${target.query.trim().toLowerCase()}`;
      let pending = cache.get(key);
      if (!pending) {
        pending = fetchMarketplace(
          adapter,
          { keywords: target.query, minPriceCents: null, maxPriceCents: null, location, category: null, limit: COMPS_PER_QUERY, interactive: true },
          {},
        );
        cache.set(key, pending);
      }
      const found = await pending;
      return { target, marketplace: adapter.id, found };
    } catch (err) {
      sources.get(adapter.id)?.errors.push(`"${target.query}": ${errorMessage(err)}`);
      return { target, marketplace: adapter.id, found: [] };
    }
  });
  const results = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));

  const comps: PriceCheckComp[] = [];
  const byTarget = new Map<string, PriceCheckComp[]>();
  const seen = new Map<string, PriceCheckComp>();
  for (const { target, marketplace, found } of results) {
    const list = byTarget.get(target.key) ?? [];
    for (const l of found.slice(0, COMPS_PER_QUERY)) {
      // Skip the listing itself, unpriced and placeholder-priced listings, and other currencies.
      if ((l.marketplace === listing.marketplace && l.externalId === listing.externalId) || l.priceCents === null || l.priceCents <= 100) continue;
      if (l.currency && l.currency !== listing.currency) continue;
      const dedupeKey = `${l.marketplace}:${l.externalId}`;
      let comp = seen.get(dedupeKey);
      if (!comp) {
        comp = { id: `c${comps.length + 1}`, marketplace, title: l.title, priceCents: l.priceCents, url: l.url };
        seen.set(dedupeKey, comp);
        comps.push(comp);
      }
      if (!list.includes(comp)) list.push(comp);
    }
    byTarget.set(target.key, list);
    const source = sources.get(marketplace);
    if (source) source.results += found.length;
  }
  return { comps, byTarget, sources: [...sources.values()] };
}

// --- public API --------------------------------------------------------------------------------

/** Run a market price check for a listing and store it. Takes a minute or two: many marketplace searches. */
export async function priceCheckListing(
  db: Db,
  listingId: number,
  opts: { compCache?: CompCache; location?: SearchLocation } = {},
): Promise<PriceCheckResult> {
  if (!isAiConfigured()) throw new AiNotConfiguredError();
  // Value what the seller actually describes, not what a vague title suggests.
  const listing = await withFullDescription(db, await loadListing(db, listingId), { interactive: true });

  const planJson = planSchema.safeParse(extractJson(await ask(PLAN_SYSTEM, describeListing(listing), PLAN_SCHEMA)));
  if (!planJson.success) throw new AiRequestError("Claude could not identify this item");
  const targets = targetsFrom(planJson.data);
  if (targets.length === 0) throw new AiRequestError("Claude could not work out what to search for");

  const location = opts.location ?? (await searchLocation(db, listingId));
  const { comps, byTarget, sources } = await gatherComps(listing, targets, location, opts.compCache);

  const targetText = targets
    .map((t) => {
      const lines = (byTarget.get(t.key) ?? []).map((c) => `  ${c.id} | ${formatPrice(c.priceCents, listing.currency)} | ${c.marketplace} | ${c.title}`);
      const label = t.component ? `${t.component}: ${t.name}` : `Whole item: ${t.name}`;
      return `Target ${t.key} — ${label} (searched "${t.query}")\n${lines.length ? lines.join("\n") : "  (no listings found)"}`;
    })
    .join("\n\n");
  const pricePrompt = [
    "Listing being checked:",
    describeListing(listing),
    "",
    `Current ${location.label} marketplace listings per target (asking prices, ${listing.currency}):`,
    "",
    targetText,
  ].join("\n");
  const priced = priceSchema.safeParse(extractJson(await ask(PRICE_SYSTEM, pricePrompt, PRICE_SCHEMA)));
  if (!priced.success) throw new AiRequestError("Claude returned a price check with invalid fields");

  const compIds = new Set(comps.map((c) => c.id));
  const answers = priced.data.estimates;
  const estimates: PriceEstimate[] = targets.map((t, i) => {
    // Claude doesn't always echo the key verbatim ("Target p0", "P0", "p0 — CPU"); in the order given is the fallback.
    const e = answers.find((x) => normalizeTargetKey(x.key) === t.key) ?? (answers.length === targets.length ? answers[i] : undefined);
    let low = toCents(e?.low ?? null);
    let high = toCents(e?.high ?? null);
    if (low !== null && high !== null && low > high) [low, high] = [high, low];
    return {
      key: t.key,
      component: t.component,
      name: t.name,
      query: t.query,
      lowCents: low,
      typicalCents: toCents(e?.typical ?? null),
      highCents: high,
      compIds: (e?.compIds ?? []).filter((id) => compIds.has(id)),
      note: stripCandidateIds(e?.note ?? ""),
    };
  });
  const [item, ...parts] = estimates;
  const partOutTotalCents =
    parts.length > 0 && parts.every((p) => p.typicalCents !== null) ? parts.reduce((sum, p) => sum + (p.typicalCents ?? 0), 0) : null;
  // Keep only the comps that were actually used, so the stored result stays small.
  const used = new Set(estimates.flatMap((e) => e.compIds));

  const result: PriceCheckResult = {
    kind: planJson.data.kind,
    currency: listing.currency,
    askingPriceCents: listing.priceCents,
    item,
    parts,
    partOutTotalCents,
    summary: stripCandidateIds(priced.data.summary),
    sources,
    comps: comps.filter((c) => used.has(c.id)),
  };
  await db.insert(priceChecks).values({ listingId, model: resolveModel(), result });
  return result;
}

export interface StoredPriceCheck {
  result: PriceCheckResult;
  model: string;
  createdAt: Date;
}

/** The newest price check for a listing, or null. */
export async function getLatestPriceCheck(db: Db, listingId: number): Promise<StoredPriceCheck | null> {
  const [row] = await db
    .select()
    .from(priceChecks)
    .where(eq(priceChecks.listingId, listingId))
    .orderBy(desc(priceChecks.createdAt), desc(priceChecks.id))
    .limit(1);
  return row ? { result: row.result as PriceCheckResult, model: row.model, createdAt: row.createdAt } : null;
}
