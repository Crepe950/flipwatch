"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  SESSION_COOKIE,
  checkPassword,
  createLoginThrottle,
  createSessionToken,
  loginRateLimitKey,
  safeNextPath,
  sessionCookieOptions,
  type RateLimiter,
} from "@/lib/auth";
import { config } from "@/lib/config";
import { sessionSecret } from "./session";

export interface LoginState {
  error?: string;
}

// One throttle per process, kept on globalThis so dev hot reloads don't reset it: 10 failures per
// client (see loginRateLimitKey / TRUST_PROXY) and 50 across all clients per 5 minutes.
const globalForLogin = globalThis as unknown as { __flipwatchLoginThrottle?: RateLimiter };
const limiter = (globalForLogin.__flipwatchLoginThrottle ??= createLoginThrottle({ perClient: 10, global: 50, windowMs: 5 * 60 * 1000 }));

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const next = safeNextPath(formData.get("next"));
  if (!config.appPassword) redirect(next);

  const headersList = await headers();
  const key = loginRateLimitKey((name) => headersList.get(name));
  const limit = limiter.check(key);
  if (!limit.allowed) {
    const minutes = Math.max(1, Math.ceil(limit.retryAfterMs / 60_000));
    return { error: `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.` };
  }

  // Count the attempt before the (async) password check, so a burst of parallel requests can't all
  // pass the check above; a correct password clears this client's count again.
  limiter.recordFailure(key);
  if (!(await checkPassword(formData.get("password")))) return { error: "Incorrect password." };

  limiter.reset(key);
  const cookieOptions = sessionCookieOptions({ forwardedProto: headersList.get("x-forwarded-proto") });
  (await cookies()).set(SESSION_COOKIE, await createSessionToken(Date.now(), await sessionSecret()), cookieOptions);
  redirect(next);
}

export async function logoutAction(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/login");
}
