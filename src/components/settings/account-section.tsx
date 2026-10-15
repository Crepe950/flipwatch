import { LockOpen, LogOut, ShieldCheck } from "lucide-react";
import { logoutAction } from "@/app/login/actions";
import { SubmitButton } from "@/components/searches/submit-button";
import { Badge } from "@/components/ui/badge";
import { SettingsSection } from "./section";

export function AccountSection({ passwordEnabled }: { passwordEnabled: boolean }) {
  return (
    <SettingsSection
      id="account"
      icon={passwordEnabled ? ShieldCheck : LockOpen}
      title="Account"
      aside={passwordEnabled ? <Badge tone="green">Password protected</Badge> : <Badge tone="amber">Open</Badge>}
    >
      {passwordEnabled ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted">
            FlipWatch asks for <code className="rounded bg-surface-2 px-1">APP_PASSWORD</code> once per browser; sessions last 30 days. They&apos;re
            signed with <code className="rounded bg-surface-2 px-1">SESSION_SECRET</code>, or a random key kept in the database when that&apos;s
            unset.
          </p>
          <form action={logoutAction}>
            <SubmitButton variant="secondary" icon={<LogOut className="size-4" />}>
              Log out
            </SubmitButton>
          </form>
        </div>
      ) : (
        <p className="text-sm text-muted">
          Password protection is off, so anyone who can reach this server can use FlipWatch. Set{" "}
          <code className="rounded bg-surface-2 px-1">APP_PASSWORD</code> and restart to require a password.{" "}
          <code className="rounded bg-surface-2 px-1">SESSION_SECRET</code> is optional: without it, FlipWatch generates a random session
          key and keeps it in the database.
        </p>
      )}
    </SettingsSection>
  );
}
