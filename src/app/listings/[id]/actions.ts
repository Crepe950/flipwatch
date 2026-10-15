"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAuth } from "@/app/login/session";
import { aiStatus, draftOutreach, evaluateListing, priceCheckListing } from "@/lib/ai";
import { getDb } from "@/lib/db";
import { parseMoneyInput } from "@/lib/deals";
import { logOutreachSent } from "@/lib/queries/deals";
import { eq } from "drizzle-orm";
import { listings } from "@/lib/db/schema";
import { blockSeller } from "@/lib/queries/blocked-sellers";
import { getBestMatchSearchId, listingExists } from "@/lib/queries/listings";
import type { DealStage } from "@/lib/types";

const listingId = z.coerce.number().int().positive().max(2_147_483_647);

function errorMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message.trim() : "";
  return message ? message.slice(0, 300) : fallback;
}

// --- AI analysis ------------------------------------------------------------------------------

export interface AiRunState {
  status: "idle" | "done" | "error";
  error?: string;
  /** Set by the button when the request itself failed because the session expired. */
  signInHref?: string;
}

export async function runAiAnalysisAction(_prev: AiRunState, formData: FormData): Promise<AiRunState> {
  await requireAuth();
  const parsed = listingId.safeParse(formData.get("listingId"));
  if (!parsed.success) return { status: "error", error: "Invalid listing" };
  const status = aiStatus();
  if (!status.configured) {
    return { status: "error", error: status.message ?? "AI analysis is not configured. Choose an AI engine in Settings → AI engine." };
  }
  try {
    const db = await getDb();
    if (!(await listingExists(db, parsed.data))) return { status: "error", error: "This listing no longer exists" };
    await evaluateListing(db, parsed.data, { searchId: await getBestMatchSearchId(db, parsed.data), interactive: true });
  } catch (error) {
    console.error("[listing] AI analysis failed:", error);
    return { status: "error", error: `AI analysis failed: ${errorMessage(error, "unknown error")}` };
  }
  revalidatePath(`/listings/${parsed.data}`);
  revalidatePath("/");
  return { status: "done" };
}

// --- Market price check -----------------------------------------------------------------------

export async function runPriceCheckAction(_prev: AiRunState, formData: FormData): Promise<AiRunState> {
  await requireAuth();
  const parsed = listingId.safeParse(formData.get("listingId"));
  if (!parsed.success) return { status: "error", error: "Invalid listing" };
  const status = aiStatus();
  if (!status.configured) return { status: "error", error: status.message ?? "AI is not configured." };
  try {
    const db = await getDb();
    if (!(await listingExists(db, parsed.data))) return { status: "error", error: "This listing no longer exists" };
    await priceCheckListing(db, parsed.data);
  } catch (error) {
    console.error("[listing] price check failed:", error);
    return { status: "error", error: `Price check failed: ${errorMessage(error, "unknown error")}` };
  }
  revalidatePath(`/listings/${parsed.data}`);
  return { status: "done" };
}

// --- Seller blocklist ---------------------------------------------------------------------------

export type BlockSellerResult = { ok: true; dismissed: number } | { ok: false; error: string };

export async function blockSellerAction(id: number): Promise<BlockSellerResult> {
  await requireAuth();
  const parsed = listingId.safeParse(id);
  if (!parsed.success) return { ok: false, error: "Invalid listing" };
  try {
    const db = await getDb();
    const [listing] = await db.select({ marketplace: listings.marketplace, sellerName: listings.sellerName }).from(listings).where(eq(listings.id, parsed.data));
    if (!listing) return { ok: false, error: "This listing no longer exists" };
    if (!listing.sellerName?.trim()) return { ok: false, error: "This listing doesn't show a seller name" };
    const { dismissed } = await blockSeller(db, listing.marketplace, listing.sellerName);
    revalidatePath(`/listings/${parsed.data}`);
    revalidatePath("/");
    revalidatePath("/settings");
    return { ok: true, dismissed };
  } catch (error) {
    return { ok: false, error: `Couldn't block the seller: ${errorMessage(error, "unknown error")}` };
  }
}

// --- Outreach ---------------------------------------------------------------------------------

const draftInput = z.object({
  listingId,
  tone: z.enum(["friendly", "direct", "professional"]),
  offer: z
    .string()
    .max(20)
    .refine((v) => parseMoneyInput(v) !== undefined, "Enter an offer like 250 or 249.99"),
  askQuestions: z.boolean(),
});

export type DraftResult = { ok: true; message: string; aiGenerated: boolean } | { ok: false; error: string };

export async function draftOutreachAction(input: z.input<typeof draftInput>): Promise<DraftResult> {
  await requireAuth();
  const parsed = draftInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const { tone, offer, askQuestions } = parsed.data;
  try {
    const db = await getDb();
    if (!(await listingExists(db, parsed.data.listingId))) return { ok: false, error: "This listing no longer exists" };
    const draft = await draftOutreach(db, parsed.data.listingId, { tone, offerCents: parseMoneyInput(offer), askQuestions });
    const message = draft.message.trim();
    if (!message) return { ok: false, error: "No draft came back. Write your message below instead." };
    return { ok: true, message, aiGenerated: draft.aiGenerated };
  } catch (error) {
    console.error("[listing] drafting outreach failed:", error);
    return { ok: false, error: `Couldn't draft a message: ${errorMessage(error, "unknown error")}` };
  }
}

const logInput = z.object({
  listingId,
  body: z.string().trim().min(1, "Write a message first").max(5000, "Keep the message under 5,000 characters"),
  aiGenerated: z.boolean(),
});

export type LogResult = { ok: true; dealId: number; stage: DealStage } | { ok: false; error: string };

export async function logOutreachAction(input: z.input<typeof logInput>): Promise<LogResult> {
  await requireAuth();
  const parsed = logInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  try {
    const result = await logOutreachSent(await getDb(), parsed.data.listingId, {
      body: parsed.data.body,
      aiGenerated: parsed.data.aiGenerated,
    });
    if (!result) return { ok: false, error: "This listing no longer exists" };
    revalidatePath(`/listings/${parsed.data.listingId}`);
    revalidatePath("/pipeline");
    revalidatePath(`/pipeline/${result.deal.id}`);
    revalidatePath("/");
    return { ok: true, dealId: result.deal.id, stage: result.deal.stage };
  } catch (error) {
    console.error("[listing] logging outreach failed:", error);
    return { ok: false, error: "Couldn't log the message. Try again." };
  }
}
