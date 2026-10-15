"use client";

import { cn } from "@/lib/cn";
import { DEAL_STAGE_LABELS, DEAL_STAGES, type DealStage } from "@/lib/types";

export function StageSelect({
  value,
  onChange,
  disabled,
  className,
  label = "Stage",
  size = "sm",
}: {
  value: DealStage;
  onChange: (stage: DealStage) => void;
  disabled?: boolean;
  className?: string;
  label?: string;
  size?: "sm" | "md";
}) {
  return (
    <select
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as DealStage)}
      className={cn(
        "rounded-lg border border-border bg-surface font-medium text-fg focus:outline-2 focus:outline-offset-0 focus:outline-accent disabled:opacity-60",
        size === "md" ? "h-10 px-3 text-sm" : "h-8 px-2 text-xs",
        className,
      )}
    >
      {DEAL_STAGES.map((stage) => (
        <option key={stage} value={stage}>
          {DEAL_STAGE_LABELS[stage]}
        </option>
      ))}
    </select>
  );
}
