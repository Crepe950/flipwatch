"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { moneyInputError } from "@/components/pipeline/deal-input";
import { getDb } from "@/lib/db";
import { followUpFromInput, parseMoneyInput } from "@/lib/deals";
import { addDealMessage, deleteDeal, moveDealStage, updateDealDetails } from "@/lib/queries/deals";
import { DEAL_STAGES, type DealStage } from "@/lib/types";
import { requireAuth } from "../login/session";

const dealId = z.coerce.number().int().positive().max(2_147_483_647);

function revalidateDeal(id: number, listingId?: number) {
  revalidatePath("/pipeline");
  revalidatePath(`/pipeline/${id}`);
  if (listingId !== undefined) revalidatePath(`/listings/${listingId}`);
  revalidatePath("/");
}

export type StageResult = { ok: true; stage: DealStage } | { ok: false; error: string };

export async function moveDealStageAction(id: number, stage: DealStage): Promise<StageResult> {
  await requireAuth();
  const parsed = z.tuple([dealId, z.enum(DEAL_STAGES)]).safeParse([id, stage]);
  if (!parsed.success) return { ok: false, error: "Invalid stage change" };
  try {
    const deal = await moveDealStage(await getDb(), parsed.data[0], parsed.data[1]);
    if (!deal) return { ok: false, error: "This deal no longer exists" };
    revalidateDeal(deal.id, deal.listingId);
    return { ok: true, stage: deal.stage };
  } catch (error) {
    console.error("[pipeline] stage change failed:", error);
    return { ok: false, error: "Couldn't move the deal. Try again." };
  }
}

// --- Edit deal ------------------------------------------------------------------------------

const MONEY_FIELDS = ["offer", "purchase", "sale", "fees", "otherCosts"] as const;
type MoneyField = (typeof MONEY_FIELDS)[number];
export type DealFormField = MoneyField | "notes" | "followUp";

export type DealFormResult =
  | { ok: true; savedAt: number }
  | { ok: false; error: string; fieldErrors?: Partial<Record<DealFormField, string>> };

export async function updateDealAction(formData: FormData): Promise<DealFormResult> {
  await requireAuth();
  const idParsed = dealId.safeParse(formData.get("dealId"));
  if (!idParsed.success) return { ok: false, error: "Invalid deal" };

  const fieldErrors: Partial<Record<DealFormField, string>> = {};
  const money = {} as Record<MoneyField, number | null>;
  for (const field of MONEY_FIELDS) {
    const cents = parseMoneyInput(formData.get(field));
    if (cents === undefined) fieldErrors[field] = moneyInputError(formData.get(field));
    else money[field] = cents;
  }
  const followUpAt = followUpFromInput(typeof formData.get("followUp") === "string" ? (formData.get("followUp") as string) : "");
  if (followUpAt === undefined) fieldErrors.followUp = "Pick a valid date";
  const notesRaw = formData.get("notes");
  const notes = typeof notesRaw === "string" ? notesRaw.trim() : "";
  if (notes.length > 5000) fieldErrors.notes = "Keep notes under 5,000 characters";
  if (Object.keys(fieldErrors).length > 0) return { ok: false, error: "Check the highlighted fields", fieldErrors };

  try {
    const deal = await updateDealDetails(await getDb(), idParsed.data, {
      offerCents: money.offer,
      purchaseCents: money.purchase,
      salePriceCents: money.sale,
      feesCents: money.fees,
      otherCostsCents: money.otherCosts,
      notes: notes || null,
      followUpAt: followUpAt ?? null,
    });
    if (!deal) return { ok: false, error: "This deal no longer exists" };
    revalidateDeal(deal.id, deal.listingId);
    return { ok: true, savedAt: Date.now() };
  } catch (error) {
    console.error("[pipeline] saving deal failed:", error);
    return { ok: false, error: "Couldn't save the deal. Try again." };
  }
}

// --- Messages -------------------------------------------------------------------------------

const messageInput = z.object({
  dealId,
  direction: z.enum(["out", "in", "note"]),
  body: z.string().trim().min(1, "Write something first").max(5000, "Keep it under 5,000 characters"),
});

export type MessageResult = { ok: true } | { ok: false; error: string };

export async function addDealMessageAction(formData: FormData): Promise<MessageResult> {
  await requireAuth();
  const parsed = messageInput.safeParse({
    dealId: formData.get("dealId"),
    direction: formData.get("direction"),
    body: formData.get("body") ?? "",
  });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid message" };
  try {
    const message = await addDealMessage(await getDb(), parsed.data.dealId, {
      direction: parsed.data.direction,
      body: parsed.data.body,
    });
    if (!message) return { ok: false, error: "This deal no longer exists" };
    revalidatePath(`/pipeline/${parsed.data.dealId}`);
    revalidatePath("/pipeline");
    return { ok: true };
  } catch (error) {
    console.error("[pipeline] adding message failed:", error);
    return { ok: false, error: "Couldn't add the message. Try again." };
  }
}

// --- Delete ---------------------------------------------------------------------------------

export async function deleteDealAction(id: number): Promise<{ ok: false; error: string }> {
  await requireAuth();
  const parsed = dealId.safeParse(id);
  if (!parsed.success) return { ok: false, error: "Invalid deal" };
  let listingId: number | null;
  try {
    listingId = await deleteDeal(await getDb(), parsed.data);
  } catch (error) {
    console.error("[pipeline] deleting deal failed:", error);
    return { ok: false, error: "Couldn't delete the deal. Try again." };
  }
  revalidateDeal(parsed.data, listingId ?? undefined);
  // redirect() throws, so it must stay outside the try/catch.
  redirect("/pipeline");
}
