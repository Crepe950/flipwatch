import { useId } from "react";
import { DealScore } from "@/components/ui/deal-score";
import { cn } from "@/lib/cn";

/**
 * Deal score pill whose explanation appears on hover and on keyboard/tap focus (a native title
 * tooltip never shows on phones).
 */
export function ScoreWithReason({ score, reason, className }: { score: number | null; reason: string | null; className?: string }) {
  const tooltipId = useId();
  if (!reason) return <DealScore score={score} className={className} />;
  return (
    <span className={cn("group/score relative inline-flex", className)}>
      <button
        type="button"
        aria-describedby={tooltipId}
        className="inline-flex rounded-md focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
      >
        <DealScore score={score} />
        <span className="sr-only">Deal score details</span>
      </button>
      {/* display:none (not just invisible) while hidden: a hidden w-max box still widens narrow pages. */}
      <span
        id={tooltipId}
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-0 z-20 mb-1.5 hidden w-max max-w-[min(16rem,calc(100vw-9rem))] rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs font-normal text-fg shadow-lg group-focus-within/score:block group-hover/score:block"
      >
        {reason}
      </span>
    </span>
  );
}
