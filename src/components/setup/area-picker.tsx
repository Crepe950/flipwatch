"use client";

import { useState, useTransition, type FormEvent } from "react";
import { CircleCheck, LoaderCircle, MapPin, Search, TriangleAlert } from "lucide-react";
import { placeAtAction, saveAreaAction, searchPlacesAction } from "@/app/setup/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import type { Place } from "@/lib/geocode";
import { cn } from "@/lib/cn";
import { AreaMap } from "./area-map";

export interface AreaValue {
  label: string;
  lat: number;
  lng: number;
  countryCode: "CA" | "US";
  postalCode: string | null;
  radiusKm: number;
}

/**
 * Where FlipWatch searches by default: find a town (or click the map), then set the radius. Used by new
 * searches, Deal Hunts and price checks; each search can still have its own area.
 */
export function AreaPicker({ initial, onSaved }: { initial: AreaValue | null; onSaved?: () => void }) {
  const [area, setArea] = useState<AreaValue | null>(initial);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Place[] | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [searching, startSearch] = useTransition();
  const [saving, startSave] = useTransition();

  function search(e: FormEvent) {
    e.preventDefault();
    setNotice(null);
    startSearch(async () => {
      const found = await searchPlacesAction(query);
      if (found.error) setNotice({ tone: "error", text: found.error });
      setResults(found.places);
    });
  }

  function choose(place: Place) {
    setArea({ label: place.label, lat: place.lat, lng: place.lng, countryCode: place.countryCode, postalCode: place.postalCode, radiusKm: area?.radiusKm ?? 40 });
    setResults(null);
    setNotice(null);
  }

  function pickOnMap(lat: number, lng: number) {
    // Move right away; the town name follows when the lookup answers.
    setArea((a) => (a ? { ...a, lat, lng, label: "Selected spot" } : a));
    void placeAtAction(lat, lng).then(({ place }) => {
      setArea((a) => (a && a.lat === lat && a.lng === lng ? { ...a, label: place?.label ?? `${lat.toFixed(3)}, ${lng.toFixed(3)}`, countryCode: place?.countryCode ?? a.countryCode, postalCode: place?.postalCode ?? null } : a));
    });
  }

  function save() {
    if (!area) return;
    setNotice(null);
    startSave(async () => {
      const result = await saveAreaAction(area);
      if (!result.ok) return setNotice({ tone: "error", text: result.error ?? "Couldn't save." });
      setNotice({ tone: "ok", text: `Saved — FlipWatch searches within ${area.radiusKm} km of ${area.label}.` });
      onSaved?.();
    });
  }

  return (
    <div className="space-y-3">
      <form onSubmit={search} className="flex gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" />
          <Input
            aria-label="Find a town, city or postal code"
            placeholder="Town, city or postal code (Canada & US)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-9"
          />
        </div>
        <Button type="submit" variant="secondary" disabled={searching || query.trim().length < 2}>
          {searching ? <LoaderCircle className="size-4 animate-spin" /> : null}
          Find
        </Button>
      </form>

      {results ? (
        results.length ? (
          <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border">
            {results.map((p) => (
              <li key={p.detail}>
                <button type="button" onClick={() => choose(p)} className="flex w-full items-start gap-2 px-3 py-2 text-left text-sm hover:bg-surface-2">
                  <MapPin className="mt-0.5 size-4 shrink-0 text-accent" />
                  <span>
                    <span className="font-medium">{p.label}</span>
                    <span className="block text-xs text-muted">{p.detail}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">No places found in Canada or the US — try a nearby town or a postal code.</p>
        )
      ) : null}

      {area ? (
        <>
          <AreaMap lat={area.lat} lng={area.lng} radiusKm={area.radiusKm} onPick={pickOnMap} />
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="inline-flex items-center gap-1 font-medium">
              <MapPin className="size-4 text-accent" />
              {area.label}
            </span>
            <label className="flex flex-1 items-center gap-2">
              <span className="text-muted">Radius</span>
              <input
                type="range"
                min={5}
                max={250}
                step={5}
                value={area.radiusKm}
                onChange={(e) => setArea({ ...area, radiusKm: Number(e.target.value) })}
                className="flex-1 accent-[var(--color-accent)]"
                aria-label="Search radius in km"
              />
              <span className="w-16 text-right tabular-nums">{area.radiusKm} km</span>
            </label>
          </div>
          <p className="text-xs text-muted">Click the map to move the centre.</p>
          <Button type="button" onClick={save} disabled={saving}>
            {saving ? <LoaderCircle className="size-4 animate-spin" /> : null}
            Save area
          </Button>
        </>
      ) : (
        <p className="text-sm text-muted">Find your town to see it on the map.</p>
      )}

      {notice ? (
        <p role={notice.tone === "error" ? "alert" : "status"} className={cn("flex items-start gap-1.5 text-sm", notice.tone === "ok" ? "text-accent" : "text-danger")}>
          {notice.tone === "ok" ? <CircleCheck className="mt-0.5 size-4 shrink-0" /> : <TriangleAlert className="mt-0.5 size-4 shrink-0" />}
          {notice.text}
        </p>
      ) : null}
    </div>
  );
}
