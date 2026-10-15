"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { parseSearchForm, type SearchFormErrors } from "@/components/searches/form-values";
import { summarizeRun, toPreviewView, type PreviewMarketplaceView, type RunSummary } from "@/components/searches/run-views";
import type { ActionFailure } from "@/components/ui/action-failure";
import { getDb } from "@/lib/db";
import { previewSearch, runSearch } from "@/lib/engine";
import { createSearch, deleteSearch, duplicateSearch, getSearch, setSearchEnabled, updateSearch } from "@/lib/queries/searches";
import { requireAuth } from "../login/session";
import { skipReasonsFor } from "./editor-data";

const searchId = z.number().int().positive().max(2_147_483_647);

function errorMessage(err: unknown): string {
  return err instanceof Error && err.message ? err.message : "Something went wrong";
}

export interface SaveSearchState {
  errors?: SearchFormErrors;
  message?: string;
  /** Set by the editor when the request itself failed (offline, session expired): nothing was saved. */
  failure?: ActionFailure;
}

const savePayload = z.object({ searchId: searchId.nullable(), values: z.unknown() });

/** Create (searchId null) or update a search from the editor, then go back to the list. */
export async function saveSearchAction(_prev: SaveSearchState, payload: unknown): Promise<SaveSearchState> {
  await requireAuth();
  const envelope = savePayload.safeParse(payload);
  if (!envelope.success) return { message: "The form data was malformed. Reload the page and try again." };
  const parsed = parseSearchForm(envelope.data.values);
  if (!parsed.ok) return { errors: parsed.errors, message: parsed.errors.form ?? "Please fix the highlighted fields." };

  try {
    const db = await getDb();
    if (envelope.data.searchId === null) {
      await createSearch(db, parsed.input);
    } else if (!(await updateSearch(db, envelope.data.searchId, parsed.input))) {
      return { message: "This search no longer exists. It may have been deleted in another tab." };
    }
  } catch (err) {
    console.error("[searches] save failed", err);
    return { message: `Couldn't save the search: ${errorMessage(err)}` };
  }
  revalidatePath("/searches");
  redirect("/searches");
}

export type PreviewState =
  | { status: "idle" }
  | { status: "invalid"; errors: SearchFormErrors }
  | { status: "error"; error: string }
  | { status: "done"; ranAt: string; results: PreviewMarketplaceView[] }
  /** Set by the editor when the request itself failed (offline, session expired). */
  | { status: "failed"; failure: ActionFailure };

/** "Test search": run the unsaved definition once against the marketplaces without storing anything. */
export async function previewSearchAction(_prev: PreviewState, values: unknown): Promise<PreviewState> {
  await requireAuth();
  const parsed = parseSearchForm(values);
  if (!parsed.ok) return { status: "invalid", errors: parsed.errors };
  try {
    const results = await previewSearch(parsed.input);
    const view = toPreviewView(results, { skipReasons: skipReasonsFor(parsed.input.location.countryCode) });
    return { status: "done", ranAt: new Date().toISOString(), results: view };
  } catch (err) {
    console.error("[searches] preview failed", err);
    return { status: "error", error: errorMessage(err) };
  }
}

export async function setSearchEnabledAction(id: number, enabled: boolean): Promise<{ ok: boolean }> {
  await requireAuth();
  const parsedId = searchId.safeParse(id);
  if (!parsedId.success || typeof enabled !== "boolean") return { ok: false };
  const ok = await setSearchEnabled(await getDb(), parsedId.data, enabled);
  revalidatePath("/searches");
  return { ok };
}

export type RunNowResult = { ok: true; summary: RunSummary } | { ok: false; error: string };

/** "Run now": poll every marketplace immediately, ignoring backoff. */
export async function runSearchNowAction(id: number): Promise<RunNowResult> {
  await requireAuth();
  const parsedId = searchId.safeParse(id);
  if (!parsedId.success) return { ok: false, error: "Invalid search id" };
  const db = await getDb();
  const search = await getSearch(db, parsedId.data);
  if (!search) return { ok: false, error: "This search no longer exists." };
  try {
    const result = await runSearch(db, search.id, { force: true });
    return { ok: true, summary: summarizeRun(result, search.name, skipReasonsFor(search.location.countryCode)) };
  } catch (err) {
    console.error(`[searches] run now failed for search ${search.id}`, err);
    return { ok: false, error: errorMessage(err) };
  } finally {
    revalidatePath("/searches");
  }
}

export async function duplicateSearchAction(id: number): Promise<void> {
  await requireAuth();
  const parsedId = searchId.safeParse(id);
  if (!parsedId.success) return;
  const copy = await duplicateSearch(await getDb(), parsedId.data);
  revalidatePath("/searches");
  if (copy) redirect(`/searches/${copy.id}/edit?duplicated=1`);
}

export async function deleteSearchAction(id: number): Promise<{ ok: boolean }> {
  await requireAuth();
  const parsedId = searchId.safeParse(id);
  if (!parsedId.success) return { ok: false };
  const ok = await deleteSearch(await getDb(), parsedId.data);
  revalidatePath("/searches");
  return { ok };
}
