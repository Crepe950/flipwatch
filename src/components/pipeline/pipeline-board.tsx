"use client";

import { startTransition, useOptimistic, useState } from "react";
import { moveDealStageAction } from "@/app/pipeline/actions";
import { ActionError } from "@/components/ui/action-error";
import { describeActionError, type ActionFailure } from "@/components/ui/action-failure";
import { cn } from "@/lib/cn";
import { DEAL_STAGE_LABELS, DEAL_STAGES, type DealStage } from "@/lib/types";
import type { PipelineCardData } from "./card-data";
import { DealCard } from "./deal-card";

type Move = { id: number; stage: DealStage };

function StageEmpty() {
  return <p className="rounded-xl border border-dashed border-border px-3 py-6 text-center text-xs text-muted">No deals here</p>;
}

/**
 * Kanban on desktop (horizontal scroll), stage tabs + list on phones. Stage moves are optimistic:
 * the card jumps immediately and snaps back if the server rejects the move.
 */
export function PipelineBoard({ cards, initialStage }: { cards: PipelineCardData[]; initialStage: DealStage }) {
  const [optimisticCards, applyMove] = useOptimistic(cards, (current, move: Move) =>
    current.map((c) => (c.id === move.id ? { ...c, stage: move.stage, daysInStage: 0 } : c)),
  );
  const [pendingIds, setPendingIds] = useOptimistic<ReadonlySet<number>, number>(new Set(), (current, id) => new Set(current).add(id));
  const [tab, setTab] = useState<DealStage>(initialStage);
  const [error, setError] = useState<ActionFailure | null>(null);

  function move(card: PipelineCardData, stage: DealStage) {
    if (stage === card.stage) return;
    setError(null);
    startTransition(async () => {
      applyMove({ id: card.id, stage });
      setPendingIds(card.id);
      try {
        const result = await moveDealStageAction(card.id, stage);
        if (!result.ok) setError({ message: `${card.title}: ${result.error}` });
      } catch (err) {
        // The card snaps back to its column when the transition ends.
        setError(await describeActionError(err, `Couldn't move “${card.title}”`));
      }
    });
  }

  const byStage = new Map<DealStage, PipelineCardData[]>(DEAL_STAGES.map((s) => [s, []]));
  for (const card of optimisticCards) byStage.get(card.stage)?.push(card);

  const renderCard = (card: PipelineCardData) => (
    <li key={card.id}>
      <DealCard card={card} pending={pendingIds.has(card.id)} onMove={(stage) => move(card, stage)} />
    </li>
  );

  return (
    <div>
      <ActionError error={error} className="mb-3 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger" />

      {/* Phones: stage tabs + one list */}
      <div className="md:hidden">
        <div role="tablist" aria-label="Pipeline stages" className="-mx-4 mb-3 flex gap-1.5 overflow-x-auto px-4 pb-1 [scrollbar-width:none]">
          {DEAL_STAGES.map((stage) => {
            const count = byStage.get(stage)!.length;
            const selected = tab === stage;
            return (
              <button
                key={stage}
                type="button"
                role="tab"
                id={`tab-${stage}`}
                aria-selected={selected}
                aria-controls="stage-panel"
                onClick={() => setTab(stage)}
                className={cn(
                  "flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs font-medium",
                  selected ? "border-accent/40 bg-accent-soft text-accent" : "border-border bg-surface text-muted",
                )}
              >
                {DEAL_STAGE_LABELS[stage]}
                <span className="tabular-nums opacity-80">{count}</span>
              </button>
            );
          })}
        </div>
        <div role="tabpanel" id="stage-panel" aria-labelledby={`tab-${tab}`}>
          {byStage.get(tab)!.length === 0 ? <StageEmpty /> : <ul className="space-y-2.5">{byStage.get(tab)!.map(renderCard)}</ul>}
        </div>
      </div>

      {/* Desktop: kanban */}
      <div className="-mr-6 hidden gap-3 overflow-x-auto pr-6 pb-4 md:flex">
        {DEAL_STAGES.map((stage) => {
          const list = byStage.get(stage)!;
          return (
            <section key={stage} aria-labelledby={`col-${stage}`} className="flex w-72 shrink-0 flex-col rounded-xl bg-surface-2/60 p-2">
              <h2 id={`col-${stage}`} className="flex items-center justify-between px-1.5 pt-1 pb-2 text-sm font-semibold">
                {DEAL_STAGE_LABELS[stage]}
                <span className="rounded-md bg-surface px-1.5 py-0.5 text-xs font-medium text-muted tabular-nums">{list.length}</span>
              </h2>
              {list.length === 0 ? <StageEmpty /> : <ul className="space-y-2">{list.map(renderCard)}</ul>}
            </section>
          );
        })}
      </div>
    </div>
  );
}
