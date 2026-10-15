"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { ActionFailure } from "@/components/ui/action-failure";
import { getDb } from "@/lib/db";
import { sendTestNotification } from "@/lib/notify";
import { unblockSeller } from "@/lib/queries/blocked-sellers";
import {
  clearMarketplaceBackoff,
  createChannel,
  deleteChannel,
  getChannel,
  setChannelEnabled,
  updateChannel,
} from "@/lib/queries/settings";
import { isMarketplaceId } from "@/lib/types";
import { requireAuth } from "../login/session";
import { formDataToChannelInput, validateChannelInput } from "./channel-config";

const channelId = z.coerce.number().int().positive().max(2_147_483_647);

function errorMessage(err: unknown): string {
  return err instanceof Error && err.message ? err.message : "Something went wrong";
}

export interface ChannelFormState {
  ok?: boolean;
  errors?: Record<string, string>;
  message?: string;
  /** Set by the form when the request itself failed (offline, session expired): nothing was saved. */
  failure?: ActionFailure;
}

/** Create a channel, or update one when the form carries a `channelId`. */
export async function saveChannelAction(_prev: ChannelFormState, formData: FormData): Promise<ChannelFormState> {
  await requireAuth();
  const rawId = formData.get("channelId");
  const id = rawId ? channelId.safeParse(rawId) : null;
  if (id && !id.success) return { message: "Invalid channel." };

  try {
    const db = await getDb();
    const existing = id ? await getChannel(db, id.data) : null;
    if (id && !existing) return { message: "This channel no longer exists." };

    const result = validateChannelInput(formDataToChannelInput(formData), existing);
    if (!result.ok) return { errors: result.errors, message: "Please fix the highlighted fields." };

    if (existing) await updateChannel(db, existing.id, { name: result.value.name, config: result.value.config });
    else await createChannel(db, result.value);
  } catch (err) {
    console.error("[settings] saving channel failed", err);
    return { message: `Couldn't save the channel: ${errorMessage(err)}` };
  }
  revalidatePath("/settings");
  return { ok: true };
}

export async function setChannelEnabledAction(id: number, enabled: boolean): Promise<{ ok: boolean }> {
  await requireAuth();
  const parsed = channelId.safeParse(id);
  if (!parsed.success || typeof enabled !== "boolean") return { ok: false };
  const ok = await setChannelEnabled(await getDb(), parsed.data, enabled);
  revalidatePath("/settings");
  return { ok };
}

export async function deleteChannelAction(id: number): Promise<{ ok: boolean }> {
  await requireAuth();
  const parsed = channelId.safeParse(id);
  if (!parsed.success) return { ok: false };
  const ok = await deleteChannel(await getDb(), parsed.data);
  revalidatePath("/settings");
  return { ok };
}

export async function testChannelAction(id: number): Promise<{ ok: boolean; error?: string }> {
  await requireAuth();
  const parsed = channelId.safeParse(id);
  if (!parsed.success) return { ok: false, error: "Invalid channel." };
  try {
    const result = await sendTestNotification(await getDb(), parsed.data);
    return result.ok ? { ok: true } : { ok: false, error: result.error ?? "Delivery failed" };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  } finally {
    revalidatePath("/settings");
  }
}

export async function clearBackoffAction(marketplace: string): Promise<void> {
  await requireAuth();
  if (!isMarketplaceId(marketplace)) return;
  await clearMarketplaceBackoff(await getDb(), marketplace);
  revalidatePath("/settings");
}

export async function unblockSellerAction(id: number): Promise<void> {
  await requireAuth();
  if (!Number.isSafeInteger(id) || id <= 0) return;
  await unblockSeller(await getDb(), id);
  revalidatePath("/settings");
}
