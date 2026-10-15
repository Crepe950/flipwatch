"use client";

import Link from "next/link";
import { useOptimistic, useTransition } from "react";
import { Copy, LoaderCircle, Pencil, Play, Trash2 } from "lucide-react";
import { deleteSearchAction, duplicateSearchAction, runSearchNowAction, setSearchEnabledAction } from "@/app/searches/actions";
import { describeActionError, type ActionFailure } from "@/components/ui/action-failure";
import { Button, buttonClasses } from "@/components/ui/button";
import { MarketplaceBadge } from "@/components/ui/marketplace-badge";
import { ConfirmButton } from "./confirm-button";
import { formatDuration } from "./describe";
import { runHeadline, type RunSummary } from "./run-views";
import { SubmitButton } from "./submit-button";
import { Switch } from "./switch";
import { showToast } from "./toaster";

/** Why an action failed (offline, session expired…), with a way to sign in again when that's why. */
function showFailure(failure: ActionFailure) {
  showToast({
    tone: "error",
    title: failure.message,
    body: failure.signInHref ? (
      <a href={failure.signInHref} className="font-semibold text-accent hover:underline">
        Sign in
      </a>
    ) : undefined,
  });
}

/** Optimistic enabled/paused switch for a search card. */
export function SearchEnabledSwitch({ id, name, enabled }: { id: number; name: string; enabled: boolean }) {
  const [optimistic, setOptimistic] = useOptimistic(enabled);
  const [, startTransition] = useTransition();
  return (
    <Switch
      checked={optimistic}
      label={optimistic ? `Pause “${name}”` : `Resume “${name}”`}
      onCheckedChange={(next) =>
        startTransition(async () => {
          setOptimistic(next);
          try {
            const result = await setSearchEnabledAction(id, next);
            if (!result.ok) showToast({ tone: "error", title: "Couldn't update the search", body: "It may have been deleted." });
          } catch (err) {
            // The switch snaps back when the transition ends.
            showFailure(await describeActionError(err, next ? "Couldn't resume the search" : "Couldn't pause the search"));
          }
        })
      }
    />
  );
}

function RunSummaryBody({ summary }: { summary: RunSummary }) {
  return (
    <ul className="mt-1 space-y-1.5">
      {summary.marketplaces.map((m) => (
        <li key={m.marketplace} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
          <MarketplaceBadge marketplace={m.marketplace} />
          {m.error ? (
            <span className="min-w-0 break-words text-danger">{m.error}</span>
          ) : m.skipped ? (
            <span className="text-muted">Skipped — {m.skipped}</span>
          ) : (
            <span className="tabular-nums text-muted">
              {m.resultCount} results · {m.matchedCount} matched · <span className="text-fg">{m.newCount} new</span>
              {m.priceDropCount ? ` · ${m.priceDropCount} drops` : ""} · {formatDuration(m.durationMs)}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

function RunNowButton({ id }: { id: number }) {
  const [pending, startTransition] = useTransition();
  const run = () =>
    startTransition(async () => {
      try {
        const result = await runSearchNowAction(id);
        if (!result.ok) {
          showToast({ tone: "error", title: "Run failed", body: result.error });
          return;
        }
        const { summary } = result;
        showToast({
          tone: summary.errorCount > 0 || summary.marketplaces.length === 0 ? "error" : "success",
          title: `${summary.searchName}: ${runHeadline(summary)}`,
          body: summary.marketplaces.length ? <RunSummaryBody summary={summary} /> : "Pick at least one available marketplace.",
          durationMs: summary.errorCount > 0 ? 0 : 10_000,
        });
      } catch (err) {
        showFailure(await describeActionError(err, "Couldn't run the search"));
      }
    });

  return (
    <Button
      variant="secondary"
      size="sm"
      onClick={run}
      disabled={pending}
      aria-busy={pending || undefined}
      title="Poll every marketplace now, ignoring backoff"
    >
      {pending ? <LoaderCircle className="size-4 animate-spin" /> : <Play className="size-4" />}
      {pending ? "Running…" : "Run now"}
    </Button>
  );
}

/** Edit / Run now / Duplicate / Delete for one search. */
export function SearchActions({ id, name }: { id: number; name: string }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <RunNowButton id={id} />
      <Link href={`/searches/${id}/edit`} className={buttonClasses("secondary", "sm")}>
        <Pencil className="size-4" />
        Edit
      </Link>
      <form
        action={async () => {
          try {
            // Opens the copy's editor (a redirect, which describeActionError re-throws).
            await duplicateSearchAction(id);
          } catch (err) {
            showFailure(await describeActionError(err, "Couldn't duplicate the search"));
          }
        }}
      >
        <SubmitButton variant="ghost" size="sm" aria-label={`Duplicate “${name}”`} title="Duplicate" icon={<Copy className="size-4" />}>
          <span className="hidden sm:inline">Duplicate</span>
        </SubmitButton>
      </form>
      <ConfirmButton
        ariaLabel={`Delete “${name}”`}
        title={`Delete “${name}”?`}
        description="Its match history goes with it. Listings and pipeline deals are kept."
        onConfirm={async () => {
          try {
            const result = await deleteSearchAction(id);
            if (!result.ok) showToast({ tone: "error", title: "Couldn't delete the search", body: "It may already be gone." });
          } catch (err) {
            showFailure(await describeActionError(err, "Couldn't delete the search"));
          }
        }}
        className="text-danger hover:text-danger"
      >
        <Trash2 className="size-4" />
        <span className="hidden sm:inline">Delete</span>
      </ConfirmButton>
    </div>
  );
}
