"use client";

import {
  createContext,
  useContext,
  useId,
  type InputHTMLAttributes,
  type LabelHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { cn } from "@/lib/cn";

const control =
  "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-fg placeholder:text-muted/70 focus:outline-2 focus:outline-offset-0 focus:outline-accent disabled:opacity-60 aria-invalid:border-danger aria-invalid:focus:outline-danger";

/** What a Field tells the control inside it: the id of its error or hint text, and whether it has an error. */
interface FieldState {
  describedBy?: string;
  invalid: boolean;
}

const FieldContext = createContext<FieldState | null>(null);

/** The enclosing Field's error/hint wiring, for custom controls (see ChipInput). */
export function useField(): FieldState | null {
  return useContext(FieldContext);
}

type AriaProps = { "aria-describedby"?: string; "aria-invalid"?: InputHTMLAttributes<HTMLInputElement>["aria-invalid"] };

/** Link a control to its Field's error/hint and mark it invalid while the Field shows an error. */
function useFieldAria<P extends AriaProps>(props: P): P {
  const field = useContext(FieldContext);
  if (!field) return props;
  const describedBy = [props["aria-describedby"], field.describedBy].filter(Boolean).join(" ") || undefined;
  return { ...props, "aria-describedby": describedBy, "aria-invalid": props["aria-invalid"] ?? (field.invalid || undefined) };
}

export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn("block text-sm font-medium", className)} {...props} />;
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(control, "h-10", className)} {...useFieldAria(props)} />;
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(control, "min-h-24", className)} {...useFieldAria(props)} />;
}

export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn(control, "h-10", className)} {...useFieldAria(props)} />;
}

export function Checkbox({ className, label, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode }) {
  return (
    <label className={cn("inline-flex cursor-pointer items-center gap-2 text-sm", className)}>
      <input type="checkbox" className="size-4 accent-[var(--accent)]" {...props} />
      <span>{label}</span>
    </label>
  );
}

/** Label + control + hint/error, stacked. The control is described by the error (or hint) text. */
export function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
  className,
}: {
  label: ReactNode;
  htmlFor?: string;
  hint?: ReactNode;
  error?: string | string[] | null;
  children: ReactNode;
  className?: string;
}) {
  const autoId = useId();
  const message = Array.isArray(error) ? error[0] : error;
  const base = htmlFor ?? autoId;
  const describedBy = message ? `${base}-error` : hint ? `${base}-hint` : undefined;
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      <FieldContext value={{ describedBy, invalid: Boolean(message) }}>{children}</FieldContext>
      {message ? (
        <p id={describedBy} className="text-xs text-danger">
          {message}
        </p>
      ) : hint ? (
        <p id={describedBy} className="text-xs text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
