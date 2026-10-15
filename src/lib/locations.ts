import type { SearchLocation } from "./types";

/**
 * City presets so users don't have to know each marketplace's location ids.
 * Kijiji ids come from kijiji.ca URLs (…/k0l1700287 = Vancouver). Facebook accepts city slugs.
 */
export const LOCATION_PRESETS: SearchLocation[] = [
  // Canada
  { label: "Vancouver, BC", lat: 49.2827, lng: -123.1207, radiusKm: 40, countryCode: "CA", postalCode: "V6B 1A1", craigslistSite: "vancouver", facebookLocation: "vancouver", kijijiLocationId: "1700287", kijijiLocationSlug: "vancouver" },
  { label: "Victoria, BC", lat: 48.4284, lng: -123.3656, radiusKm: 30, countryCode: "CA", postalCode: "V8W 1A1", craigslistSite: "victoria", facebookLocation: "victoria", kijijiLocationId: "1700173", kijijiLocationSlug: "victoria-bc" },
  { label: "Calgary, AB", lat: 51.0447, lng: -114.0719, radiusKm: 40, countryCode: "CA", postalCode: "T2P 1J9", craigslistSite: "calgary", facebookLocation: "calgary", kijijiLocationId: "1700199", kijijiLocationSlug: "calgary" },
  { label: "Edmonton, AB", lat: 53.5461, lng: -113.4938, radiusKm: 40, countryCode: "CA", postalCode: "T5J 0N3", craigslistSite: "edmonton", facebookLocation: "edmonton", kijijiLocationId: "1700203", kijijiLocationSlug: "edmonton" },
  { label: "Toronto, ON", lat: 43.6532, lng: -79.3832, radiusKm: 40, countryCode: "CA", postalCode: "M5H 2N2", craigslistSite: "toronto", facebookLocation: "toronto", kijijiLocationId: "1700273", kijijiLocationSlug: "city-of-toronto" },
  { label: "Ottawa, ON", lat: 45.4215, lng: -75.6972, radiusKm: 40, countryCode: "CA", postalCode: "K1P 1J1", craigslistSite: "ottawa", facebookLocation: "ottawa", kijijiLocationId: "1700185", kijijiLocationSlug: "ottawa" },
  { label: "Montréal, QC", lat: 45.5019, lng: -73.5674, radiusKm: 40, countryCode: "CA", postalCode: "H2Y 1C6", craigslistSite: "montreal", facebookLocation: "montreal", kijijiLocationId: "1700281", kijijiLocationSlug: "ville-de-montreal" },
  // United States
  { label: "Seattle, WA", lat: 47.6062, lng: -122.3321, radiusKm: 40, countryCode: "US", postalCode: "98101", craigslistSite: "seattle", facebookLocation: "seattle" },
  { label: "Portland, OR", lat: 45.5152, lng: -122.6784, radiusKm: 40, countryCode: "US", postalCode: "97204", craigslistSite: "portland", facebookLocation: "portland" },
  { label: "San Francisco, CA", lat: 37.7749, lng: -122.4194, radiusKm: 40, countryCode: "US", postalCode: "94103", craigslistSite: "sfbay", facebookLocation: "sanfrancisco" },
  { label: "Los Angeles, CA", lat: 34.0522, lng: -118.2437, radiusKm: 50, countryCode: "US", postalCode: "90012", craigslistSite: "losangeles", facebookLocation: "la" },
  { label: "San Diego, CA", lat: 32.7157, lng: -117.1611, radiusKm: 40, countryCode: "US", postalCode: "92101", craigslistSite: "sandiego", facebookLocation: "sandiego" },
  { label: "Phoenix, AZ", lat: 33.4484, lng: -112.074, radiusKm: 50, countryCode: "US", postalCode: "85004", craigslistSite: "phoenix", facebookLocation: "phoenix" },
  { label: "Denver, CO", lat: 39.7392, lng: -104.9903, radiusKm: 40, countryCode: "US", postalCode: "80202", craigslistSite: "denver", facebookLocation: "denver" },
  { label: "Dallas, TX", lat: 32.7767, lng: -96.797, radiusKm: 50, countryCode: "US", postalCode: "75201", craigslistSite: "dallas", facebookLocation: "dallas" },
  { label: "Houston, TX", lat: 29.7604, lng: -95.3698, radiusKm: 50, countryCode: "US", postalCode: "77002", craigslistSite: "houston", facebookLocation: "houston" },
  { label: "Austin, TX", lat: 30.2672, lng: -97.7431, radiusKm: 40, countryCode: "US", postalCode: "78701", craigslistSite: "austin", facebookLocation: "austin" },
  { label: "Chicago, IL", lat: 41.8781, lng: -87.6298, radiusKm: 40, countryCode: "US", postalCode: "60602", craigslistSite: "chicago", facebookLocation: "chicago" },
  { label: "Atlanta, GA", lat: 33.749, lng: -84.388, radiusKm: 50, countryCode: "US", postalCode: "30303", craigslistSite: "atlanta", facebookLocation: "atlanta" },
  { label: "Miami, FL", lat: 25.7617, lng: -80.1918, radiusKm: 40, countryCode: "US", postalCode: "33130", craigslistSite: "miami", facebookLocation: "miami" },
  { label: "New York, NY", lat: 40.7128, lng: -74.006, radiusKm: 30, countryCode: "US", postalCode: "10007", craigslistSite: "newyork", facebookLocation: "nyc" },
  { label: "Boston, MA", lat: 42.3601, lng: -71.0589, radiusKm: 40, countryCode: "US", postalCode: "02108", craigslistSite: "boston", facebookLocation: "boston" },
];

export const DEFAULT_LOCATION: SearchLocation = LOCATION_PRESETS[0];

export function findPreset(label: string): SearchLocation | undefined {
  return LOCATION_PRESETS.find((p) => p.label === label);
}

/** The first option of area dropdowns: the user's own saved area (Settings → Your area). */
export const HOME_AREA_PREFIX = "My area: ";
export function homeAreaOption(label: string): string {
  return `${HOME_AREA_PREFIX}${label}`;
}

export function currencyForCountry(countryCode: string): string {
  return countryCode.toUpperCase() === "CA" ? "CAD" : "USD";
}
