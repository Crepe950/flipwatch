"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Re-render the page once after `ms`, e.g. when the server is still reading something in the background. */
export function RefreshSoon({ ms }: { ms: number }) {
  const router = useRouter();
  useEffect(() => {
    const timer = setTimeout(() => router.refresh(), ms);
    return () => clearTimeout(timer);
  }, [router, ms]);
  return null;
}
