import { describe, expect, it } from "vitest";
import { locationToFormValues } from "@/components/searches/form-values";
import { craigslistSiteMismatch, hasHints, withoutHints, type CraigslistSiteOption } from "@/components/searches/location-hints";
import { findPreset } from "@/lib/locations";
import { CRAIGSLIST_SITES, MAX_SITE_DISTANCE_KM } from "@/lib/marketplaces/craigslist/sites";

const sites: CraigslistSiteOption[] = CRAIGSLIST_SITES.map(({ site, label, countryCode, lat, lng }) => ({ site, label, countryCode, lat, lng }));
const vancouver = locationToFormValues(findPreset("Vancouver, BC")!);
const kelowna = { ...withoutHints(vancouver), label: "Kelowna, BC", lat: "49.888", lng: "-119.496" };

describe("custom location marketplace hints", () => {
  it("starting a custom location from a preset keeps where it is but none of the preset city's hints", () => {
    expect(hasHints(vancouver)).toBe(true);
    const custom = withoutHints(vancouver);
    expect(custom).toEqual({
      label: "Vancouver, BC",
      lat: "49.2827",
      lng: "-123.1207",
      countryCode: "CA",
      postalCode: "",
      craigslistSite: "",
      facebookLocation: "",
      kijijiLocationId: "",
      kijijiLocationSlug: "",
    });
    expect(hasHints(custom)).toBe(false);
  });

  it("warns when the Craigslist site is far from the coordinates and suggests the engine's pick", () => {
    const mismatch = craigslistSiteMismatch({ ...kelowna, craigslistSite: "Vancouver" }, sites, MAX_SITE_DISTANCE_KM);
    expect(mismatch).toMatchObject({ site: { site: "vancouver" }, nearest: { site: "kelowna" } });
    expect(mismatch!.distanceKm).toBeGreaterThan(250);
  });

  it("stays quiet for a nearby, unknown or blank site and for unusable coordinates", () => {
    expect(craigslistSiteMismatch({ ...kelowna, craigslistSite: "kelowna" }, sites, MAX_SITE_DISTANCE_KM)).toBeNull();
    expect(craigslistSiteMismatch({ ...kelowna, craigslistSite: "somewhereelse" }, sites, MAX_SITE_DISTANCE_KM)).toBeNull();
    expect(craigslistSiteMismatch(kelowna, sites, MAX_SITE_DISTANCE_KM)).toBeNull();
    expect(craigslistSiteMismatch({ ...kelowna, lat: "abc", craigslistSite: "vancouver" }, sites, MAX_SITE_DISTANCE_KM)).toBeNull();
  });

  it("measures a sprawling site to its nearest point and only suggests sites in the location's country", () => {
    const multi: CraigslistSiteOption[] = [
      { site: "maine", label: "Portland, ME", countryCode: "US", lat: 43.6591, lng: -70.2568 },
      { site: "maine", label: "Bangor, ME", countryCode: "US", lat: 44.8016, lng: -68.7712 },
      { site: "newbrunswick", label: "New Brunswick", countryCode: "CA", lat: 45.9636, lng: -66.6431 },
    ];
    const bangor = { ...kelowna, label: "Bangor, ME", countryCode: "US", lat: "44.80", lng: "-68.77" };
    expect(craigslistSiteMismatch({ ...bangor, craigslistSite: "maine" }, multi, MAX_SITE_DISTANCE_KM)).toBeNull();
    const far = craigslistSiteMismatch({ ...bangor, lat: "45.96", lng: "-66.64", craigslistSite: "maine" }, multi, MAX_SITE_DISTANCE_KM);
    // New Brunswick is next door but in Canada; the search is in the US.
    expect(far).toMatchObject({ site: { label: "Portland, ME" }, nearest: null });
  });
});
