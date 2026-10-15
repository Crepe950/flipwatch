import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { formatMoneyTotals, formatRoi, type PipelineSummary } from "@/lib/deals";

function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "good" | "bad" | "warn" }) {
  return (
    <div className="rounded-xl border border-border bg-surface px-3 py-2.5">
      <dt className="text-xs text-muted">{label}</dt>
      <dd
        className={cn(
          "mt-0.5 truncate text-xl font-semibold tracking-tight",
          tone === "good" && "text-accent",
          tone === "bad" && "text-danger",
          tone === "warn" && "text-warn",
        )}
      >
        {value}
      </dd>
      {sub ? <dd className="truncate text-xs text-muted">{sub}</dd> : null}
    </div>
  );
}

export function SummaryCards({ summary, currency }: { summary: PipelineSummary; currency: string }) {
  const profitValues = Object.values(summary.realizedProfit);
  const profitTone = profitValues.some((v) => v < 0) && !profitValues.some((v) => v > 0) ? "bad" : profitValues.some((v) => v > 0) ? "good" : undefined;
  return (
    <dl className="mb-5 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
      <Stat label="Capital tied up" value={formatMoneyTotals(summary.capitalTiedUp, currency)} sub="Not sold yet" />
      <Stat
        label="Realized profit"
        value={formatMoneyTotals(summary.realizedProfit, currency)}
        sub={`${summary.soldCount} sold`}
        tone={profitTone}
      />
      <Stat label="Avg ROI" value={formatRoi(summary.avgRoi)} sub="On sold deals" tone={summary.avgRoi !== null && summary.avgRoi < 0 ? "bad" : undefined} />
      <Stat
        label="Days to sell"
        value={summary.avgDaysToSell === null ? "—" : summary.avgDaysToSell < 1 ? "<1" : Math.round(summary.avgDaysToSell)}
        sub="Purchase → sold"
      />
      <Stat label="Open leads" value={summary.openLeads} sub="Before purchase" />
      <Stat
        label="Follow-ups due"
        value={summary.followUpsDue}
        sub={summary.followUpsOverdue > 0 ? `${summary.followUpsOverdue} overdue` : "Today"}
        tone={summary.followUpsOverdue > 0 ? "bad" : summary.followUpsDue > 0 ? "warn" : undefined}
      />
    </dl>
  );
}
