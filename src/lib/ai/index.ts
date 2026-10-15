/**
 * AI public API: Claude deal evaluation and seller outreach drafts.
 */
import { config } from "../config";
import { isAiConfigured, PROVIDER_LABELS, resolveModel } from "./client";
import type { AiStatus } from "./types";

export type { AiStatus, EvaluateListingOptions, OutreachDraft, OutreachOptions, OutreachTone } from "./types";
export { evaluateListing, evaluateMatchEvents, type EvaluateEventsResult } from "./evaluate";
export { draftOutreach } from "./outreach";
export {
  getLatestPriceCheck,
  priceCheckListing,
  type PriceCheckComp,
  type PriceCheckResult,
  type PriceEstimate,
  type StoredPriceCheck,
} from "./price-check";
export { AiNotConfiguredError, AiRequestError } from "./errors";
export { DEFAULT_AI_MODEL, setAiClientFactory, type AiClient, type AiClientFactory } from "./client";

export function aiStatus(): AiStatus {
  const model = resolveModel();
  const provider = config.aiProvider;
  if (!isAiConfigured()) {
    return {
      configured: false,
      model,
      message: "Choose an AI engine in Settings → AI: paste a Claude or OpenAI API key, or use Claude Code / Codex installed on this computer.",
    };
  }
  const label = PROVIDER_LABELS[provider];
  const shown = model || "its default model";
  if (provider === "claude-cli" || provider === "codex-cli") {
    return { configured: true, model, message: `AI deal analysis runs on ${label} (${shown}), using its own sign-in; photos are not sent.` };
  }
  return { configured: true, model, message: `AI deal analysis runs on ${label} (${shown}).` };
}