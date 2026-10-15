import { Sparkles } from "lucide-react";
import { cn } from "@/lib/cn";
import type { AiVerdict } from "@/lib/types";

// Own classes rather than <Badge tone>: "great" needs a solid fill, and stacking a second bg-*
// utility on top of Badge's would depend on CSS source order.
const VERDICTS: Record<AiVerdict, { label: string; className: string }> = {
  great: { label: "Great deal", className: "bg-accent text-accent-contrast" },
  good: { label: "Good deal", className: "bg-accent-soft text-accent" },
  fair: { label: "Fair", className: "bg-warn-soft text-warn" },
  pass: { label: "Pass", className: "bg-surface-2 text-muted" },
};

export function aiVerdictLabel(verdict: AiVerdict): string {
  return VERDICTS[verdict]?.label ?? verdict;
}

export function AiVerdictBadge({ verdict, className, title }: { verdict: AiVerdict; className?: string; title?: string }) {
  const v = VERDICTS[verdict] ?? { label: verdict, className: "bg-surface-2 text-muted" };
  return (
    <span
      title={title ?? `AI verdict: ${v.label}`}
      className={cn("inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium whitespace-nowrap", v.className, className)}
    >
      <Sparkles className="size-3" aria-hidden />
      <span className="sr-only">AI verdict: </span>
      {v.label}
    </span>
  );
}
