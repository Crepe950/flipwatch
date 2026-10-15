"use client";

import { useState } from "react";
import { ChevronRight, TriangleAlert } from "lucide-react";
import { Field, Input, Select } from "@/components/ui/field";
import { LOCATION_PRESETS, findPreset } from "@/lib/locations";
import { CUSTOM_LOCATION, locationToFormValues, type LocationFormValues } from "./form-values";
import { craigslistSiteMismatch, hasHints, HINT_KEYS, withoutHints, type CraigslistSiteOption } from "./location-hints";

const COUNTRY_NAMES: Record<string, string> = { CA: "Canada", US: "United States" };
const PRESET_GROUPS = [...new Set(LOCATION_PRESETS.map((p) => p.countryCode))].map((code) => ({
  code,
  label: COUNTRY_NAMES[code] ?? code,
  presets: LOCATION_PRESETS.filter((p) => p.countryCode === code),
}));

export interface LocationFieldsValue {
  locationPreset: string;
  location: LocationFormValues;
  radiusKm: string;
}

const HINT_ERROR_KEYS = HINT_KEYS.map((key) => `location.${key}`);

/** Known Craigslist sites, to warn when the chosen site is far from the coordinates. */
export interface CraigslistSiteHints {
  sites: CraigslistSiteOption[];
  maxDistanceKm: number;
}

/** Location preset select (+ custom coordinates and marketplace hints) and search radius. */
export function LocationFields({
  value,
  onChange,
  errors,
  craigslist,
}: {
  value: LocationFieldsValue;
  onChange: (patch: Partial<LocationFieldsValue>, errorKeys: string[]) => void;
  errors: (key: string) => string | undefined;
  craigslist: CraigslistSiteHints;
}) {
  const isCustom = value.locationPreset === CUSTOM_LOCATION;
  // Hints typed in this editor are deliberate; ones that came with the location follow its coordinates.
  const [hintsEdited, setHintsEdited] = useState(false);
  const [hintsCleared, setHintsCleared] = useState(false);

  const setLocation = (key: keyof LocationFormValues, v: string) => {
    const next = { ...value.location, [key]: v };
    if ((key === "lat" || key === "lng") && !hintsEdited && hasHints(value.location)) {
      // Moving the point: the old postal code, Craigslist site and Kijiji/Facebook city would keep
      // polling the old place, so drop them (blank hints are derived from the coordinates).
      setHintsCleared(true);
      onChange({ location: withoutHints(next) }, [`location.${key}`, ...HINT_ERROR_KEYS]);
      return;
    }
    if ((HINT_KEYS as readonly string[]).includes(key)) setHintsEdited(true);
    onChange({ location: next }, [`location.${key}`]);
  };

  const onPresetChange = (next: string) => {
    setHintsEdited(false);
    setHintsCleared(false);
    if (next === CUSTOM_LOCATION) {
      // Start the custom location from whatever preset was selected so its label, coordinates and
      // country can be tweaked, but not the preset city's marketplace hints.
      const current = findPreset(value.locationPreset);
      onChange({ locationPreset: next, location: current ? withoutHints(locationToFormValues(current)) : value.location }, ["locationPreset"]);
    } else {
      onChange({ locationPreset: next }, ["locationPreset"]);
    }
  };

  const mismatch = isCustom ? craigslistSiteMismatch(value.location, craigslist.sites, craigslist.maxDistanceKm) : null;

  const radius = Number(value.radiusKm);
  const [advancedOpen, setAdvancedOpen] = useState(() =>
    Boolean(value.location.craigslistSite || value.location.facebookLocation || value.location.kijijiLocationId || value.location.kijijiLocationSlug),
  );
  const advancedError = ["craigslistSite", "facebookLocation", "kijijiLocationId", "kijijiLocationSlug"].some((k) => errors(`location.${k}`));

  return (
    <div className="space-y-4">
      <Field label="Location" htmlFor="location-preset" error={errors("locationPreset")}>
        <Select id="location-preset" value={value.locationPreset} onChange={(e) => onPresetChange(e.target.value)}>
          {PRESET_GROUPS.map((group) => (
            <optgroup key={group.code} label={group.label}>
              {group.presets.map((p) => (
                <option key={p.label} value={p.label}>
                  {p.label}
                </option>
              ))}
            </optgroup>
          ))}
          <option value={CUSTOM_LOCATION}>Custom location…</option>
        </Select>
      </Field>

      {isCustom ? (
        <div className="space-y-4 rounded-xl border border-border bg-bg/60 p-3 sm:p-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Label" htmlFor="loc-label" error={errors("location.label")} className="sm:col-span-2">
              <Input
                id="loc-label"
                aria-invalid={errors("location.label") ? true : undefined}
                className="aria-invalid:border-danger"
                value={value.location.label}
                maxLength={120}
                placeholder="Kelowna, BC"
                onChange={(e) => setLocation("label", e.target.value)}
              />
            </Field>
            <Field label="Latitude" htmlFor="loc-lat" error={errors("location.lat")}>
              <Input
                id="loc-lat"
                aria-invalid={errors("location.lat") ? true : undefined}
                className="aria-invalid:border-danger"
                inputMode="decimal"
                value={value.location.lat}
                placeholder="49.8880"
                onChange={(e) => setLocation("lat", e.target.value)}
              />
            </Field>
            <Field label="Longitude" htmlFor="loc-lng" error={errors("location.lng")}>
              <Input
                id="loc-lng"
                aria-invalid={errors("location.lng") ? true : undefined}
                className="aria-invalid:border-danger"
                inputMode="decimal"
                value={value.location.lng}
                placeholder="-119.4960"
                onChange={(e) => setLocation("lng", e.target.value)}
              />
            </Field>
            <Field label="Country code" htmlFor="loc-country" error={errors("location.countryCode")} hint="2 letters, e.g. CA or US">
              <Input
                id="loc-country"
                aria-invalid={errors("location.countryCode") ? true : undefined}
                className="aria-invalid:border-danger"
                value={value.location.countryCode}
                maxLength={2}
                autoCapitalize="characters"
                placeholder="CA"
                onChange={(e) => setLocation("countryCode", e.target.value.toUpperCase())}
              />
            </Field>
            <Field label="Postal / ZIP code" htmlFor="loc-postal" error={errors("location.postalCode")} hint="Optional; used by some marketplaces">
              <Input
                id="loc-postal"
                aria-invalid={errors("location.postalCode") ? true : undefined}
                className="aria-invalid:border-danger"
                value={value.location.postalCode}
                maxLength={12}
                onChange={(e) => setLocation("postalCode", e.target.value)}
              />
            </Field>
          </div>
          {hintsCleared ? (
            <p role="status" className="text-xs text-muted">
              The postal code and marketplace hints were cleared because they belonged to the previous coordinates.
            </p>
          ) : null}
          <details className="group" open={advancedOpen} onToggle={(e) => setAdvancedOpen(e.currentTarget.open)}>
            <summary className="flex cursor-pointer list-none items-center gap-1 text-sm font-medium text-muted hover:text-fg [&::-webkit-details-marker]:hidden">
              <ChevronRight className="size-4 transition-transform group-open:rotate-90" />
              Advanced marketplace hints
              {advancedError && !advancedOpen ? <span className="ml-1 text-xs font-normal text-danger">— needs attention</span> : null}
              {mismatch && !advancedError && !advancedOpen ? <span className="ml-1 text-xs font-normal text-warn">— check the Craigslist site</span> : null}
            </summary>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <Field
                label="Craigslist site"
                htmlFor="loc-cl"
                error={errors("location.craigslistSite")}
                hint={
                  mismatch ? (
                    <span className="inline-flex items-start gap-1 text-warn">
                      <TriangleAlert className="mt-px size-3.5 shrink-0" />
                      <span>
                        {mismatch.site.label} is {Math.round(mismatch.distanceKm)} km from these coordinates, so Craigslist results would come
                        from there.{" "}
                        {mismatch.nearest ? `Use ${mismatch.nearest.site} (${mismatch.nearest.label}) or leave` : "Leave"} it blank to use
                        the nearest site.
                      </span>
                    </span>
                  ) : (
                    "Subdomain, e.g. vancouver. Blank picks the site nearest the coordinates."
                  )
                }
              >
                <Input
                  id="loc-cl"
                  aria-invalid={errors("location.craigslistSite") ? true : undefined}
                  className="aria-invalid:border-danger"
                  value={value.location.craigslistSite}
                  placeholder="vancouver"
                  onChange={(e) => setLocation("craigslistSite", e.target.value)}
                />
              </Field>
              <Field label="Facebook location" htmlFor="loc-fb" error={errors("location.facebookLocation")} hint="City slug or numeric id">
                <Input
                  id="loc-fb"
                  aria-invalid={errors("location.facebookLocation") ? true : undefined}
                  className="aria-invalid:border-danger"
                  value={value.location.facebookLocation}
                  placeholder="vancouver"
                  onChange={(e) => setLocation("facebookLocation", e.target.value)}
                />
              </Field>
              <Field
                label="Kijiji location id"
                htmlFor="loc-kid"
                error={errors("location.kijijiLocationId")}
                hint="From kijiji.ca URLs (…/k0l1700287)"
              >
                <Input
                  id="loc-kid"
                  aria-invalid={errors("location.kijijiLocationId") ? true : undefined}
                  className="aria-invalid:border-danger"
                  inputMode="numeric"
                  value={value.location.kijijiLocationId}
                  placeholder="1700287"
                  onChange={(e) => setLocation("kijijiLocationId", e.target.value)}
                />
              </Field>
              <Field label="Kijiji location slug" htmlFor="loc-kslug" error={errors("location.kijijiLocationSlug")}>
                <Input
                  id="loc-kslug"
                  aria-invalid={errors("location.kijijiLocationSlug") ? true : undefined}
                  className="aria-invalid:border-danger"
                  value={value.location.kijijiLocationSlug}
                  placeholder="vancouver"
                  onChange={(e) => setLocation("kijijiLocationSlug", e.target.value)}
                />
              </Field>
            </div>
          </details>
        </div>
      ) : null}

      <Field label="Search radius" htmlFor="radius" error={errors("radiusKm")}>
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={1}
            max={250}
            step={1}
            value={Number.isFinite(radius) ? Math.min(Math.max(radius, 1), 250) : 40}
            onChange={(e) => onChange({ radiusKm: e.target.value }, ["radiusKm"])}
            className="h-2 flex-1 cursor-pointer accent-[var(--accent)]"
            aria-label="Search radius slider"
          />
          <div className="relative w-28 shrink-0">
            <Input
              id="radius"
              aria-invalid={errors("radiusKm") ? true : undefined}
              type="number"
              inputMode="numeric"
              min={1}
              max={500}
              value={value.radiusKm}
              onChange={(e) => onChange({ radiusKm: e.target.value }, ["radiusKm"])}
              className="pr-10 tabular-nums aria-invalid:border-danger"
            />
            <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-muted">km</span>
          </div>
        </div>
      </Field>
    </div>
  );
}
