"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAuth } from "@/app/login/session";
import { getDb } from "@/lib/db";
import { addListingToPipeline } from "@/lib/queries/deals";
import { markAllMatchesSeen, setMatchDismissed, setMatchSeen } from "@/lib/queries/feed";
import { markListingMatchesSeen } from "@/lib/queries/listings";
import type { DealStage } from "@/lib/types";
import { parseFeedQueryStrict, queryToFilters } from "./filter-params";

export type ActionResult<T extends object = object> = ({ ok: true } & T) | { ok: false; error: string };

const id = z.number().int().positive().max(2_147_483_647);

function fail(error: unknown, fallback: string): { ok: false; error: string } {
  console.error(`[feed] ${fallback}:`, error);
  return { ok: false, error: fallback };
}

export async function setMatchDismissedAction(matchId: number, dismissed: boolean): Promise<ActionResult> {
  await requireAuth();
  const parsed = z.tuple([id, z.boolean()]).safeParse([matchId, dismissed]);
  if (!parsed.success) return { ok: false, error: "Invalid match" };
  try {
    const listingId = await setMatchDismissed(await getDb(), parsed.data[0], parsed.data[1]);
    if (listingId === null) return { ok: false, error: "This match no longer exists" };
    revalidatePath("/");
    return { ok: true };
  } catch (error) {
    return fail(error, dismissed ? "Couldn't dismiss the match" : "Couldn't restore the match");
  }
}

export async function markMatchSeenAction(matchId: number): Promise<ActionResult> {
  await requireAuth();
  const parsed = id.safeParse(matchId);
  if (!parsed.success) return { ok: false, error: "Invalid match" };
  try {
    const listingId = await setMatchSeen(await getDb(), parsed.data, true);
    if (listingId === null) return { ok: false, error: "This match no longer exists" };
    revalidatePath("/");
    return { ok: true };
  } catch (error) {
    return fail(error, "Couldn't mark the match as seen");
  }
}

/** "Mark all seen" for the feed's filters (its canonical query string): marks exactly what it counts as unseen. */
export async function markAllSeenAction(queryString: string): Promise<ActionResult<{ count: number }>> {
  await requireAuth();
  const valid = typeof queryString === "string" && queryString.length <= 1_000;
  const query = valid ? parseFeedQueryStrict(new URLSearchParams(queryString)) : null;
  if (!query?.success) return { ok: false, error: "Invalid filters" };
  try {
    const count = await markAllMatchesSeen(await getDb(), queryToFilters(query.data));
    revalidatePath("/");
    return { ok: true, count };
  } catch (error) {
    return fail(error, "Couldn't mark matches as seen");
  }
}

/** Called when a listing's detail page is opened. */
export async function markListingSeenAction(listingId: number): Promise<ActionResult> {
  await requireAuth();
  const parsed = id.safeParse(listingId);
  if (!parsed.success) return { ok: false, error: "Invalid listing" };
  try {
    const changed = await markListingMatchesSeen(await getDb(), parsed.data);
    if (changed > 0) revalidatePath("/");
    return { ok: true };
  } catch (error) {
    return fail(error, "Couldn't mark the listing as seen");
  }
}

/** Idempotent: returns the existing deal when the listing is already in the pipeline. */
export async function addToPipelineAction(
  listingId: number,
): Promise<ActionResult<{ dealId: number; stage: DealStage; created: boolean }>> {
  await requireAuth();
  const parsed = id.safeParse(listingId);
  if (!parsed.success) return { ok: false, error: "Invalid listing" };
  try {
    const result = await addListingToPipeline(await getDb(), parsed.data);
    if (!result) return { ok: false, error: "This listing no longer exists" };
    revalidatePath("/pipeline");
    revalidatePath(`/listings/${parsed.data}`);
    revalidatePath("/");
    return { ok: true, dealId: result.deal.id, stage: result.deal.stage, created: result.created };
  } catch (error) {
    return fail(error, "Couldn't add the listing to your pipeline");
  }
}
