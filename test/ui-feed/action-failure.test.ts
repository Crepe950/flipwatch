import { redirect } from "next/navigation";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  catchActionFailure,
  describeActionError,
  diagnoseFailure,
  failureFor,
  SESSION_PROBE_URL,
  signInHref,
  type ActionFailure,
} from "@/components/ui/action-failure";

const fetchReturning = (status: number) => vi.fn(async () => new Response("{}", { status })) as unknown as typeof fetch;
const fetchThrowing = vi.fn(async () => {
  throw new TypeError("Failed to fetch");
}) as unknown as typeof fetch;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("why an action failed without an answer", () => {
  it("probes the gated API: 401 means the session expired", async () => {
    const probe = fetchReturning(401);
    await expect(diagnoseFailure(probe)).resolves.toBe("session");
    expect(probe).toHaveBeenCalledWith(SESSION_PROBE_URL, { cache: "no-store" });
    await expect(diagnoseFailure(fetchReturning(200))).resolves.toBe("server");
    await expect(diagnoseFailure(fetchReturning(503))).resolves.toBe("server");
  });

  it("is offline when the probe can't connect or the browser says so", async () => {
    await expect(diagnoseFailure(fetchThrowing)).resolves.toBe("offline");
    vi.stubGlobal("navigator", { onLine: false });
    const probe = fetchReturning(200);
    await expect(diagnoseFailure(probe)).resolves.toBe("offline");
    expect(probe).not.toHaveBeenCalled();
  });

  it("words each case, with a way back in when signed out", () => {
    expect(failureFor("session", "Couldn't dismiss the deal", "/?search=2")).toEqual({
      message: "Couldn't dismiss the deal: your session expired. Sign in again to continue.",
      signInHref: "/login?next=%2F%3Fsearch%3D2",
    });
    expect(failureFor("offline", "Couldn't dismiss the deal", "/").message).toMatch(/you're offline/);
    expect(failureFor("server", "Couldn't dismiss the deal", "/")).toEqual({ message: "Couldn't dismiss the deal. Try again in a moment." });
    expect(signInHref("/")).toBe("/login");
  });

  it("lets Next.js redirects through (an action that redirects rejects with one)", async () => {
    let redirectError: unknown;
    try {
      redirect("/pipeline");
    } catch (error) {
      redirectError = error;
    }
    await expect(describeActionError(redirectError, "Couldn't delete the deal", fetchReturning(200))).rejects.toBe(redirectError);
    await expect(describeActionError(new TypeError("Failed to fetch"), "Couldn't delete the deal", fetchReturning(401))).resolves.toMatchObject({
      signInHref: "/login",
    });
  });
});

describe("catchActionFailure (useActionState forms)", () => {
  type FormState = { saved?: boolean; failure?: ActionFailure };
  const wrap = (action: (state: FormState, payload: unknown) => Promise<FormState>) =>
    catchActionFailure(action, "Couldn't save the search", (failure): FormState => ({ failure }));
  const noAnswer = wrap(async () => {
    throw new TypeError("Failed to fetch");
  });

  it("turns a request that got no answer into state that says why, instead of an error for the error boundary", async () => {
    vi.stubGlobal("fetch", fetchThrowing);
    await expect(noAnswer({}, {})).resolves.toEqual({
      failure: { message: "Couldn't save the search: you're offline. Check your connection and try again." },
    });
    vi.stubGlobal("fetch", fetchReturning(401));
    await expect(noAnswer({}, {})).resolves.toEqual({
      failure: { message: "Couldn't save the search: your session expired. Sign in again to continue.", signInHref: "/login" },
    });
  });

  it("passes answers and redirects through", async () => {
    await expect(wrap(async () => ({ saved: true }))({}, {})).resolves.toEqual({ saved: true });
    let redirectError: unknown;
    try {
      redirect("/searches");
    } catch (error) {
      redirectError = error;
    }
    const redirecting = wrap(async () => {
      throw redirectError;
    });
    await expect(redirecting({}, {})).rejects.toBe(redirectError);
  });
});
