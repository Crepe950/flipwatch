"use client";

import { useEffect, useState } from "react";
import { CircleAlert, KeyRound, RotateCw, WifiOff } from "lucide-react";
import { diagnoseFailure, signInHref, type FailureKind } from "@/components/ui/action-failure";
import { Button, buttonClasses } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

const COPY: Record<FailureKind, { icon: typeof CircleAlert; title: string; description: string }> = {
  offline: { icon: WifiOff, title: "You're offline", description: "Check your connection, then try again." },
  session: { icon: KeyRound, title: "Your session expired", description: "Sign in again to continue." },
  server: { icon: CircleAlert, title: "Something went wrong", description: "Try again in a moment." },
};

/**
 * Safety net for errors no control handled (a request that failed, a server error while rendering):
 * says why in the page area and keeps the navigation, instead of Next.js's bare error screen.
 */
export default function AppError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  const [failure, setFailure] = useState<{ kind: FailureKind; next: string } | null>(null);

  useEffect(() => {
    console.error(error);
    let current = true;
    void diagnoseFailure().then((kind) => {
      if (current) setFailure({ kind, next: `${window.location.pathname}${window.location.search}` });
    });
    return () => {
      current = false;
    };
  }, [error]);

  const { icon: Icon, title, description } = COPY[failure?.kind ?? "server"];
  return (
    <EmptyState
      icon={<Icon className="size-8" aria-hidden />}
      title={<span role="alert">{title}</span>}
      description={
        <>
          {description}
          {error.digest ? <span className="mt-1 block text-xs">Error ID: {error.digest}</span> : null}
        </>
      }
      action={
        <div className="flex flex-wrap justify-center gap-2">
          {failure?.kind === "session" ? (
            <a href={signInHref(failure.next)} className={buttonClasses()}>
              Sign in
            </a>
          ) : null}
          <Button variant={failure?.kind === "session" ? "secondary" : "primary"} onClick={() => retry()}>
            <RotateCw className="size-4" aria-hidden />
            Try again
          </Button>
        </div>
      }
    />
  );
}
