"use client";

import { useSyncExternalStore } from "react";
import { Bell, BellOff, BellRing, LoaderCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { disablePush, enablePush, getServerSnapshot, getSnapshot, subscribe, type PushStatus } from "./push-client";

const NOT_CONFIGURED_HINT = "Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY on the server (npx web-push generate-vapid-keys) to enable.";

const HINTS: Record<PushStatus, string | null> = {
  loading: null,
  unsupported: "This browser doesn't support push notifications.",
  "ios-install": "On iPhone and iPad, push works in the installed app: tap Share → Add to Home Screen, then open FlipWatch from there.",
  blocked: "Notifications are blocked for this site. Allow them in your browser's site settings, then reload.",
  off: "Get alerts on this device even when FlipWatch isn't open.",
  on: "This device receives FlipWatch alerts.",
};

/** Subscribe this browser to FlipWatch alerts (Web Push), or unsubscribe it. */
export function EnablePushButton({ vapidPublicKey }: { vapidPublicKey: string | null }) {
  const { status, busy, error } = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const spinner = <LoaderCircle className="size-4 animate-spin" aria-hidden />;

  if (status === "on") {
    return (
      <div className="space-y-1.5" aria-live="polite">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="green">
            <BellRing className="size-3.5" aria-hidden />
            Browser push on
          </Badge>
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => void disablePush()}>
            {busy ? spinner : <BellOff className="size-4" aria-hidden />}
            Disable
          </Button>
        </div>
        <Message error={error} hint={HINTS.on} />
      </div>
    );
  }

  const configured = vapidPublicKey !== null;
  const canEnable = configured && status === "off" && !busy;
  const hint = configured || status === "unsupported" || status === "ios-install" ? HINTS[status] : NOT_CONFIGURED_HINT;
  return (
    <div className="space-y-1.5" aria-live="polite">
      <Button
        variant={canEnable ? "primary" : "secondary"}
        disabled={!canEnable}
        onClick={() => {
          if (vapidPublicKey) void enablePush(vapidPublicKey);
        }}
      >
        {busy || status === "loading" ? spinner : <Bell className="size-4" aria-hidden />}
        Enable browser push
      </Button>
      <Message error={error} hint={hint} />
    </div>
  );
}

function Message({ error, hint }: { error: string | null; hint: string | null }) {
  if (error) return <p className="text-xs text-danger">{error}</p>;
  return hint ? <p className="text-xs text-muted">{hint}</p> : null;
}
