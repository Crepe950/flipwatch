"use client";

import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { CircleAlert, CircleCheck, Info, X } from "lucide-react";
import { cn } from "@/lib/cn";

export type ToastTone = "success" | "error" | "info";

export interface Toast {
  id: number;
  tone: ToastTone;
  title: string;
  body?: ReactNode;
  /** Auto-dismiss delay; 0 keeps the toast until closed. */
  durationMs: number;
}

// Tiny module-level store so any client component can raise a toast without a context provider.
let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const MAX_TOASTS = 4;
const EMPTY: Toast[] = [];

function emit() {
  listeners.forEach((listener) => listener());
}

export function showToast(toast: Omit<Toast, "id" | "durationMs"> & { durationMs?: number }): number {
  const id = nextId++;
  const durationMs = toast.durationMs ?? (toast.tone === "error" ? 0 : 8_000);
  toasts = [...toasts, { ...toast, id, durationMs }].slice(-MAX_TOASTS);
  emit();
  return id;
}

export function dismissToast(id: number) {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const TONE: Record<ToastTone, { icon: typeof Info; className: string }> = {
  success: { icon: CircleCheck, className: "text-accent" },
  error: { icon: CircleAlert, className: "text-danger" },
  info: { icon: Info, className: "text-info" },
};

function ToastItem({ toast }: { toast: Toast }) {
  useEffect(() => {
    if (!toast.durationMs) return;
    const timer = setTimeout(() => dismissToast(toast.id), toast.durationMs);
    return () => clearTimeout(timer);
  }, [toast.id, toast.durationMs]);

  const { icon: Icon, className } = TONE[toast.tone];
  return (
    <div role={toast.tone === "error" ? "alert" : "status"} className="pointer-events-auto rounded-xl border border-border bg-surface p-3 shadow-lg">
      <div className="flex items-start gap-2.5">
        <Icon className={cn("mt-0.5 size-4 shrink-0", className)} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{toast.title}</p>
          {toast.body ? <div className="mt-1 text-sm text-muted">{toast.body}</div> : null}
        </div>
        <button
          type="button"
          onClick={() => dismissToast(toast.id)}
          className="-m-1 rounded-md p-1 text-muted hover:bg-surface-2 hover:text-fg"
          aria-label="Dismiss"
        >
          <X className="size-4" />
        </button>
      </div>
    </div>
  );
}

/** Renders the toast stack; mount once per page (above the mobile tab bar). */
export function Toaster() {
  const items = useSyncExternalStore(
    subscribe,
    () => toasts,
    () => EMPTY,
  );
  if (items.length === 0) return null;
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-3 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-50 flex flex-col gap-2 sm:left-auto sm:w-96 md:right-6 md:bottom-6"
    >
      {items.map((toast) => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </div>
  );
}
