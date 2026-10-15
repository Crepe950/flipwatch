/**
 * How recently a listing showed up in its marketplace's search results. Marketplaces rarely say
 * when a listing sells, so one that stops appearing has probably sold or been taken down.
 */
export const NOT_SEEN_RECENTLY_MS = 24 * 60 * 60 * 1000;

export function notSeenRecently(lastSeenAt: Date | string, now: Date | number): boolean {
  const seen = new Date(lastSeenAt).getTime();
  const at = typeof now === "number" ? now : now.getTime();
  return Number.isFinite(seen) && at - seen > NOT_SEEN_RECENTLY_MS;
}
