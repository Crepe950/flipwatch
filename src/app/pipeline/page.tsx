import type { Metadata } from "next";
import Link from "next/link";
import { KanbanSquare } from "lucide-react";
import { toPipelineCard, toSummaryDeal } from "@/components/pipeline/card-data";
import { PipelineBoard } from "@/components/pipeline/pipeline-board";
import { SummaryCards } from "@/components/pipeline/summary-cards";
import { buttonClasses } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { getDb } from "@/lib/db";
import { pipelineSummary } from "@/lib/deals";
import { listPipelineDeals } from "@/lib/queries/deals";
import { DEAL_STAGES, type DealStage } from "@/lib/types";

export const metadata: Metadata = { title: "Pipeline" };

function mostCommonCurrency(currencies: string[]): string {
  const counts = new Map<string, number>();
  for (const c of currencies) counts.set(c, (counts.get(c) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "USD";
}

export default async function PipelinePage({ searchParams }: PageProps<"/pipeline">) {
  const { stage } = await searchParams;
  const deals = await listPipelineDeals(await getDb());
  const now = new Date();
  const cards = deals.map((d) => toPipelineCard(d, now));
  const summary = pipelineSummary(deals.map(toSummaryDeal), now);
  const currency = mostCommonCurrency(deals.map((d) => d.listing.currency));

  const requested = typeof stage === "string" && (DEAL_STAGES as readonly string[]).includes(stage) ? (stage as DealStage) : null;
  // On phones open the first stage that has something in it.
  const initialStage = requested ?? DEAL_STAGES.find((s) => cards.some((c) => c.stage === s)) ?? "lead";

  return (
    <>
      <PageHeader title="Pipeline" description="Every flip from first message to sold, with profit and ROI." />
      <SummaryCards summary={summary} currency={currency} />
      {cards.length === 0 ? (
        <EmptyState
          icon={<KanbanSquare className="size-8" aria-hidden />}
          title="Your pipeline is empty"
          description="Add a listing from the deal feed or a listing page, or log a message to a seller — it lands here as a lead."
          action={
            <Link href="/" className={buttonClasses("primary", "md")}>
              Browse deals
            </Link>
          }
        />
      ) : (
        <PipelineBoard cards={cards} initialStage={initialStage} />
      )}
    </>
  );
}
