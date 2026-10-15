import type { AreaValue } from "@/components/setup/area-picker";
import type { Db } from "@/lib/db";
import { DEFAULT_LOCATION_KEY, getDefaultLocation, getSetting } from "@/lib/queries/settings";

/** The saved default area as the picker's starting value, or null when the user never chose one. */
export async function loadArea(db: Db): Promise<AreaValue | null> {
  if ((await getSetting(db, DEFAULT_LOCATION_KEY)) == null) return null;
  const location = await getDefaultLocation(db);
  return {
    label: location.label,
    lat: location.lat,
    lng: location.lng,
    countryCode: location.countryCode.toUpperCase() === "US" ? "US" : "CA",
    postalCode: location.postalCode ?? null,
    radiusKm: location.radiusKm,
  };
}
