import { TriangleAlert } from "lucide-react";
import { EnablePushButton } from "@/components/push/enable-push-button";

export interface WebPushInfo {
  vapidPublicKey: string | null;
  /** Both VAPID keys are set on the server. */
  configured: boolean;
}

/** Subscribe/unsubscribe this browser, with setup help when VAPID keys are missing. */
export function WebPushControls({ vapidPublicKey, configured }: WebPushInfo) {
  return (
    <div className="space-y-2">
      <EnablePushButton vapidPublicKey={vapidPublicKey} />
      {!configured ? (
        <p className="flex items-start gap-1.5 text-xs text-warn">
          <TriangleAlert className="mt-px size-3.5 shrink-0" />
          <span>
            Browser push needs VAPID keys. Run <code className="rounded bg-surface-2 px-1">npx web-push generate-vapid-keys</code> and set{" "}
            <code className="rounded bg-surface-2 px-1">VAPID_PUBLIC_KEY</code> and{" "}
            <code className="rounded bg-surface-2 px-1">VAPID_PRIVATE_KEY</code>, then restart.
          </span>
        </p>
      ) : (
        <p className="text-xs text-muted">
          Enable push on each phone or computer that should get alerts. On iPhone, add FlipWatch to your Home Screen first.
        </p>
      )}
    </div>
  );
}
