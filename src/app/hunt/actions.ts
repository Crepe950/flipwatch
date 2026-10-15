"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAuth } from "@/app/login/session";
import { aiStatus } from "@/lib/ai";
import { startHunt } from "@/lib/ai/deal-hunt";
import { getDb } from "@/lib/db";
import { findPreset, HOME_AREA_PREFIX } from "@/lib/locations";
import { getDefaultLocation } from "@/lib/queries/settings";

const input = z.object({
  prompt: z.string().trim().min(2, "Tell me what to look for").max(1000, "Keep it under 1,000 characters"),
  parentId: z.number().int().positive().nullable(),
  /** A location preset label and radius; omitted = the default location from Settings. */
  area: z
    .object({
      preset: z.string().max(200),
      radiusKm: z.coerce.number().min(1, "Radius must be 1–500 km").max(500, "Radius must be 1–500 km"),
    })
    .nullable()
    .optional(),
});

export type StartHuntResult = { ok: true; id: number } | { ok: false; error: string };

export async function startHuntAction(values: z.input<typeof input>): Promise<StartHuntResult> {
  await requireAuth();
  const parsed = input.safeParse(values);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid request" };
  const status = aiStatus();
  if (!status.configured) return { ok: false, error: status.message ?? "AI is not configured." };
  let location = null;
  const db = await getDb();
  if (parsed.data.area) {
    const radiusKm = Math.round(parsed.data.area.radiusKm);
    if (parsed.data.area.preset.startsWith(HOME_AREA_PREFIX)) {
      location = { ...(await getDefaultLocation(db)), radiusKm };
    } else {
      const preset = findPreset(parsed.data.area.preset);
      if (!preset) return { ok: false, error: "Choose a location from the list" };
      location = { ...preset, radiusKm };
    }
  }
  try {
    const id = await startHunt(db, parsed.data.prompt, parsed.data.parentId, location);
    revalidatePath("/hunt");
    return { ok: true, id };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message.slice(0, 300) : "Couldn't start the hunt" };
  }
}
