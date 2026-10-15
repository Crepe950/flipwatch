"use client";

import { cn } from "@/lib/cn";

/** Accessible on/off switch (role="switch"). Controlled. */
export function Switch({
  checked,
  onCheckedChange,
  label,
  disabled,
  className,
  id,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** Accessible name when there is no visible <label htmlFor>. */
  label?: string;
  disabled?: boolean;
  className?: string;
  id?: string;
}) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "relative inline-flex h-6 w-10 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "bg-accent" : "bg-border",
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "inline-block size-5 rounded-full bg-surface shadow-sm ring-1 ring-black/5 transition-transform",
          checked ? "translate-x-[1.05rem]" : "translate-x-0.5",
        )}
      />
    </button>
  );
}
