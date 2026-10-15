"use client";

import { useSyncExternalStore } from "react";
import { timeAgo } from "@/lib/format";
import { timeUntil } from "./relative-time";

// One shared 30 s clock for every <TimeAgo> on the page.
let now = Date.now();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(listener: () => void) {
  listeners.add(listener);
  now = Date.now();
  if (!timer) {
    timer = setInterval(() => {
      now = Date.now();
      listeners.forEach((l) => l());
    }, 30_000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

const getSnapshot = () => now;
const getServerSnapshot = () => null;

/** The shared clock (epoch ms, refreshed every 30 s), or null while rendering on the server and hydrating. */
export function useNow(): number | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Relative time ("3m ago") that refreshes itself every 30 s. */
export function TimeAgo({ date, className }: { date: Date | string | null | undefined; className?: string }) {
  const clock = useNow();
  if (!date) return <span className={className}>—</span>;
  const d = new Date(date);
  return (
    <time dateTime={d.toISOString()} title={d.toLocaleString()} className={className} suppressHydrationWarning>
      {timeAgo(d, clock === null ? undefined : new Date(clock))}
    </time>
  );
}

/** Relative future time ("in 12m") that refreshes itself every 30 s. */
export function TimeUntil({ date, className }: { date: Date | string; className?: string }) {
  const clock = useNow();
  const d = new Date(date);
  return (
    <time dateTime={d.toISOString()} title={d.toLocaleString()} className={className} suppressHydrationWarning>
      {timeUntil(d, clock === null ? undefined : new Date(clock))}
    </time>
  );
}
