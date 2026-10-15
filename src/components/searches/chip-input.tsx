"use client";

import { useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { X } from "lucide-react";
import { useField } from "@/components/ui/field";
import { cn } from "@/lib/cn";
import { normalizeTerms, splitTerms } from "./form-values";

/** Tag-style input: Enter or comma adds a chip, × (or Backspace on an empty input) removes one. */
export function ChipInput({
  id,
  value,
  onChange,
  placeholder,
  maxChips = 50,
  maxLength = 60,
  invalid,
  describedBy,
}: {
  id?: string;
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  maxChips?: number;
  maxLength?: number;
  invalid?: boolean;
  describedBy?: string;
}) {
  const [draft, setDraft] = useState("");
  const field = useField();

  const add = (raw: string[]) => {
    const next = normalizeTerms([...value, ...raw]).slice(0, maxChips);
    if (next.length !== value.length) onChange(next);
    setDraft("");
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      if (draft.trim()) add([draft]);
    } else if (e.key === "Backspace" && draft === "" && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData("text");
    if (text.includes(",") || text.includes("\n")) {
      e.preventDefault();
      add(splitTerms(`${draft},${text.replace(/\n/g, ",")}`));
    }
  };

  return (
    <div
      className={cn(
        "flex min-h-10 w-full flex-wrap items-center gap-1.5 rounded-lg border bg-surface px-2 py-1.5 text-sm focus-within:outline-2 focus-within:outline-accent",
        invalid ? "border-danger" : "border-border",
      )}
    >
      {value.map((term) => (
        <span key={term.toLowerCase()} className="inline-flex max-w-full items-center gap-1 rounded-md bg-surface-2 py-0.5 pr-1 pl-2 text-sm">
          <span className="truncate">{term}</span>
          <button
            type="button"
            onClick={() => onChange(value.filter((t) => t !== term))}
            className="rounded p-0.5 text-muted hover:bg-border hover:text-fg"
            aria-label={`Remove “${term}”`}
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      <input
        id={id}
        value={draft}
        onChange={(e) => {
          const next = e.target.value;
          // Mobile keyboards don't always fire keydown for ",", so also split on input.
          if (next.includes(",")) add(splitTerms(next));
          else setDraft(next);
        }}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onBlur={() => draft.trim() && add([draft])}
        placeholder={value.length ? undefined : placeholder}
        maxLength={maxLength}
        disabled={value.length >= maxChips}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy ?? field?.describedBy}
        enterKeyHint="enter"
        className="min-w-24 flex-1 bg-transparent px-1 py-0.5 outline-none placeholder:text-muted/70"
      />
    </div>
  );
}
