import { desc, eq } from "drizzle-orm";
import type { Db } from "../db";
import { aiEvaluations } from "../db/schema";
import { formatPrice } from "../format";
import { getAiClient, isAiConfigured, resolveModel } from "./client";
import { loadListing } from "./context";
import { toAiError } from "./errors";
import { aiLimiter } from "./limiter";
import { buildOutreachPrompt } from "./prompts";
import { responseText } from "./response";
import { cleanText, countWords, shortItemName, stripEmoji, truncate } from "./text";
import type { OutreachDraft, OutreachOptions, OutreachTone } from "./types";

const TONES: readonly OutreachTone[] = ["friendly", "direct", "professional"];
const MAX_WORDS = 60;
/** The model is asked for ≤ 60 words; anything much longer means it ignored the brief. */
const MAX_AI_WORDS = 90;
const MAX_QUESTIONS_IN_MESSAGE = 2;
const MAX_QUESTION_CHARS = 110;
const OUTREACH_MAX_TOKENS = 2048;
/** Drafting is interactive: fail over to the template quickly instead of retrying for minutes. */
const OUTREACH_REQUEST_OPTIONS = { timeout: 20_000, maxRetries: 1 };

export const GENERIC_SELLER_QUESTIONS = ["Is there any damage or anything that doesn't work?", "Does it come with everything shown in the photos?"];

// Placeholders like [Name], {item}, <date> mean the model did not write a ready-to-send message.
const PLACEHOLDER = /\[[^\]]*\]|\{[^}]*\}|<[^>]*>/;

function normalizeTone(tone: unknown): OutreachTone {
  return TONES.includes(tone as OutreachTone) ? (tone as OutreachTone) : "friendly";
}

/** "$250" style offer text, or null when there is no usable offer. */
export function formatOffer(offerCents: number | null | undefined, currency: string): string | null {
  if (offerCents === null || offerCents === undefined || !Number.isFinite(offerCents) || offerCents <= 0) return null;
  const cents = Math.round(offerCents);
  try {
    return formatPrice(cents, currency);
  } catch {
    // Unknown currency code: Intl throws a RangeError.
    return `${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)} ${currency}`;
  }
}

function asQuestion(text: string): string {
  const q = truncate(cleanText(text).replace(/\s+/g, " "), MAX_QUESTION_CHARS).replace(/[\s.!…]+$/, "");
  return q.endsWith("?") ? q : `${q}?`;
}

async function loadQuestions(db: Db, listingId: number): Promise<string[]> {
  const [latest] = await db
    .select({ questions: aiEvaluations.questionsForSeller })
    .from(aiEvaluations)
    .where(eq(aiEvaluations.listingId, listingId))
    .orderBy(desc(aiEvaluations.createdAt), desc(aiEvaluations.id))
    .limit(1);
  const fromEvaluation = (latest?.questions ?? []).filter((q) => typeof q === "string" && q.trim());
  const questions = fromEvaluation.length > 0 ? fromEvaluation : GENERIC_SELLER_QUESTIONS;
  return questions.slice(0, MAX_QUESTIONS_IN_MESSAGE).map(asQuestion);
}

export interface TemplateInput {
  title: string;
  tone: OutreachTone;
  offerText: string | null;
  questions: readonly string[];
}

/** Deterministic message used when AI is unavailable. Drops questions rather than exceed 60 words. */
export function templateOutreach(input: TemplateInput): string {
  const item = shortItemName(input.title);
  const offer = input.offerText ? `Would you take ${input.offerText} cash?` : "";
  const build = (questions: readonly string[]) => {
    const asked = questions.join(" ");
    const parts =
      input.tone === "direct"
        ? [`Hi, is the ${item} still available?`, "I can pick up whenever suits you.", asked, offer]
        : input.tone === "professional"
          ? [`Hello, I'm interested in your ${item}. Is it still available?`, "I'm flexible on pickup timing and happy to work around your schedule.", asked, offer, "Thank you."]
          : [`Hi! Is your ${item} still available?`, "I'm flexible on pickup and can come by whenever works for you.", asked, offer, "Thanks!"];
    return parts.filter(Boolean).join(" ");
  };

  for (let n = input.questions.length; n > 0; n--) {
    const message = build(input.questions.slice(0, n));
    if (countWords(message) <= MAX_WORDS) return message;
  }
  return build([]);
}

function mentionsOffer(message: string, offerText: string): boolean {
  if (message.includes(offerText)) return true;
  const amount = offerText.replace(/[^\d.]/g, "").replace(/\.00$/, "");
  if (!amount) return false;
  const escaped = amount.replace(/\./g, "\\.");
  return new RegExp(`(^|[^\\d.,])${escaped}(\\.00)?(?![\\d,])`).test(message.replace(/(\d),(?=\d{3}\b)/g, "$1"));
}

/**
 * Clean the model's draft: drop wrapping quotes and labels, enforce the emoji policy, and make sure
 * the offer is present. Returns null when the draft is unusable (placeholders, empty, far too long).
 */
export function sanitizeOutreach(text: string, opts: { tone: OutreachTone; offerText: string | null }): string | null {
  let message = cleanText(text)
    .replace(/^(?:subject|message)\s*:[^\n]*\n+/i, "")
    .replace(/^(?:message|draft)\s*:\s*/i, "")
    .trim();
  if (/^["“][\s\S]*["”]$/.test(message)) message = message.slice(1, -1).trim();
  message = stripEmoji(message, opts.tone === "friendly" ? 1 : 0);

  if (!message || PLACEHOLDER.test(message)) return null;
  if (countWords(message) > MAX_AI_WORDS) return null;
  if (opts.offerText && !mentionsOffer(message, opts.offerText)) {
    message = `${message} Would you take ${opts.offerText} cash?`;
  }
  return message;
}

/** Draft a first message to the seller. Falls back to a template when AI is not configured or fails. */
export async function draftOutreach(db: Db, listingId: number, opts: OutreachOptions = {}): Promise<OutreachDraft> {
  const listing = await loadListing(db, listingId);

  const tone = normalizeTone(opts.tone);
  const offerText = formatOffer(opts.offerCents, listing.currency);
  const questions = opts.askQuestions ? await loadQuestions(db, listingId) : [];
  const fallback = (): OutreachDraft => ({
    message: templateOutreach({ title: listing.title, tone, offerText, questions }),
    aiGenerated: false,
  });

  if (!isAiConfigured()) return fallback();

  try {
    const client = getAiClient();
    const prompt = buildOutreachPrompt({ listing, tone, offerText, questions });
    const response = await aiLimiter.run(() =>
      client.messages.create(
        {
          model: resolveModel(),
          max_tokens: OUTREACH_MAX_TOKENS,
          system: prompt.system,
          messages: [{ role: "user", content: prompt.text }],
        },
        OUTREACH_REQUEST_OPTIONS,
      ),
      { priority: "high" },
    );
    const message = sanitizeOutreach(responseText(response), { tone, offerText });
    return message ? { message, aiGenerated: true } : fallback();
  } catch (err) {
    console.warn(`[ai] Outreach draft for listing ${listingId} fell back to the template: ${toAiError(err).message}`);
    return fallback();
  }
}
