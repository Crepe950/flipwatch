"use client";

import { useState, useTransition } from "react";
import { CircleCheck, ExternalLink, LoaderCircle, TriangleAlert } from "lucide-react";
import { clearEbayKeysAction, saveEbayKeysAction, testEbayAction } from "@/app/setup/actions";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import type { PublicRuntimeSettings } from "@/lib/runtime-settings";
import { cn } from "@/lib/cn";

type Notice = { tone: "ok" | "error"; text: string } | null;

/** eBay Browse API keys (free Production keyset from developer.ebay.com), with a test. */
export function EbayKeysForm({ initial }: { initial: PublicRuntimeSettings }) {
  const [settings, setSettings] = useState(initial);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [notice, setNotice] = useState<Notice>(null);
  const [pending, start] = useTransition();
  const saved = Boolean(settings.ebayClientId && settings.ebaySecret);

  function save() {
    setNotice(null);
    start(async () => {
      const result = await saveEbayKeysAction({ clientId: clientId || undefined, clientSecret: clientSecret || undefined });
      if (!result.ok || !result.settings) return setNotice({ tone: "error", text: result.error ?? "Couldn't save." });
      setSettings(result.settings);
      setClientId("");
      setClientSecret("");
      if (!result.settings.ebayClientId || !result.settings.ebaySecret) return setNotice({ tone: "ok", text: "Saved. Add the other key too." });
      const test = await testEbayAction();
      setNotice(test.ok ? { tone: "ok", text: test.message ?? "Working." } : { tone: "error", text: test.error ?? "Test failed." });
    });
  }

  function remove() {
    setNotice(null);
    start(async () => {
      const result = await clearEbayKeysAction();
      if (result.settings) setSettings(result.settings);
      setNotice({ tone: "ok", text: "Removed. eBay is off." });
    });
  }

  return (
    <div className="space-y-4 text-sm">
      {!saved ? (
        <ol className="list-decimal space-y-1 pl-5 text-muted">
          <li>
            Create a free account at{" "}
            <a href="https://developer.ebay.com/my/keys" target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-accent underline">
              developer.ebay.com <ExternalLink className="size-3" />
            </a>{" "}
            (eBay may take about a day to approve it).
          </li>
          <li>Under Application Keys, create a <span className="font-medium text-fg">Production</span> keyset (not Sandbox).</li>
          <li>Paste its App ID and Cert ID here. FlipWatch only reads public listings with them.</li>
        </ol>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="App ID (Client ID)" htmlFor="ebay-id" hint={settings.ebayClientId ? <>Saved: <code className="font-mono">{settings.ebayClientId}</code></> : undefined}>
          <Input id="ebay-id" spellCheck={false} autoComplete="off" placeholder={settings.ebayClientId ? "(saved)" : "YourName-FlipWatc-PRD-…"} value={clientId} onChange={(e) => setClientId(e.target.value)} className="font-mono" />
        </Field>
        <Field label="Cert ID (Client Secret)" htmlFor="ebay-secret" hint={settings.ebaySecret ? <>Saved: <code className="font-mono">{settings.ebaySecret}</code></> : undefined}>
          <Input id="ebay-secret" type="password" spellCheck={false} autoComplete="off" placeholder={settings.ebaySecret ? "•••••••• (saved)" : "PRD-…"} value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} className="font-mono" />
        </Field>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={save} disabled={pending || (!clientId && !clientSecret)}>
          {pending ? <LoaderCircle className="size-4 animate-spin" /> : null}
          Save &amp; test
        </Button>
        {saved ? (
          <>
            <Button type="button" variant="secondary" disabled={pending} onClick={() => start(async () => {
              const test = await testEbayAction();
              setNotice(test.ok ? { tone: "ok", text: test.message ?? "Working." } : { tone: "error", text: test.error ?? "Test failed." });
            })}>
              Test again
            </Button>
            <Button type="button" variant="ghost" disabled={pending} onClick={remove}>
              Remove keys
            </Button>
          </>
        ) : null}
      </div>
      {notice ? (
        <p role={notice.tone === "error" ? "alert" : "status"} className={cn("flex items-start gap-1.5", notice.tone === "ok" ? "text-accent" : "text-danger")}>
          {notice.tone === "ok" ? <CircleCheck className="mt-0.5 size-4 shrink-0" /> : <TriangleAlert className="mt-0.5 size-4 shrink-0" />}
          {notice.text}
        </p>
      ) : null}
      <p className="text-xs text-muted">eBay&apos;s free quota is 5,000 searches a day, shared by all your eBay searches. The Cert ID is stored only on this computer.</p>
    </div>
  );
}
