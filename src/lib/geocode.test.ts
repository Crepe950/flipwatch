import { afterEach, describe, expect, it, vi } from "vitest";
import { locationFromPlace, placeAt, resetGeocodeCache, searchPlaces, toPlace } from "./geocode";

afterEach(() => resetGeocodeCache());

const kelowna = {
  lat: "49.8879",
  lon: "-119.4960",
  name: "Kelowna",
  display_name: "Kelowna, Regional District of Central Okanagan, British Columbia, Canada",
  address: { city: "Kelowna", state: "British Columbia", "ISO3166-2-lvl4": "CA-BC", country_code: "ca", postcode: "V1Y" },
};

describe("area picker places", () => {
  it("names places 'Town, Region' and keeps only Canada and the US", () => {
    expect(toPlace(kelowna)).toEqual({
      label: "Kelowna, BC",
      detail: kelowna.display_name,
      lat: 49.8879,
      lng: -119.496,
      countryCode: "CA",
      postalCode: "V1Y",
    });
    expect(toPlace({ lat: "51.5", lon: "-0.12", address: { city: "London", country_code: "gb" } })).toBeNull();
    expect(toPlace({ lat: "47.6", lon: "-122.3", address: { city: "Seattle", "ISO3166-2-lvl4": "US-WA", country_code: "us" } })?.label).toBe("Seattle, WA");
  });

  it("turns a place into a search location with the nearest Craigslist site", () => {
    const place = toPlace(kelowna)!;
    expect(locationFromPlace(place, 35.4)).toEqual({
      label: "Kelowna, BC",
      lat: 49.8879,
      lng: -119.496,
      radiusKm: 35,
      countryCode: "CA",
      postalCode: "V1Y",
      craigslistSite: "kelowna",
    });
    // Far from any Craigslist site: no site, the other marketplaces still search by coordinates.
    expect(locationFromPlace({ label: "Nowhere, NU", lat: 70, lng: -100, countryCode: "CA", postalCode: null }, 50).craigslistSite).toBeNull();
  });

  it("searches politely: identifies itself, limits to CA/US, caches repeat searches", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify([kelowna, kelowna]))) as unknown as typeof fetch;
    const places = await searchPlaces("  Kelowna ", fetchImpl);
    expect(places.map((p) => p.label)).toEqual(["Kelowna, BC"]);
    await searchPlaces("kelowna", fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    expect(url).toContain("countrycodes=ca%2Cus");
    expect((init.headers as Record<string, string>)["User-Agent"]).toMatch(/^FlipWatch/);
    expect(await searchPlaces("k", fetchImpl)).toEqual([]);
  });

  it("names the spot the user clicked", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(kelowna))) as unknown as typeof fetch;
    expect((await placeAt(49.9, -119.5, fetchImpl))?.label).toBe("Kelowna, BC");
  });
});
