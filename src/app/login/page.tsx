import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Radar } from "lucide-react";
import { buttonClasses } from "@/components/ui/button";
import { safeNextPath } from "@/lib/auth";
import { config } from "@/lib/config";
import { LoginForm } from "./login-form";
import { isAuthenticated } from "./session";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage(props: PageProps<"/login">) {
  const params = await props.searchParams;
  const next = safeNextPath(Array.isArray(params.next) ? params.next[0] : params.next);
  const passwordEnabled = Boolean(config.appPassword);
  if (passwordEnabled && (await isAuthenticated())) redirect(next);

  return (
    // Fixed overlay so the page centers regardless of the app shell's sidebar padding.
    <div className="fixed inset-0 z-40 grid place-items-center overflow-y-auto bg-bg px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center text-center">
          <span className="mb-3 grid size-11 place-items-center rounded-xl bg-accent text-accent-contrast">
            <Radar className="size-6" />
          </span>
          <h1 className="text-xl font-semibold tracking-tight">FlipWatch</h1>
          <p className="mt-1 text-sm text-muted">{passwordEnabled ? "Enter the app password to continue." : "Password protection is off."}</p>
        </div>
        <div className="rounded-xl border border-border bg-surface p-5 shadow-sm">
          {passwordEnabled ? (
            <LoginForm next={next} />
          ) : (
            <div className="space-y-4 text-sm">
              <p className="text-muted">
                Anyone who can reach this server can use FlipWatch. Set <code className="rounded bg-surface-2 px-1">APP_PASSWORD</code> to require a
                password.
              </p>
              <Link href={next} className={buttonClasses("primary", "md", "w-full")}>
                Continue
              </Link>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
