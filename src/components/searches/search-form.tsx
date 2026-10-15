"use client";

import Link from "next/link";
import { startTransition, useActionState, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Bot, CircleAlert, FlaskConical, Info, LoaderCircle, TriangleAlert } from "lucide-react";
import { previewSearchAction, saveSearchAction, type PreviewState, type SaveSearchState } from "@/app/searches/actions";
import { ActionError } from "@/components/ui/action-error";
import { catchActionFailure } from "@/components/ui/action-failure";
import { Badge } from "@/components/ui/badge";
import { Button, buttonClasses } from "@/components/ui/button";
import { Card, CardContent, CardTitle } from "@/components/ui/card";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/field";
import { cn } from "@/lib/cn";
import { ebayQuotaFloorSec } from "@/lib/engine/ebay-quota";
import { currencyForCountry, findPreset } from "@/lib/locations";
import { CATEGORIES, CATEGORY_LABELS, type NotificationChannelType } from "@/lib/types";
import { ChipInput } from "./chip-input";
import { describeInterval } from "./describe";
import { CUSTOM_LOCATION, POLL_INTERVALS, effectivePollInterval, type SearchFormValues } from "./form-values";
import { LocationFields, type CraigslistSiteHints, type LocationFieldsValue } from "./location-fields";
import { MarketplacePicker, type MarketplaceOption } from "./marketplace-picker";
import { PreviewPanel } from "./preview-panel";
import { Switch } from "./switch";

export interface ChannelOption {
  id: number;
  name: string;
  type: NotificationChannelType;
  enabled: boolean;
}

export interface SearchFormProps {
  searchId: number | null;
  initialValues: SearchFormValues;
  marketplaces: MarketplaceOption[];
  channels: ChannelOption[];
  ai: { configured: boolean; model: string; message?: string };
  minPollIntervalSec: number;
  /** Enabled searches besides this one that poll eBay, sharing its daily quota; null when eBay isn't set up. */
  ebayOtherSearches: number | null;
  craigslist: CraigslistSiteHints;
}

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <Card>
      <div className="border-b border-border px-4 py-3">
        <CardTitle>{title}</CardTitle>
        {description ? <p className="mt-0.5 text-sm text-muted">{description}</p> : null}
      </div>
      <CardContent className="space-y-4 py-4">{children}</CardContent>
    </Card>
  );
}

function MoneyInput({
  id,
  value,
  onChange,
  currency,
  invalid,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  currency: string;
  invalid?: boolean;
}) {
  return (
    <div className="relative">
      <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-muted">$</span>
      <Input
        id={id}
        inputMode="decimal"
        autoComplete="off"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={invalid || undefined}
        className={cn("pr-12 pl-7 tabular-nums", invalid && "border-danger")}
      />
      <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted">{currency}</span>
    </div>
  );
}

const INITIAL_SAVE: SaveSearchState = {};
const INITIAL_PREVIEW: PreviewState = { status: "idle" };

// When the request itself fails (offline, session expired), say why and keep the form as typed.
const saveSearch = catchActionFailure(saveSearchAction, "Couldn't save the search", (failure): SaveSearchState => ({ failure }));
const previewSearch = catchActionFailure(previewSearchAction, "Couldn't run the test", (failure): PreviewState => ({ status: "failed", failure }));

/** The AI module's status message plus how to enable it (unless the message already says). */
function aiHint(message: string | undefined): string {
  const setup = "Choose an AI engine in Settings → AI engine to enable deal analysis.";
  const trimmed = message?.trim();
  if (!trimmed) return setup;
  const sentence = /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
  return trimmed.includes("Settings") ? sentence : `${sentence} ${setup}`;
}

/** The saved-search editor used by /searches/new and /searches/[id]/edit. */
export function SearchForm({
  searchId,
  initialValues,
  marketplaces,
  channels,
  ai,
  minPollIntervalSec,
  ebayOtherSearches,
  craigslist,
}: SearchFormProps) {
  const [values, setValues] = useState(initialValues);
  const [saveState, saveDispatch, saving] = useActionState(saveSearch, INITIAL_SAVE);
  const [previewState, previewDispatch, previewing] = useActionState(previewSearch, INITIAL_PREVIEW);
  // Fields edited since the last failed save hide their (now stale) error.
  const [edited, setEdited] = useState<{ state: SaveSearchState; keys: string[] }>({ state: INITIAL_SAVE, keys: [] });
  const previewRef = useRef<HTMLDivElement>(null);

  const error = (key: string): string | undefined => {
    const message = saveState.errors?.[key];
    if (!message) return undefined;
    return edited.state === saveState && edited.keys.includes(key) ? undefined : message;
  };

  const invalid = (key: string): true | undefined => (error(key) ? true : undefined);

  const markEdited = (keys: string[]) => setEdited((prev) => ({ state: saveState, keys: prev.state === saveState ? [...prev.keys, ...keys] : keys }));

  const update = <K extends keyof SearchFormValues>(key: K, value: SearchFormValues[K]) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    markEdited([key]);
  };

  const updateLocation = (patch: Partial<LocationFieldsValue>, keys: string[]) => {
    setValues((prev) => ({ ...prev, ...patch }));
    markEdited(keys);
  };

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    // Dispatching manually (instead of <form action>) keeps React from resetting the form afterwards.
    e.preventDefault();
    startTransition(() => saveDispatch({ searchId, values }));
  };

  const onTest = () => {
    startTransition(() => previewDispatch(values));
    requestAnimationFrame(() => previewRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };

  const countryCode =
    values.locationPreset === CUSTOM_LOCATION ? values.location.countryCode : (findPreset(values.locationPreset)?.countryCode ?? "");
  const currency = currencyForCountry(countryCode || "US");
  const allowedIntervals = POLL_INTERVALS.filter((o) => o.value >= minPollIntervalSec);
  // Keep a stored value that isn't one of the presets (e.g. set through the API) selectable.
  const pollOptions = allowedIntervals.some((o) => String(o.value) === values.pollIntervalSec)
    ? allowedIntervals
    : [{ value: Number(values.pollIntervalSec), label: `Every ${values.pollIntervalSec} seconds` }, ...allowedIntervals];
  // With eBay, this search shares eBay's daily quota with the other enabled eBay searches (counted
  // even while it's paused, like its card: that is the interval it runs at once switched on).
  const ebaySearches = ebayOtherSearches !== null && values.marketplaces.includes("ebay") ? ebayOtherSearches + 1 : 0;
  const interval = effectivePollInterval(
    Number(values.pollIntervalSec),
    marketplaces.filter((m) => values.marketplaces.includes(m.id)),
    minPollIntervalSec,
    ebaySearches ? { floorSec: ebayQuotaFloorSec(ebaySearches), searches: ebaySearches } : undefined,
  );
  const intervalNote = interval.ebayQuotaSearches
    ? `Runs ${describeInterval(interval.seconds)}: eBay's daily API quota is shared by ${interval.ebayQuotaSearches} searches.`
    : interval.limitedBy.length
      ? `Runs ${describeInterval(interval.seconds)}: ${new Intl.ListFormat("en").format(interval.limitedBy)} ${interval.limitedBy.length === 1 ? "needs" : "need"} at least that long between checks.`
      : null;
  const shortInterval = interval.seconds < 120;
  const channelIds = new Set(channels.map((c) => c.id));
  const selectedChannels = values.notifyChannelIds.filter((id) => channelIds.has(id));
  const errorCount = Object.keys(saveState.errors ?? {}).filter((k) => error(k)).length;
  const marketplaceCount = values.marketplaces.length;

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      {saveState.message && !saveState.errors ? (
        <p role="alert" className="flex items-start gap-2 rounded-xl bg-danger-soft px-4 py-3 text-sm text-danger">
          <CircleAlert className="mt-0.5 size-4 shrink-0" />
          {saveState.message}
        </p>
      ) : null}

      <Section title="What to look for">
        <Field label="Name" htmlFor="name" error={error("name")}>
          <Input
            id="name"
            aria-invalid={invalid("name")}
            className="aria-invalid:border-danger"
            value={values.name}
            maxLength={80}
            placeholder="PS5 deals"
            onChange={(e) => update("name", e.target.value)}
          />
        </Field>
        <Field
          label="Search for"
          htmlFor="query"
          error={error("query")}
          hint={
            <>
              Sent to every marketplace. Use <code className="rounded bg-surface-2 px-1">-word</code> to exclude a word and{" "}
              <code className="rounded bg-surface-2 px-1">&quot;quotes&quot;</code> for exact phrases.
            </>
          }
        >
          <Input
            id="query"
            aria-invalid={invalid("query")}
            className="aria-invalid:border-danger"
            value={values.query}
            maxLength={200}
            placeholder='ps5 -broken "disc edition"'
            onChange={(e) => update("query", e.target.value)}
          />
        </Field>
        <Field
          label="Exclude listings mentioning"
          htmlFor="exclude"
          error={error("excludeTerms")}
          hint="Press Enter or comma to add. Matched as whole words against title and description; start a term with title: (e.g. title:pc) to check the title only."
        >
          <ChipInput
            id="exclude"
            value={values.excludeTerms}
            onChange={(next) => update("excludeTerms", next)}
            placeholder="broken, for parts, box only"
            invalid={Boolean(error("excludeTerms"))}
          />
        </Field>
        <Checkbox
          label="Title must contain every search word (filters out loose marketplace matches)"
          checked={values.titleMustMatch}
          onChange={(e) => update("titleMustMatch", e.target.checked)}
        />
      </Section>

      <Section title="Price" description={`In ${currency}. Leave blank for no limit; 0 means free.`}>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Min price" htmlFor="minPrice" error={error("minPrice")}>
            <MoneyInput
              id="minPrice"
              value={values.minPrice}
              onChange={(v) => update("minPrice", v)}
              currency={currency}
              invalid={Boolean(error("minPrice"))}
            />
          </Field>
          <Field label="Max price" htmlFor="maxPrice" error={error("maxPrice")}>
            <MoneyInput
              id="maxPrice"
              value={values.maxPrice}
              onChange={(v) => update("maxPrice", v)}
              currency={currency}
              invalid={Boolean(error("maxPrice"))}
            />
          </Field>
          <Field label="Expected resale" htmlFor="expectedResale" error={error("expectedResale")} hint="Enables profit estimates">
            <MoneyInput
              id="expectedResale"
              value={values.expectedResale}
              onChange={(v) => update("expectedResale", v)}
              currency={currency}
              invalid={Boolean(error("expectedResale"))}
            />
          </Field>
        </div>
      </Section>

      <Section title="Where">
        <LocationFields value={values} onChange={updateLocation} errors={error} craigslist={craigslist} />
      </Section>

      <Section title="Marketplaces" description="Each selected marketplace is polled separately; unavailable ones are skipped.">
        <MarketplacePicker
          options={marketplaces}
          selected={values.marketplaces}
          countryCode={countryCode}
          onChange={(next) => update("marketplaces", next)}
          invalid={Boolean(error("marketplaces"))}
        />
        {error("marketplaces") ? <p className="text-xs text-danger">{error("marketplaces")}</p> : null}
      </Section>

      <Section title="Schedule & filters">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Category" htmlFor="category" error={error("category")}>
            <Select id="category" value={values.category} onChange={(e) => update("category", e.target.value)}>
              <option value="">{CATEGORY_LABELS.any}</option>
              {CATEGORIES.filter((c) => c !== "any").map((c) => (
                <option key={c} value={c}>
                  {CATEGORY_LABELS[c]}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Check for new listings"
            htmlFor="pollIntervalSec"
            error={error("pollIntervalSec")}
            hint={
              intervalNote ? (
                <span className="inline-flex items-start gap-1">
                  <Info className="mt-px size-3.5 shrink-0" />
                  {intervalNote}
                </span>
              ) : shortInterval ? (
                <span className="inline-flex items-start gap-1 text-warn">
                  <TriangleAlert className="mt-px size-3.5 shrink-0" />
                  Very short intervals raise the risk of being rate-limited or blocked.
                </span>
              ) : (
                "Marketplaces also enforce their own minimum spacing."
              )
            }
          >
            <Select id="pollIntervalSec" value={values.pollIntervalSec} onChange={(e) => update("pollIntervalSec", e.target.value)}>
              {pollOptions.map((o) => (
                <option key={o.value} value={String(o.value)}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Max listing age"
            htmlFor="maxListingAgeHours"
            error={error("maxListingAgeHours")}
            hint="When catching up after a pause or downtime, older listings are saved without alerting."
          >
            <div className="relative">
              <Input
                id="maxListingAgeHours"
                aria-invalid={invalid("maxListingAgeHours")}
                type="number"
                inputMode="numeric"
                min={1}
                max={720}
                value={values.maxListingAgeHours}
                onChange={(e) => update("maxListingAgeHours", e.target.value)}
                className="pr-14 tabular-nums aria-invalid:border-danger"
              />
              <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-muted">hours</span>
            </div>
          </Field>
        </div>
      </Section>

      <Section title="Alerts">
        <div className="space-y-1.5">
          <p className="text-sm font-medium">Notify these channels</p>
          {channels.length === 0 ? (
            <p className="text-sm text-muted">
              No notification channels yet.{" "}
              <Link href="/settings#channels" className="font-medium text-accent hover:underline">
                Add one in Settings
              </Link>{" "}
              to get alerts on your phone.
            </p>
          ) : (
            <>
              <div className="flex flex-wrap gap-2" role="group" aria-label="Notification channels">
                {channels.map((channel) => {
                  const on = selectedChannels.includes(channel.id);
                  return (
                    <button
                      key={channel.id}
                      type="button"
                      aria-pressed={on}
                      onClick={() =>
                        update("notifyChannelIds", on ? selectedChannels.filter((id) => id !== channel.id) : [...selectedChannels, channel.id])
                      }
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition-colors",
                        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
                        on ? "border-accent bg-accent-soft text-accent" : "border-border bg-surface text-fg hover:bg-surface-2",
                      )}
                    >
                      {channel.name}
                      {!channel.enabled ? <Badge className="px-1 py-0">off</Badge> : null}
                    </button>
                  );
                })}
              </div>
              <p className="text-xs text-muted">
                {selectedChannels.length === 0
                  ? "None selected: every enabled channel is notified."
                  : `Only the ${selectedChannels.length} selected channel(s) are notified.`}
              </p>
            </>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Minimum deal score"
            htmlFor="notifyMinDealScore"
            error={error("notifyMinDealScore")}
            hint="0–100. Matches without a score yet still alert. Blank alerts on every match."
          >
            <Input
              id="notifyMinDealScore"
              aria-invalid={invalid("notifyMinDealScore")}
              type="number"
              inputMode="numeric"
              min={0}
              max={100}
              placeholder="Any"
              value={values.notifyMinDealScore}
              onChange={(e) => update("notifyMinDealScore", e.target.value)}
              className="tabular-nums aria-invalid:border-danger"
            />
          </Field>
          <Field
            label="Minimum AI score"
            htmlFor="notifyMinAiScore"
            error={error("notifyMinAiScore")}
            hint="0–100. Only alert once the AI has rated the listing at least this (turns on AI evaluation). Blank: no AI filter."
          >
            <Input
              id="notifyMinAiScore"
              aria-invalid={invalid("notifyMinAiScore")}
              type="number"
              inputMode="numeric"
              min={0}
              max={100}
              placeholder="Any"
              disabled={!ai.configured}
              value={values.notifyMinAiScore}
              onChange={(e) => update("notifyMinAiScore", e.target.value)}
              className="tabular-nums aria-invalid:border-danger"
            />
          </Field>
        </div>

        <Field
          label="Minimum checked profit (%)"
          htmlFor="notifyMinProfitPct"
          error={error("notifyMinProfitPct")}
          hint="Matches that pass the filters above get a market price check against live listings (a few per hour); only alert when it shows at least this profit, as a % of the asking price. Blank: no price check."
        >
          <Input
            id="notifyMinProfitPct"
            aria-invalid={invalid("notifyMinProfitPct")}
            type="number"
            inputMode="numeric"
            min={1}
            max={300}
            placeholder="Off"
            disabled={!ai.configured}
            value={values.notifyMinProfitPct}
            onChange={(e) => update("notifyMinProfitPct", e.target.value)}
            className="max-w-40 tabular-nums aria-invalid:border-danger"
          />
        </Field>

        <Field
          label="AI buyer notes"
          htmlFor="aiInstructions"
          error={error("aiInstructions")}
          hint="Your buying strategy for this search, given to the AI with every evaluation — e.g. “I part PCs out: value them by their parts.”"
        >
          <Textarea
            id="aiInstructions"
            aria-invalid={invalid("aiInstructions")}
            maxLength={1000}
            rows={3}
            disabled={!ai.configured}
            value={values.aiInstructions}
            onChange={(e) => update("aiInstructions", e.target.value)}
            className="aria-invalid:border-danger"
          />
        </Field>

        <div className="space-y-3">
          <Checkbox label="Alert on price drops" checked={values.notifyPriceDrops} onChange={(e) => update("notifyPriceDrops", e.target.checked)} />
          <div>
            <Checkbox
              label={
                <span className="inline-flex items-center gap-1.5">
                  <Bot className="size-4 text-muted" />
                  AI-evaluate new matches{ai.configured && ai.model ? ` (${ai.model})` : ""}
                </span>
              }
              checked={values.aiEvaluate}
              disabled={!ai.configured}
              onChange={(e) => update("aiEvaluate", e.target.checked)}
            />
            {!ai.configured ? (
              <p className="mt-1 ml-6 flex items-start gap-1 text-xs text-muted">
                <Info className="mt-px size-3.5 shrink-0" />
                <span>{aiHint(ai.message)}</span>
              </p>
            ) : null}
          </div>
        </div>
      </Section>

      <div ref={previewRef} className="scroll-mt-4">
        <PreviewPanel state={previewState} pending={previewing} marketplaceCount={marketplaceCount} />
      </div>

      <div className="sticky bottom-[calc(4.25rem+env(safe-area-inset-bottom))] z-20 rounded-xl border border-border bg-surface/95 p-3 shadow-lg backdrop-blur md:bottom-4">
        {errorCount > 0 ? (
          <p role="alert" className="mb-2 flex items-center gap-1.5 text-sm text-danger">
            <CircleAlert className="size-4 shrink-0" />
            {saveState.message ?? "Please fix the highlighted fields."} ({errorCount})
          </p>
        ) : null}
        {saveState.failure && !saving ? <ActionError error={saveState.failure} className="mb-2 text-sm text-danger" /> : null}
        <div className="flex flex-wrap items-center gap-2">
          <label className="mr-auto inline-flex cursor-pointer items-center gap-2 text-sm font-medium">
            <Switch checked={values.enabled} onCheckedChange={(v) => update("enabled", v)} label="Search enabled" />
            <span className={values.enabled ? "text-fg" : "text-muted"}>{values.enabled ? "Active" : "Paused"}</span>
          </label>
          <Button
            variant="secondary"
            onClick={onTest}
            disabled={previewing || marketplaceCount === 0}
            title={marketplaceCount === 0 ? "Pick a marketplace first" : undefined}
          >
            {previewing ? <LoaderCircle className="size-4 animate-spin" /> : <FlaskConical className="size-4" />}
            {previewing ? (
              "Testing…"
            ) : (
              <>
                Test<span className="hidden sm:inline">search</span>
              </>
            )}
          </Button>
          <div className="hidden sm:block">
            <Link href="/searches" className={buttonClasses("ghost")}>
              Cancel
            </Link>
          </div>
          <Button type="submit" disabled={saving}>
            {saving ? <LoaderCircle className="size-4 animate-spin" /> : null}
            {saving ? "Saving…" : searchId ? "Save" : "Create"}
            {saving ? null : <span className="hidden sm:inline">{searchId ? "changes" : "search"}</span>}
          </Button>
        </div>
      </div>
    </form>
  );
}
