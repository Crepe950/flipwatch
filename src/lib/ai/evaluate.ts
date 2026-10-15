import type Anthropic from "@anthropic-ai/sdk";
import { APIError } from "@anthropic-ai/sdk";
import { and, eq, gte, inArray, max } from "drizzle-orm";
import type { Db } from "../db";
import { aiEvaluations, priceHistory, searches } from "../db/schema";
import type { AiEvaluation } from "../db/schema";
import { withFullDescription } from "../engine/listing-details";
import type { MatchEvent } from "../events";
import { getAiClient, isAiConfigured, resolveModel, type AiClient } from "./client";
import { loadEvaluationContext, type EvaluationContext } from "./context";
import { AiNotConfiguredError, toAiError } from "./errors";
import { aiLimiter } from "./limiter";
import { responseText } from "./response";
import { buildEvaluationPrompt, selectImageUrls, type EvaluationPrompt } from "./prompts";
import { EVALUATION_JSON_SCHEMA, parseEvaluationOutput } from "./schema";
import type { EvaluateListingOptions } from "./types";

/** Room for adaptive thinking when AI_MODEL points at a thinking model; the JSON itself is small. */
const EVALUATION_MAX_TOKENS = 16_000;

function evaluationRequest(model: string, prompt: EvaluationPrompt): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model,
    max_tokens: EVALUATION_MAX_TOKENS,
    system: prompt.system,
    messages: [{ role: "user", content: prompt.content }],
    output_config: { format: { type: "json_schema", schema: EVALUATION_JSON_SCHEMA } },
  };
}

/** A 400 on a request with image URLs is almost always an image the API could not fetch or decode. */
function isImageRejection(err: unknown): boolean {
  return err instanceof APIError && err.status === 400;
}

async function requestEvaluation(
  client: AiClient,
  model: string,
  ctx: EvaluationContext,
): Promise<Anthropic.Message> {
  const imageUrls = selectImageUrls(ctx.listing.imageUrls);
  try {
    return await client.messages.create(evaluationRequest(model, buildEvaluationPrompt(ctx, imageUrls)));
  } catch (err) {
    if (imageUrls.length === 0 || !isImageRejection(err)) throw err;
    return await client.messages.create(evaluationRequest(model, buildEvaluationPrompt(ctx, [])));
  }
}

function totalInputTokens(usage: Anthropic.Usage | undefined): number | null {
  if (!usage) return null;
  return usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
}

async function runEvaluation(db: Db, listingId: number, opts: EvaluateListingOptions): Promise<AiEvaluation> {
  const loaded = await loadEvaluationContext(db, listingId, { searchId: opts.searchId ?? null, now: opts.now });
  // Score what the seller wrote, not just the title (Facebook search results carry no description).
  const ctx: EvaluationContext = { ...loaded, listing: await withFullDescription(db, loaded.listing, { interactive: opts.interactive ?? false }) };
  const model = resolveModel();
  const client = getAiClient();

  let message: Anthropic.Message;
  try {
    message = await requestEvaluation(client, model, ctx);
  } catch (err) {
    throw toAiError(err);
  }
  const evaluation = parseEvaluationOutput(responseText(message), { askingPriceCents: ctx.listing.priceCents });

  const [row] = await db
    .insert(aiEvaluations)
    .values({
      listingId,
      searchId: ctx.search?.id ?? null,
      model: message.model || model,
      verdict: evaluation.verdict,
      dealScore: evaluation.dealScore,
      estimatedResaleLowCents: evaluation.estimatedResaleLowCents,
      estimatedResaleHighCents: evaluation.estimatedResaleHighCents,
      suggestedOfferCents: evaluation.suggestedOfferCents,
      summary: evaluation.summary,
      reasons: evaluation.reasons,
      redFlags: evaluation.redFlags,
      questionsForSeller: evaluation.questionsForSeller,
      inputTokens: totalInputTokens(message.usage),
      outputTokens: message.usage?.output_tokens ?? null,
    })
    .returning();
  return row;
}

// Concurrent requests for the same listing/search on the same database share one Claude call.
const inFlight = new WeakMap<Db, Map<string, Promise<AiEvaluation>>>();

/** Ask Claude to assess a listing as a flip; stores and returns an ai_evaluations row. */
export async function evaluateListing(db: Db, listingId: number, opts: EvaluateListingOptions = {}): Promise<AiEvaluation> {
  if (!isAiConfigured()) throw new AiNotConfiguredError();

  const perDb = inFlight.get(db) ?? new Map<string, Promise<AiEvaluation>>();
  inFlight.set(db, perDb);
  const key = `${listingId}:${opts.searchId ?? "auto"}`;
  const existing = perDb.get(key);
  if (existing) return existing;

  // The limiter slot covers loading the context too, so a burst of events does not load hundreds
  // of contexts up front and every prompt is built with fresh data right before its request.
  const pending = aiLimiter.run(() => runEvaluation(db, listingId, opts)).finally(() => perDb.delete(key));
  perDb.set(key, pending);
  return pending;
}

export interface EvaluateEventsResult {
  evaluations: AiEvaluation[];
  errors: Array<{ listingId: number; searchId: number; error: string }>;
}

export interface EvaluateEventsOptions {
  /** Clock override (tests): anchors the re-evaluation window. */
  now?: Date;
}

/** A listing evaluated this recently is not evaluated again automatically, unless its price changed since. */
export const REEVALUATE_AFTER_MS = 24 * 60 * 60 * 1000;

// Automatic evaluations in flight per listing, so searches matching the same listing share one call.
const autoInFlight = new WeakMap<Db, Map<number, Promise<AiEvaluation>>>();

/** Listings with an evaluation from the last 24 h that is newer than their latest price change. */
async function recentlyEvaluated(db: Db, listingIds: number[], now: Date): Promise<Set<number>> {
  const [evaluated, priced] = await Promise.all([
    db
      .select({ listingId: aiEvaluations.listingId, at: max(aiEvaluations.createdAt) })
      .from(aiEvaluations)
      .where(
        and(inArray(aiEvaluations.listingId, listingIds), gte(aiEvaluations.createdAt, new Date(now.getTime() - REEVALUATE_AFTER_MS))),
      )
      .groupBy(aiEvaluations.listingId),
    db
      .select({ listingId: priceHistory.listingId, at: max(priceHistory.observedAt) })
      .from(priceHistory)
      .where(inArray(priceHistory.listingId, listingIds))
      .groupBy(priceHistory.listingId),
  ]);
  const priceChangedAt = new Map(priced.map((r) => [r.listingId, r.at?.getTime() ?? 0]));
  return new Set(
    evaluated.filter((r) => r.at && r.at.getTime() >= (priceChangedAt.get(r.listingId) ?? 0)).map((r) => r.listingId),
  );
}

/**
 * Evaluate the listings behind engine events for searches with `aiEvaluate` enabled (the engine's
 * automatic evaluation). Silent events are skipped, each listing is evaluated once (the first event's
 * search gives the context), and listings evaluated in the last 24 h are skipped unless their price
 * changed since. Failures are collected rather than thrown so one bad listing never blocks the rest.
 * A no-op when AI is not configured.
 */
export async function evaluateMatchEvents(
  db: Db,
  events: readonly MatchEvent[],
  opts: EvaluateEventsOptions = {},
): Promise<EvaluateEventsResult> {
  const result: EvaluateEventsResult = { evaluations: [], errors: [] };
  const candidates = events.filter((e) => !e.silent);
  if (!isAiConfigured() || candidates.length === 0) return result;

  const searchIds = [...new Set(candidates.map((e) => e.searchId))];
  const enabled = await db
    .select({ id: searches.id })
    .from(searches)
    .where(and(inArray(searches.id, searchIds), eq(searches.aiEvaluate, true)));
  const enabledIds = new Set(enabled.map((s) => s.id));

  const byListing = new Map<number, MatchEvent>();
  for (const event of candidates) {
    if (enabledIds.has(event.searchId) && !byListing.has(event.listingId)) byListing.set(event.listingId, event);
  }
  if (byListing.size === 0) return result;
  const skip = await recentlyEvaluated(db, [...byListing.keys()], opts.now ?? new Date());
  const targets = [...byListing.values()].filter((event) => !skip.has(event.listingId));

  const perDb = autoInFlight.get(db) ?? new Map<number, Promise<AiEvaluation>>();
  autoInFlight.set(db, perDb);
  const settled = await Promise.allSettled(
    targets.map((event) => {
      let pending = perDb.get(event.listingId);
      if (!pending) {
        pending = evaluateListing(db, event.listingId, { searchId: event.searchId }).finally(() => perDb.delete(event.listingId));
        perDb.set(event.listingId, pending);
      }
      return pending;
    }),
  );
  targets.forEach((event, i) => {
    const outcome = settled[i];
    if (outcome.status === "fulfilled") result.evaluations.push(outcome.value);
    else {
      const error = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
      result.errors.push({ listingId: event.listingId, searchId: event.searchId, error });
    }
  });
  return result;
}
