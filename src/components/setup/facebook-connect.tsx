"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { CircleCheck, LoaderCircle, LogIn, ShieldAlert, TriangleAlert, Unplug, UserPlus } from "lucide-react";
import {
  cancelFacebookConnectAction,
  disconnectFacebookAction,
  facebookConnectStatusAction,
  saveFacebookCookieAction,
  setFacebookEnabledAction,
  startFacebookConnectAction,
} from "@/app/setup/actions";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Textarea } from "@/components/ui/field";
import type { ConnectState } from "@/lib/marketplaces/facebook/connect";
import { MAX_FACEBOOK_ACCOUNTS, type PublicRuntimeSettings } from "@/lib/runtime-settings";
import { FacebookAccounts } from "./facebook-accounts";
import { cn } from "@/lib/cn";

export const FACEBOOK_RISK =
  "Facebook doesn't offer a Marketplace API. FlipWatch searches it the way your browser does, while logged in as you — " +
  "which is against Meta's Terms of Service. Facebook can limit or ban accounts that do this. FlipWatch keeps its " +
  "searches slow (a capped number per hour) to lower the risk, but it can't remove it. Consider using a secondary account.";

/** Opt-in, connect accounts (login window that saves the session), split searches between them, or paste a cookie (advanced). */
export function FacebookConnect({ initial }: { initial: PublicRuntimeSettings }) {
  const [settings, setSettings] = useState(initial);
  // Connecting an account required confirming the risk, so a connected-but-off Facebook can be turned back on.
  const [acknowledged, setAcknowledged] = useState(initial.facebookEnabled || initial.facebookConnected);
  const [status, setStatus] = useState<ConnectState>({ state: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [cookie, setCookie] = useState("");
  const [pending, start] = useTransition();
  const polling = useRef<ReturnType<typeof setInterval> | null>(null);

  const busy = status.state === "starting" || status.state === "waiting";
  const accounts = settings.facebookAccounts;
  const full = accounts.length >= MAX_FACEBOOK_ACCOUNTS;

  useEffect(() => {
    if (!busy) return;
    polling.current = setInterval(async () => {
      const next = await facebookConnectStatusAction().catch(() => null);
      if (!next) return;
      setStatus(next.status);
      setSettings(next.settings);
    }, 1_500);
    return () => {
      if (polling.current) clearInterval(polling.current);
    };
  }, [busy]);

  function toggle(enabled: boolean) {
    setError(null);
    start(async () => {
      const result = await setFacebookEnabledAction(enabled, acknowledged);
      if (!result.ok || !result.settings) return setError(result.error ?? "Couldn't save.");
      setSettings(result.settings);
    });
  }

  function connect() {
    setError(null);
    start(async () => setStatus(await startFacebookConnectAction()));
  }

  function disconnect() {
    setError(null);
    start(async () => {
      const result = await disconnectFacebookAction();
      if (result.settings) setSettings(result.settings);
      setStatus({ state: "idle" });
    });
  }

  function saveCookie() {
    setError(null);
    start(async () => {
      const result = await saveFacebookCookieAction(cookie);
      if (!result.ok || !result.settings) return setError(result.error ?? "Couldn't save.");
      setSettings(result.settings);
      setCookie("");
      setShowAdvanced(false);
    });
  }

  if (!settings.facebookEnabled && !settings.facebookConnected) {
    return (
      <div className="space-y-3 text-sm">
        <div className="flex gap-2 rounded-xl border border-warn/40 bg-warn-soft p-3">
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warn" />
          <p>{FACEBOOK_RISK}</p>
        </div>
        <Checkbox
          label="I understand the risk to my Facebook account and want to search Facebook Marketplace anyway."
          checked={acknowledged}
          onChange={(e) => setAcknowledged(e.target.checked)}
        />
        <Button type="button" onClick={() => toggle(true)} disabled={!acknowledged || pending}>
          {pending ? <LoaderCircle className="size-4 animate-spin" /> : null}
          Turn on Facebook Marketplace
        </Button>
        {error ? <p role="alert" className="text-danger">{error}</p> : null}
      </div>
    );
  }

  return (
    <div className="space-y-3 text-sm">
      {settings.facebookConnected && !settings.facebookEnabled ? (
        <p className="text-muted">Facebook is turned off: your accounts stay saved, but FlipWatch doesn&apos;t search Marketplace.</p>
      ) : null}
      {settings.facebookConnected ? (
        <>
          <p className="flex items-center gap-1.5 text-accent">
            <CircleCheck className="size-4" />
            {accounts.length === 1
              ? "Connected. Facebook searches use this account."
              : `${accounts.length} accounts connected. Facebook searches are split between them.`}
          </p>
          <FacebookAccounts
            key={accounts.map((a) => `${a.id}:${a.connectedAt}`).join("|")}
            accounts={accounts}
            disabled={busy}
            onSaved={setSettings}
          />
        </>
      ) : (
        <p className="text-muted">
          Log in to Facebook in a browser window FlipWatch opens. It saves the session cookie (never your password) on this
          computer only, then closes the window.
        </p>
      )}

      {status.state === "waiting" ? (
        <div className="flex items-start gap-2 rounded-xl border border-border bg-surface-2 p-3">
          <LoaderCircle className="mt-0.5 size-4 shrink-0 animate-spin text-accent" />
          <div className="space-y-2">
            <p>
              A {status.browser} window is open — log in to Facebook there (2-step codes work as usual). This page updates
              by itself once you&apos;re in.
            </p>
            <Button type="button" variant="ghost" size="sm" onClick={() => void cancelFacebookConnectAction()}>
              Cancel
            </Button>
          </div>
        </div>
      ) : status.state === "starting" ? (
        <p className="flex items-center gap-1.5 text-muted">
          <LoaderCircle className="size-4 animate-spin" /> Opening a browser window…
        </p>
      ) : status.state === "connected" ? (
        <p className="flex items-center gap-1.5 text-accent">
          <CircleCheck className="size-4" /> Logged in. The session is saved and the login window closed.
        </p>
      ) : status.state === "error" ? (
        <p role="alert" className="flex items-start gap-1.5 text-danger">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" /> {status.message}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={connect} disabled={pending || busy || full}>
          {settings.facebookConnected ? <UserPlus className="size-4" /> : <LogIn className="size-4" />}
          {settings.facebookConnected ? "Connect another account" : "Connect Facebook"}
        </Button>
        {accounts.length > 1 ? (
          <Button type="button" variant="secondary" onClick={disconnect} disabled={pending || busy}>
            <Unplug className="size-4" /> Disconnect all
          </Button>
        ) : null}
        {settings.facebookEnabled ? (
          <Button type="button" variant="ghost" onClick={() => toggle(false)} disabled={pending || busy}>
            Turn Facebook off
          </Button>
        ) : settings.facebookConnected ? (
          <Button type="button" variant="secondary" onClick={() => toggle(true)} disabled={pending || busy}>
            Turn Facebook back on
          </Button>
        ) : null}
      </div>

      {settings.facebookConnected ? (
        <p className="text-xs text-muted">
          {full
            ? `That's the most FlipWatch supports (${MAX_FACEBOOK_ACCOUNTS}). `
            : "Each login opens a fresh window, so you can sign in to a different account. "}
          If an account&apos;s session stops working, connect it again: logging in to an account that&apos;s already listed
          refreshes it and keeps its name and share.
        </p>
      ) : null}

      <button type="button" className={cn("text-xs text-muted underline")} onClick={() => setShowAdvanced((v) => !v)}>
        {showAdvanced ? "Hide advanced" : "Advanced: paste a Cookie header instead"}
      </button>
      {showAdvanced ? (
        <div className="space-y-2">
          <Field
            label="Cookie header"
            htmlFor="fb-cookie"
            hint="In a browser logged in to facebook.com: developer tools → Network → any facebook.com request → Request headers → cookie. It must include c_user and xs."
          >
            <Textarea id="fb-cookie" rows={3} spellCheck={false} value={cookie} onChange={(e) => setCookie(e.target.value)} className="font-mono text-xs" />
          </Field>
          <Button type="button" variant="secondary" onClick={saveCookie} disabled={pending || !cookie.trim() || full}>
            {settings.facebookConnected ? "Add account" : "Save cookie"}
          </Button>
        </div>
      ) : null}
      {error ? <p role="alert" className="text-danger">{error}</p> : null}
    </div>
  );
}
