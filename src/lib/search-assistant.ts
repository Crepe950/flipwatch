/**
 * Manage saved searches in plain words ("watch for RTX 3080s under $450", "make PS5 max $700", "pause road
 * bikes"). Claude turns the request into one structured action against the current searches; this module
 * validates it with the same schema as the search editor and applies it. Used by the Discord bot's /search.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { getAiClient, isAiConfigured, resolveModel } from "./ai/client";
import { AiNotConfiguredError, AiRequestError, toAiError } from "./ai/errors";
import { aiLimiter } from "./ai/limiter";
import { responseText } from "./ai/response";
import type { Db } from "./db";
import { searches, type Search } from "./db/schema";
import { adapterUnavailableReason } from "./engine/fetch";
import { formatPrice } from "./format";
import { currencyForCountry, DEFAULT_LOCATION, LOCATION_PRESETS } from "./locations";
import { listAdapters } from "./marketplaces/registry";
import { createSearch, getSearch, updateSearch } from "./queries/searches";
import { getDefaultLocation } from "./queries/settings";
import { searchInputSchema, type SearchInput } from "./search-schema";
import { CATEGORIES, MARKETPLACES, type MarketplaceId, type SearchLocation } from "./types";

export const SEARCH_ACTIONS = ["create", "update", "pause", "resume", "mute", "unmute", "list", "none"] as const;
export type SearchAction = (typeof SEARCH_ACTIONS)[number];

/** Fields an update may explicitly clear (null in `changes` means "leave as is"). */
const CLEARABLE = ["minPrice", "maxPrice", "expectedResale", "category", "notifyMinDealScore", "notifyMinAiScore", "aiInstructions"] as const;

const nullable = (type: string, description: string) => ({ type: [type, "null"], description });

const PLAN_SCHEMA = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: [...SEARCH_ACTIONS],
      description:
        "create a new search; update an existing one; pause/resume polling; mute/unmute its alerts (it keeps polling); list the searches; none when the request is unclear or impossible.",
    },
    searchId: nullable("integer", "Id of the existing search for update/pause/resume/mute/unmute; null otherwise."),
    changes: {
      type: "object",
      description: "For create: the new search (unset fields get sensible defaults). For update: only what changes; null = leave as is.",
      properties: {
        name: nullable("string", "Short display name."),
        query: nullable("string", 'Marketplace keywords. Alternatives with |, e.g. \'rtx 3080 | "rtx 3080 ti"\'. Exclusions go in excludeTerms.'),
        excludeTerms: { type: ["array", "null"], items: { type: "string" }, description: "Full replacement list of words/phrases that reject a listing." },
        titleMustMatch: nullable("boolean", "Title must contain the keywords of one alternative. Recommended for anything specific."),
        minPrice: nullable("number", "Minimum price, major units of the search currency."),
        maxPrice: nullable("number", "Maximum price, major units."),
        expectedResale: nullable("number", "What a typical match resells for, major units (enables profit estimates)."),
        marketplaces: { type: ["array", "null"], items: { type: "string", enum: [...MARKETPLACES] }, description: "Marketplaces to search." },
        location: nullable("string", "One of the location preset labels, exactly as given."),
        radiusKm: nullable("number", "Search radius in km (1-500)."),
        category: nullable("string", `One of: ${CATEGORIES.join(", ")}. Only when it clearly helps (Craigslist uses it).`),
        pollIntervalMinutes: nullable("number", "How often to check, in minutes."),
        notifyMinDealScore: nullable("integer", "Only alert at or above this deal score (0-100)."),
        notifyMinAiScore: nullable("integer", "Only alert when Claude's evaluation scores at least this (0-100)."),
        aiInstructions: nullable("string", "The user's buying strategy for this search, in their words (given to Claude with every evaluation)."),
        aiEvaluate: nullable("boolean", "Have Claude evaluate new matches."),
        clear: {
          type: "array",
          items: { type: "string", enum: [...CLEARABLE] },
          description: "For update: fields to remove entirely (e.g. 'no max price' → maxPrice).",
        },
      },
      required: [
        "name", "query", "excludeTerms", "titleMustMatch", "minPrice", "maxPrice", "expectedResale", "marketplaces", "location",
        "radiusKm", "category", "pollIntervalMinutes", "notifyMinDealScore", "notifyMinAiScore", "aiInstructions", "aiEvaluate", "clear",
      ],
      additionalProperties: false,
    },
    reply: { type: "string", description: "One or two sentences to the user: what you did and why, or what you need to know (for none)." },
  },
  required: ["action", "searchId", "changes", "reply"],
  additionalProperties: false,
};

const planSchema = z.object({
  action: z.enum(SEARCH_ACTIONS),
  searchId: z.number().int().nullable().catch(null),
  changes: z
    .object({
      name: z.string().nullable(),
      query: z.string().nullable(),
      excludeTerms: z.array(z.string()).nullable(),
      titleMustMatch: z.boolean().nullable(),
      minPrice: z.number().nullable(),
      maxPrice: z.number().nullable(),
      expectedResale: z.number().nullable(),
      marketplaces: z.array(z.enum(MARKETPLACES)).nullable(),
      location: z.string().nullable(),
      radiusKm: z.number().nullable(),
      category: z.enum(CATEGORIES).nullable().catch(null),
      pollIntervalMinutes: z.number().nullable(),
      notifyMinDealScore: z.number().int().nullable(),
      notifyMinAiScore: z.number().int().nullable(),
      aiInstructions: z.string().nullable(),
      aiEvaluate: z.boolean().nullable(),
      clear: z.array(z.enum(CLEARABLE)).catch([]),
    })
    .partial()
    .catch({}),
  reply: z.string().catch(""),
});
export type SearchPlan = z.infer<typeof planSchema>;

const SYSTEM = [
  "You manage the saved searches of FlipWatch, a marketplace deal scanner used by a reseller. The user writes one request; you answer with exactly one action in the requested JSON format.",
  "Searches poll marketplaces for new listings matching keywords and alert on good deals. Query syntax: plain keywords, alternatives separated by | (each alternative is a separate request on Facebook and Kijiji, so keep it to about 6), quoted phrases for multi-word terms. Put unwanted words in excludeTerms, not in the query.",
  "When creating a search: pick a short name, specific keywords, titleMustMatch true unless the item is usually listed under brand/model names, sensible exclude terms (e.g. wanted, iso, broken, for parts, and accessories that share the keywords), a price range when the user gives one, and only marketplaces that are available.",
  "When the user refers to an existing search by name or item, match it to the closest one in the list and use its id. If a request is ambiguous or refers to something that doesn't exist, use action none and ask in reply. Deleting searches is not supported: suggest pause instead.",
  "The request comes from the FlipWatch owner. Money is in the search's currency, major units.",
].join("\n");

function toMajor(cents: number | null): number | null {
  return cents === null ? null : cents / 100;
}

function toCents(major: number | null | undefined): number | null {
  if (major === null || major === undefined || !Number.isFinite(major) || major < 0) return null;
  return Math.round(major * 100);
}

function describeForPrompt(s: Search) {
  return {
    id: s.id,
    name: s.name,
    enabled: s.enabled,
    alertsMuted: Array.isArray(s.notifyChannelIds) && s.notifyChannelIds.length === 0,
    query: s.query,
    excludeTerms: s.excludeTerms,
    titleMustMatch: s.titleMustMatch,
    minPrice: toMajor(s.minPriceCents),
    maxPrice: toMajor(s.maxPriceCents),
    expectedResale: toMajor(s.expectedResaleCents),
    currency: currencyForCountry(s.location.countryCode),
    marketplaces: s.marketplaces,
    location: s.location.label,
    radiusKm: s.location.radiusKm,
    category: s.category,
    pollIntervalMinutes: Math.round(s.pollIntervalSec / 60),
    notifyMinDealScore: s.notifyMinDealScore,
    notifyMinAiScore: s.notifyMinAiScore,
    aiEvaluate: s.aiEvaluate,
    aiInstructions: s.aiInstructions,
  };
}

function availableMarketplaces(countryCode: string): MarketplaceId[] {
  return listAdapters()
    .filter((a) => adapterUnavailableReason(a, countryCode) === null)
    .map((a) => a.id);
}

/** Ask Claude to turn a request into a plan. */
export async function planSearchRequest(request: string, current: Search[], home: SearchLocation = DEFAULT_LOCATION): Promise<SearchPlan> {
  if (!isAiConfigured()) throw new AiNotConfiguredError();
  const text = [
    `Today: ${new Date().toISOString().slice(0, 10)}`,
    `Location presets: ${LOCATION_PRESETS.map((l) => l.label).join("; ")}. Default: ${home.label}, ${home.radiusKm} km.`,
    `Marketplaces available for ${home.label}: ${availableMarketplaces(home.countryCode).join(", ")}.`,
    "Current searches (JSON):",
    JSON.stringify(current.map(describeForPrompt), null, 1),
    "",
    "The user's request:",
    "<request>",
    request.slice(0, 1500),
    "</request>",
  ].join("\n");
  const body: Anthropic.MessageCreateParamsNonStreaming = {
    model: resolveModel(),
    max_tokens: 8_000,
    system: SYSTEM,
    messages: [{ role: "user", content: text }],
    output_config: { format: { type: "json_schema", schema: PLAN_SCHEMA } },
  };
  let answer: string;
  try {
    answer = responseText(await aiLimiter.run(() => getAiClient().messages.create(body), { priority: "high" }));
  } catch (err) {
    throw toAiError(err);
  }
  const start = answer.indexOf("{");
  const end = answer.lastIndexOf("}");
  let json: unknown;
  try {
    json = JSON.parse(start >= 0 && end > start ? answer.slice(start, end + 1) : answer);
  } catch {
    throw new AiRequestError("Claude's answer was not valid JSON");
  }
  const parsed = planSchema.safeParse(json);
  if (!parsed.success) throw new AiRequestError("Claude's answer did not describe a search action");
  return parsed.data;
}

function searchToInput(s: Search): SearchInput {
  return {
    name: s.name,
    query: s.query,
    excludeTerms: s.excludeTerms,
    titleMustMatch: s.titleMustMatch,
    minPriceCents: s.minPriceCents,
    maxPriceCents: s.maxPriceCents,
    expectedResaleCents: s.expectedResaleCents,
    marketplaces: s.marketplaces,
    location: s.location,
    category: s.category,
    pollIntervalSec: s.pollIntervalSec,
    maxListingAgeHours: s.maxListingAgeHours,
    notifyChannelIds: s.notifyChannelIds,
    notifyMinDealScore: s.notifyMinDealScore,
    notifyMinAiScore: s.notifyMinAiScore,
    aiInstructions: s.aiInstructions,
    notifyPriceDrops: s.notifyPriceDrops,
    aiEvaluate: s.aiEvaluate,
    enabled: s.enabled,
  };
}

const DEFAULTS = (home: SearchLocation): SearchInput => ({
  name: "",
  query: "",
  excludeTerms: ["wanted", "iso"],
  titleMustMatch: true,
  minPriceCents: null,
  maxPriceCents: null,
  expectedResaleCents: null,
  marketplaces: availableMarketplaces(home.countryCode).filter((m) => ["craigslist", "kijiji", "facebook"].includes(m)),
  location: home,
  category: null,
  pollIntervalSec: 900,
  maxListingAgeHours: 24,
  notifyChannelIds: null,
  notifyMinDealScore: null,
  notifyMinAiScore: null,
  aiInstructions: null,
  notifyPriceDrops: true,
  aiEvaluate: true,
  enabled: true,
});

/** Merge a plan's changes into a search definition. Throws a user-facing Error for impossible values. */
export function applyChanges(base: SearchInput, changes: SearchPlan["changes"]): SearchInput {
  const next: SearchInput = { ...base, location: { ...base.location } };
  const c = changes;
  if (c.name?.trim()) next.name = c.name.trim().slice(0, 80);
  if (c.query?.trim()) next.query = c.query.trim();
  if (c.excludeTerms) next.excludeTerms = c.excludeTerms.map((t) => t.trim()).filter(Boolean);
  if (c.titleMustMatch != null) next.titleMustMatch = c.titleMustMatch;
  if (c.minPrice != null) next.minPriceCents = toCents(c.minPrice);
  if (c.maxPrice != null) next.maxPriceCents = toCents(c.maxPrice);
  if (c.expectedResale != null) next.expectedResaleCents = toCents(c.expectedResale);
  if (c.marketplaces?.length) next.marketplaces = [...new Set(c.marketplaces)];
  if (c.location) {
    const preset = LOCATION_PRESETS.find((l) => l.label.toLowerCase() === c.location!.trim().toLowerCase());
    if (!preset) throw new Error(`Unknown location "${c.location}". Use one of the presets, e.g. ${DEFAULT_LOCATION.label}.`);
    next.location = { ...preset, radiusKm: next.location.radiusKm };
  }
  if (c.radiusKm != null) next.location.radiusKm = Math.min(500, Math.max(1, Math.round(c.radiusKm)));
  if (c.category) next.category = c.category === "any" ? null : c.category;
  if (c.pollIntervalMinutes != null) next.pollIntervalSec = Math.min(86_400, Math.max(60, Math.round(c.pollIntervalMinutes * 60)));
  if (c.notifyMinDealScore != null) next.notifyMinDealScore = c.notifyMinDealScore;
  if (c.notifyMinAiScore != null) next.notifyMinAiScore = c.notifyMinAiScore;
  if (c.aiInstructions?.trim()) next.aiInstructions = c.aiInstructions.trim().slice(0, 1000);
  if (c.aiEvaluate != null) next.aiEvaluate = c.aiEvaluate;
  for (const field of c.clear ?? []) {
    if (field === "minPrice") next.minPriceCents = null;
    else if (field === "maxPrice") next.maxPriceCents = null;
    else if (field === "expectedResale") next.expectedResaleCents = null;
    else if (field === "category") next.category = null;
    else next[field] = null;
  }
  return next;
}

function validate(input: SearchInput): SearchInput {
  const parsed = searchInputSchema.safeParse(input);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  throw new Error(`That search isn't valid: ${issue?.path.join(".") || "input"} — ${issue?.message ?? "invalid"}`);
}

/** Readable summary of a search for a chat reply. */
export function summarizeSearch(s: Search): string {
  const currency = currencyForCountry(s.location.countryCode);
  const price =
    s.minPriceCents !== null && s.maxPriceCents !== null
      ? `${formatPrice(s.minPriceCents, currency)}–${formatPrice(s.maxPriceCents, currency)}`
      : s.maxPriceCents !== null
        ? `up to ${formatPrice(s.maxPriceCents, currency)}`
        : s.minPriceCents !== null
          ? `${formatPrice(s.minPriceCents, currency)}+`
          : "any price";
  const muted = Array.isArray(s.notifyChannelIds) && s.notifyChannelIds.length === 0;
  const alerts = muted
    ? "alerts muted"
    : [s.notifyMinDealScore !== null ? `deal score ≥ ${s.notifyMinDealScore}` : null, s.notifyMinAiScore !== null ? `AI score ≥ ${s.notifyMinAiScore}` : null]
        .filter(Boolean)
        .join(", ") || "alerts on every match";
  return [
    `**${s.name}** (#${s.id})${s.enabled ? "" : " · paused"}`,
    `\`${s.query}\`${s.excludeTerms.length ? ` · excludes: ${s.excludeTerms.join(", ")}` : ""}`,
    `${price} · ${s.marketplaces.join(", ")} · ${s.location.label} ${s.location.radiusKm} km · every ${Math.round(s.pollIntervalSec / 60)} min`,
    alerts + (s.aiInstructions ? ` · notes: ${s.aiInstructions.length > 120 ? `${s.aiInstructions.slice(0, 119)}…` : s.aiInstructions}` : ""),
  ].join("\n");
}

async function allSearches(db: Db): Promise<Search[]> {
  return db.select().from(searches).orderBy(asc(searches.id));
}

async function requireSearch(db: Db, id: number | null | undefined): Promise<Search> {
  const search = id != null ? await getSearch(db, id) : null;
  if (!search) throw new Error("I couldn't tell which search you mean. Name it, or use /searches to see them.");
  return search;
}

export interface SearchRequestResult {
  action: SearchAction;
  search: Search | null;
  reply: string;
}

/** Carry out a plan. Every change goes through the search editor's validation. */
export async function applySearchPlan(db: Db, plan: SearchPlan): Promise<SearchRequestResult> {
  const note = plan.reply.trim();
  const withNote = (text: string) => (note ? `${note}\n\n${text}` : text);

  switch (plan.action) {
    case "list": {
      const list = await allSearches(db);
      return { action: "list", search: null, reply: list.length ? list.map(summarizeSearch).join("\n\n") : "No searches yet." };
    }
    case "none":
      return { action: "none", search: null, reply: note || "I'm not sure what to change. Try e.g. “watch for RTX 3080s under $450”." };
    case "create": {
      const input = validate(applyChanges(DEFAULTS(await getDefaultLocation(db)), plan.changes));
      const created = await createSearch(db, input);
      return { action: "create", search: created, reply: withNote(`Created:\n${summarizeSearch(created)}`) };
    }
    case "update": {
      const current = await requireSearch(db, plan.searchId);
      const wasMuted = Array.isArray(current.notifyChannelIds) && current.notifyChannelIds.length === 0;
      const input = validate(applyChanges(searchToInput(current), plan.changes));
      let updated = await updateSearch(db, current.id, input);
      if (!updated) throw new Error("That search no longer exists.");
      // The editor stores an empty channel list as "all channels"; keep a muted search muted.
      if (wasMuted) [updated] = await db.update(searches).set({ notifyChannelIds: [] }).where(eq(searches.id, current.id)).returning();
      return { action: "update", search: updated, reply: withNote(`Updated:\n${summarizeSearch(updated)}`) };
    }
    case "pause":
    case "resume":
    case "mute":
    case "unmute": {
      const current = await requireSearch(db, plan.searchId);
      const set =
        plan.action === "pause"
          ? { enabled: false }
          : plan.action === "resume"
            ? { enabled: true, nextRunAt: null }
            : { notifyChannelIds: plan.action === "mute" ? [] : null };
      const [updated] = await db
        .update(searches)
        .set({ ...set, updatedAt: new Date() })
        .where(eq(searches.id, current.id))
        .returning();
      const done = { pause: "Paused", resume: "Resumed", mute: "Muted alerts for", unmute: "Unmuted alerts for" }[plan.action];
      return { action: plan.action, search: updated, reply: withNote(`${done}:\n${summarizeSearch(updated)}`) };
    }
  }
}

/** Plan and apply a plain-words request about searches. */
export async function runSearchRequest(db: Db, request: string): Promise<SearchRequestResult> {
  const plan = await planSearchRequest(request, await allSearches(db), await getDefaultLocation(db));
  return applySearchPlan(db, plan);
}
