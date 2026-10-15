import { z } from "zod";
import type { AiVerdict } from "../types";
import { AiRequestError } from "./errors";
import { cleanText, limitSentences, truncate } from "./text";

export const AI_VERDICTS = ["great", "good", "fair", "pass"] as const satisfies readonly AiVerdict[];

export const MAX_REASONS = 5;
export const MAX_RED_FLAGS = 5;
export const MAX_QUESTIONS = 4;
const MAX_SUMMARY_CHARS = 400;
const MAX_ITEM_CHARS = 240;
/** Anything above this (≈ $20M) is nonsense for a marketplace flip and would overflow an int4 column. */
const MAX_CENTS = 2_000_000_000;

const nullableMoney = (description: string) => ({ type: ["number", "null"], description });
const stringList = (description: string) => ({ type: "array", items: { type: "string" }, description });

/**
 * JSON schema for the model's answer, sent as `output_config.format` (structured outputs).
 * Hand-written because structured outputs ignore numeric/length constraints; those limits live in
 * the descriptions and are enforced client-side by `parseEvaluationOutput`.
 */
export const EVALUATION_JSON_SCHEMA = {
  type: "object",
  properties: {
    verdict: {
      type: "string",
      enum: [...AI_VERDICTS],
      description: "great = strong profit, act now; good = solid margin; fair = thin or uncertain margin; pass = no profit, too risky or likely scam.",
    },
    dealScore: { type: "integer", description: "Integer 0-100 consistent with the verdict (great 80+, good 60-79, fair 40-59, pass below 40)." },
    estimatedResaleLow: nullableMoney("Low end of a realistic resale price, in major units of the listing currency (250 means 250.00). null if the item cannot be identified."),
    estimatedResaleHigh: nullableMoney("High end of a realistic resale price, in major units of the listing currency. null if the item cannot be identified."),
    suggestedOffer: nullableMoney("Recommended opening offer in major units of the listing currency, never above the asking price. null if you would not buy at any reasonable price or the price is unknown."),
    summary: { type: "string", description: "At most two sentences." },
    reasons: stringList(`Up to ${MAX_REASONS} short, specific reasons for the verdict.`),
    redFlags: stringList(`Up to ${MAX_RED_FLAGS} concrete concerns or scam signals; empty if none.`),
    questionsForSeller: stringList(`Up to ${MAX_QUESTIONS} short questions to ask the seller before buying.`),
  },
  required: ["verdict", "dealScore", "estimatedResaleLow", "estimatedResaleHigh", "suggestedOffer", "summary", "reasons", "redFlags", "questionsForSeller"],
  additionalProperties: false,
};

/** "1,250", "$1250.50" → 1250.5; anything unparsable → NaN. */
function toNumber(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const cleaned = value.replace(/[^0-9.-]/g, "");
  return cleaned ? Number(cleaned) : Number.NaN;
}

const money = z.preprocess((v) => (v === undefined || v === "" ? null : toNumber(v)), z.number().nullable()).catch(null);
const textList = z
  .preprocess((v) => (typeof v === "string" ? [v] : (v ?? [])), z.array(z.unknown()))
  .catch([])
  .transform((items) => items.filter((item): item is string => typeof item === "string"));

/** Lenient validator for the model's raw answer; `normalizeEvaluation` then clamps and converts it. */
export const rawEvaluationSchema = z.object({
  verdict: z.preprocess((v) => (typeof v === "string" ? v.trim().toLowerCase() : v), z.enum(AI_VERDICTS)),
  dealScore: z.preprocess(toNumber, z.number()),
  estimatedResaleLow: money,
  estimatedResaleHigh: money,
  suggestedOffer: money,
  summary: z.preprocess((v) => v ?? "", z.string()).catch(""),
  reasons: textList,
  redFlags: textList,
  questionsForSeller: textList,
});

export type RawEvaluation = z.infer<typeof rawEvaluationSchema>;

export interface NormalizedEvaluation {
  verdict: AiVerdict;
  dealScore: number;
  estimatedResaleLowCents: number | null;
  estimatedResaleHighCents: number | null;
  suggestedOfferCents: number | null;
  summary: string;
  reasons: string[];
  redFlags: string[];
  questionsForSeller: string[];
}

function toCents(major: number | null): number | null {
  if (major === null || !Number.isFinite(major) || major < 0) return null;
  const cents = Math.round(major * 100);
  return cents > MAX_CENTS ? null : cents;
}

function cleanList(items: string[], max: number): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    const text = truncate(cleanText(item).replace(/^(?:[-*•]\s*|\d{1,2}[.)]\s+)/, "").replace(/\s+/g, " "), MAX_ITEM_CHARS);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    result.push(text);
    if (result.length === max) break;
  }
  return result;
}

/** Strip Markdown code fences or surrounding prose some models add around JSON. */
function extractJson(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return trimmed;
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  return start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
}

/**
 * Validate and normalise the model's answer: clamp and round the score, convert money to cents,
 * swap an inverted resale range, drop negative/absurd amounts, cap list lengths and never
 * suggest offering more than the asking price.
 */
export function normalizeEvaluation(raw: RawEvaluation, opts: { askingPriceCents?: number | null } = {}): NormalizedEvaluation {
  let low = toCents(raw.estimatedResaleLow);
  let high = toCents(raw.estimatedResaleHigh);
  if (low !== null && high !== null && low > high) [low, high] = [high, low];

  let offer = toCents(raw.suggestedOffer);
  const asking = opts.askingPriceCents;
  if (offer !== null && asking !== null && asking !== undefined && asking >= 0) {
    offer = asking === 0 ? null : Math.min(offer, asking);
  }

  const reasons = cleanList(raw.reasons, MAX_REASONS);
  const summary = truncate(limitSentences(cleanText(raw.summary).replace(/\s+/g, " "), 2), MAX_SUMMARY_CHARS);

  return {
    verdict: raw.verdict,
    dealScore: Math.min(100, Math.max(0, Math.round(raw.dealScore))),
    estimatedResaleLowCents: low,
    estimatedResaleHighCents: high,
    suggestedOfferCents: offer,
    summary: summary || reasons[0] || "No summary provided.",
    reasons,
    redFlags: cleanList(raw.redFlags, MAX_RED_FLAGS),
    questionsForSeller: cleanList(raw.questionsForSeller, MAX_QUESTIONS),
  };
}

/** Parse the model's text answer into a normalised evaluation, or throw AiRequestError. */
export function parseEvaluationOutput(text: string, opts: { askingPriceCents?: number | null } = {}): NormalizedEvaluation {
  let json: unknown;
  try {
    json = JSON.parse(extractJson(text));
  } catch {
    throw new AiRequestError("Claude returned an evaluation that is not valid JSON");
  }
  const parsed = rawEvaluationSchema.safeParse(json);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".") || "(root)"))].join(", ");
    throw new AiRequestError(`Claude returned an evaluation with invalid fields: ${fields}`);
  }
  return normalizeEvaluation(parsed.data, opts);
}
