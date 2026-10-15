"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, Check, MapPin, Sparkles, Store } from "lucide-react";
import { finishSetupAction } from "@/app/setup/actions";
import { Button, buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { PublicRuntimeSettings } from "@/lib/runtime-settings";
import { cn } from "@/lib/cn";
import { AiEngineForm } from "./ai-engine-form";
import { AreaPicker, type AreaValue } from "./area-picker";
import { FacebookConnect } from "./facebook-connect";

const STEPS = [
  { id: "ai", title: "AI engine", icon: Sparkles },
  { id: "area", title: "Your area", icon: MapPin },
  { id: "facebook", title: "Facebook (optional)", icon: Store },
] as const;

export function SetupWizard({ settings, area, aiReady }: { settings: PublicRuntimeSettings; area: AreaValue | null; aiReady: boolean }) {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [ai, setAi] = useState(aiReady);
  const [hasArea, setHasArea] = useState(Boolean(area));
  const [finishing, startFinish] = useTransition();
  const done = step >= STEPS.length;

  function finish() {
    startFinish(async () => {
      await finishSetupAction();
      setStep(STEPS.length);
      router.refresh();
    });
  }

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <div>
        <h1 className="text-2xl font-semibold">Welcome to FlipWatch</h1>
        <p className="mt-1 text-muted">
          FlipWatch watches Craigslist, Kijiji, eBay and (optionally) Facebook Marketplace for deals and uses AI to judge
          them. Everything runs on this computer. Three quick steps:
        </p>
      </div>

      <ol className="flex flex-wrap gap-2 text-sm">
        {STEPS.map((s, i) => (
          <li key={s.id}>
            <button
              type="button"
              onClick={() => setStep(i)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-3 py-1",
                i === step ? "border-accent bg-accent-soft text-fg" : "border-border text-muted hover:bg-surface-2",
              )}
            >
              {(i === 0 && ai) || (i === 1 && hasArea) ? <Check className="size-3.5 text-accent" /> : <s.icon className="size-3.5" />}
              {i + 1}. {s.title}
            </button>
          </li>
        ))}
      </ol>

      <Card className="p-4">
        {step === 0 ? (
          <div className="space-y-3">
            <h2 className="font-semibold">Choose the AI engine</h2>
            <p className="text-sm text-muted">
              The AI estimates what items resell for, scores deals and drafts messages to sellers. Use your own API key, or
              Claude Code / Codex if you already have them installed and signed in on this computer.
            </p>
            <AiEngineForm initial={settings} onSaved={() => setAi(true)} />
          </div>
        ) : step === 1 ? (
          <div className="space-y-3">
            <h2 className="font-semibold">Where do you buy?</h2>
            <p className="text-sm text-muted">New searches, Deal Hunts and price checks look within this area. Each search can still use its own.</p>
            <AreaPicker initial={area} onSaved={() => setHasArea(true)} />
          </div>
        ) : step === 2 ? (
          <div className="space-y-3">
            <h2 className="font-semibold">Facebook Marketplace (optional)</h2>
            <FacebookConnect initial={settings} />
            <p className="text-xs text-muted">You can skip this and turn it on later in Settings.</p>
          </div>
        ) : (
          <div className="space-y-3">
            <h2 className="flex items-center gap-2 font-semibold">
              <Check className="size-5 text-accent" /> You&apos;re set up
            </h2>
            <p className="text-sm text-muted">
              Create a search (e.g. “gaming pc”) and FlipWatch checks it every few minutes, or run a Deal Hunt to have the AI
              search and rank deals right now. Everything here can be changed later in Settings.
            </p>
            <div className="flex flex-wrap gap-2">
              <Link href="/searches/new" className={buttonClasses("primary")}>
                Create a search
              </Link>
              <Link href="/hunt" className={buttonClasses("secondary")}>
                Run a Deal Hunt
              </Link>
            </div>
          </div>
        )}
      </Card>

      {!done ? (
        <div className="flex items-center justify-between">
          <Button type="button" variant="ghost" onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0}>
            <ArrowLeft className="size-4" /> Back
          </Button>
          {step < STEPS.length - 1 ? (
            <Button type="button" onClick={() => setStep((s) => s + 1)}>
              {(step === 0 && !ai) || (step === 1 && !hasArea) ? "Skip for now" : "Next"} <ArrowRight className="size-4" />
            </Button>
          ) : (
            <Button type="button" onClick={finish} disabled={finishing}>
              Finish <Check className="size-4" />
            </Button>
          )}
        </div>
      ) : null}
    </div>
  );
}
