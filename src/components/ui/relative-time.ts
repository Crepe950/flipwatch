/** "in 12m", "in 2h", "any moment now": a future time relative to now (the counterpart of timeAgo in lib/format). */
export function timeUntil(date: Date | string | number, now: Date = new Date()): string {
  const d = date instanceof Date ? date : new Date(date);
  const seconds = Math.round((d.getTime() - now.getTime()) / 1000);
  if (!Number.isFinite(seconds)) return "soon";
  if (seconds < 45) return "any moment now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}
