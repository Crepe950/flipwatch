import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Check an `Authorization: Bearer <secret>` header against CRON_SECRET in constant time.
 * Always false when no secret is configured, so the endpoint is closed by default.
 */
export function isAuthorizedCronRequest(authorization: string | null | undefined, secret: string | null | undefined): boolean {
  if (!secret) return false;
  const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(authorization ?? "");
  if (!match) return false;
  // Hash both sides so lengths match and the comparison leaks nothing about the secret's length.
  const given = createHash("sha256").update(match[1]).digest();
  const expected = createHash("sha256").update(secret).digest();
  return timingSafeEqual(given, expected);
}
