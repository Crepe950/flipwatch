"use client";

import { useState, useTransition } from "react";
import { CircleCheck, ExternalLink, KeyRound, LoaderCircle, TriangleAlert } from "lucide-react";
import { saveAiSettingsAction, testAiAction } from "@/app/setup/actions";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { AI_PROVIDERS, DEFAULT_MODELS, ENGINE_INFO, PROVIDER_LABELS, type AiProviderId } from "@/lib/ai/engines";
import type { PublicRuntimeSettings } from "@/lib/runtime-settings";
import { cn } from "@/lib/cn";

type Notice = { tone: "ok" | "error"; text: string } | null;

/** Pick the AI engine (API key or the user's own Claude Code / Codex), its model, and test it. */
export function AiEngineForm({ initial, onSaved }: { initial: PublicRuntimeSettings; onSaved?: () => void }) {
  const [settings, setSettings] = useState(initial);
  const [provider, setProvider] = useState<AiProviderId>(initial.aiProvider ?? "anthropic");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(initial.aiModels[initial.aiProvider ?? "anthropic"] ?? "");
  const [notice, setNotice] = useState<Notice>(null);
  const [saving, startSaving] = useTransition();
  const [testing, startTesting] = useTransition();

  const info = ENGINE_INFO[provider];
  const savedKey = provider === "anthropic" ? settings.anthropicKey : provider === "openai" ? settings.openaiKey : null;
  const active = settings.aiProvider === provider;

  function choose(next: AiProviderId) {
    setProvider(next);
    setApiKey("");
    setModel(settings.aiModels[next] ?? "");
    setNotice(null);
  }

  function save(thenTest: boolean) {
    setNotice(null);
    startSaving(async () => {
      const result = await saveAiSettingsAction({ provider, apiKey: apiKey || undefined, model });
      if (!result.ok || !result.settings) {
        setNotice({ tone: "error", text: result.error ?? "Couldn't save." });
        return;
      }
      setSettings(result.settings);
      setApiKey("");
      onSaved?.();
      if (!thenTest) {
        setNotice({ tone: "ok", text: "Saved." });
        return;
      }
      startTesting(async () => {
        const test = await testAiAction();
        setNotice({ tone: test.ok ? "ok" : "error", text: test.message });
      });
    });
  }

  return (
    <div className="space-y-4">
      <fieldset className="grid gap-2 sm:grid-cols-2">
        <legend className="sr-only">AI engine</legend>
        {AI_PROVIDERS.map((id) => (
          <label
            key={id}
            className={cn(
              "flex cursor-pointer flex-col gap-1 rounded-xl border p-3 text-sm transition-colors",
              provider === id ? "border-accent bg-accent-soft" : "border-border hover:bg-surface-2",
            )}
          >
            <span className="flex items-center gap-2 font-medium">
              <input type="radio" name="ai-engine" value={id} checked={provider === id} onChange={() => choose(id)} className="accent-[var(--color-accent)]" />
              {PROVIDER_LABELS[id]}
              {settings.aiProvider === id ? <span className="ml-auto rounded-full bg-accent px-2 py-0.5 text-xs text-accent-contrast">In use</span> : null}
            </span>
            <span className="text-muted">{ENGINE_INFO[id].summary}</span>
          </label>
        ))}
      </fieldset>

      {info.needsKey ? (
        <Field
          label="API key"
          htmlFor="ai-key"
          hint={
            <>
              {savedKey ? <>Saved key: <code className="font-mono">{savedKey}</code>. Paste a new one to replace it. </> : null}
              {info.keyHelp}{" "}
              {info.keyUrl ? (
                <a href={info.keyUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-accent underline">
                  Get a key <ExternalLink className="size-3" />
                </a>
              ) : null}
            </>
          }
        >
          <div className="relative">
            <KeyRound className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" />
            <Input
              id="ai-key"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={savedKey ? "•••••••• (saved)" : `${info.keyPrefix}…`}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className="pl-9 font-mono"
            />
          </div>
        </Field>
      ) : (
        <div className="rounded-xl border border-border bg-surface-2 p-3 text-sm">
          <p className="mb-1 font-medium">Set up once:</p>
          <ol className="list-decimal space-y-1 pl-5 text-muted">
            {info.setup?.map((step) => <li key={step}>{step}</li>)}
          </ol>
        </div>
      )}

      <Field label="Model (optional)" htmlFor="ai-model" hint={info.modelHint}>
        <Input
          id="ai-model"
          spellCheck={false}
          placeholder={DEFAULT_MODELS[provider] || "Codex default"}
          value={model}
          onChange={(e) => setModel(e.target.value)}
          className="font-mono"
        />
      </Field>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" onClick={() => save(true)} disabled={saving || testing}>
          {saving || testing ? <LoaderCircle className="size-4 animate-spin" /> : null}
          {saving ? "Saving…" : testing ? "Testing…" : active ? "Save & test" : "Use this engine & test"}
        </Button>
        <Button type="button" variant="secondary" onClick={() => save(false)} disabled={saving || testing}>
          Save only
        </Button>
      </div>

      {notice ? (
        <p role={notice.tone === "error" ? "alert" : "status"} className={cn("flex items-start gap-1.5 text-sm", notice.tone === "ok" ? "text-accent" : "text-danger")}>
          {notice.tone === "ok" ? <CircleCheck className="mt-0.5 size-4 shrink-0" /> : <TriangleAlert className="mt-0.5 size-4 shrink-0" />}
          {notice.text}
        </p>
      ) : null}
      <p className="text-xs text-muted">Keys are stored only in FlipWatch&apos;s database on this computer and are never shown again in full.</p>
    </div>
  );
}
