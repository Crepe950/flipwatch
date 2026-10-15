import { cn } from "@/lib/cn";

/** Colored pill for a 0–100 deal score. */
export function DealScore({ score, className, title }: { score: number | null | undefined; className?: string; title?: string }) {
  if (score === null || score === undefined) {
    return (
      <span title={title ?? "Not enough data to score yet"} className={cn("inline-flex items-center rounded-md bg-surface-2 px-1.5 py-0.5 text-xs font-medium text-muted", className)}>
        No score
      </span>
    );
  }
  const tone =
    score >= 80 ? "bg-accent text-accent-contrast" : score >= 60 ? "bg-accent-soft text-accent" : score >= 40 ? "bg-warn-soft text-warn" : "bg-surface-2 text-muted";
  return (
    <span title={title} className={cn("inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-semibold tabular-nums", tone, className)}>
      {score}
      <span className="font-normal">/100</span>
    </span>
  );
}
