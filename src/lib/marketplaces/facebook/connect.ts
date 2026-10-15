/**
 * "Connect Facebook": open a real browser window (the Chrome or Edge already installed on this computer,
 * driven by playwright-core — nothing is downloaded), let the user log in to Facebook as they normally
 * would, and keep the session's cookies once Facebook has issued them (c_user + xs). The window uses a
 * fresh, throwaway profile and is closed afterwards; the cookies are only stored in this computer's
 * FlipWatch database. FlipWatch never sees or stores the password.
 *
 * The capture runs in the background; the page polls `facebookConnectStatus()`.
 */
import { hasSessionCookies } from "./settings";

export type ConnectState =
  | { state: "idle" }
  | { state: "starting" }
  | { state: "waiting"; since: number; browser: string }
  | { state: "connected"; at: number }
  | { state: "error"; message: string };

/** How long the login window waits for the user. */
export const LOGIN_TIMEOUT_MS = 5 * 60_000;
const POLL_MS = 1_000;

const store = globalThis as unknown as { __flipwatchFbConnect?: ConnectState; __flipwatchFbConnectCancel?: () => void };

export function facebookConnectStatus(): ConnectState {
  return store.__flipwatchFbConnect ?? { state: "idle" };
}

/** Test hook. */
export function resetFacebookConnect(): void {
  store.__flipwatchFbConnect = undefined;
  store.__flipwatchFbConnectCancel = undefined;
}

export interface BrowserCookie {
  name: string;
  value: string;
  domain: string;
}

/** The Cookie header Facebook expects, from the browser's cookies for facebook.com. */
export function cookieHeader(cookies: readonly BrowserCookie[]): string {
  return cookies
    .filter((c) => /(^|\.)facebook\.com$/i.test(c.domain.replace(/^\./, "")) && c.name && c.value)
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}

/** The minimum Playwright surface used here (so tests can fake it). */
export interface LoginBrowser {
  goto(url: string): Promise<void>;
  cookies(): Promise<BrowserCookie[]>;
  /** Resolves when the user closes the window. */
  closed: Promise<void>;
  close(): Promise<void>;
  name: string;
}

export type LaunchBrowser = () => Promise<LoginBrowser>;

/** Launch Edge or Chrome (whichever is installed) with a throwaway profile, visible to the user. */
export const launchInstalledBrowser: LaunchBrowser = async () => {
  const { chromium } = await import("playwright-core");
  const channels = process.platform === "win32" ? ["msedge", "chrome"] : ["chrome", "msedge"];
  let lastError: unknown = null;
  for (const channel of channels) {
    try {
      const browser = await chromium.launch({ channel, headless: false, args: ["--no-first-run", "--no-default-browser-check"] });
      const context = await browser.newContext({ viewport: null });
      const page = await context.newPage();
      const closed = new Promise<void>((resolve) => {
        browser.on("disconnected", () => resolve());
        page.on("close", () => resolve());
      });
      return {
        name: channel === "msedge" ? "Microsoft Edge" : "Google Chrome",
        goto: async (url) => {
          await page.goto(url, { waitUntil: "domcontentloaded" });
        },
        cookies: async () => (await context.cookies("https://www.facebook.com")).map(({ name, value, domain }) => ({ name, value, domain })),
        closed,
        close: () => browser.close().catch(() => undefined),
      };
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(
    `Couldn't open Chrome or Edge to log in to Facebook (${lastError instanceof Error ? lastError.message.split("\n")[0] : "not found"}). ` +
      "Install Google Chrome or Microsoft Edge, or paste a Cookie header under “Advanced”.",
  );
};

/**
 * Start the login window in the background. `onSession` stores the cookie header; it runs once, as soon
 * as Facebook has logged the user in. Calling this while a login window is open does nothing.
 */
export function startFacebookConnect(onSession: (cookies: string) => Promise<void>, launch: LaunchBrowser = launchInstalledBrowser, now = Date.now): ConnectState {
  const current = facebookConnectStatus();
  if (current.state === "starting" || current.state === "waiting") return current;
  store.__flipwatchFbConnect = { state: "starting" };
  void runConnect(onSession, launch, now);
  return store.__flipwatchFbConnect;
}

/** Close an open login window without saving anything. */
export function cancelFacebookConnect(): void {
  store.__flipwatchFbConnectCancel?.();
}

async function runConnect(onSession: (cookies: string) => Promise<void>, launch: LaunchBrowser, now: () => number): Promise<void> {
  let browser: LoginBrowser | null = null;
  let cancelled = false;
  let userClosed = false;
  try {
    browser = await launch();
    const open = browser;
    store.__flipwatchFbConnectCancel = () => {
      cancelled = true;
      void open.close();
    };
    void open.closed.then(() => (userClosed = true));
    await open.goto("https://www.facebook.com/login/?next=https%3A%2F%2Fwww.facebook.com%2Fmarketplace%2F");
    const since = now();
    store.__flipwatchFbConnect = { state: "waiting", since, browser: open.name };

    while (now() - since < LOGIN_TIMEOUT_MS) {
      if (cancelled) throw new Error("Cancelled — nothing was saved.");
      const header = cookieHeader(await open.cookies().catch(() => []));
      if (hasSessionCookies(header)) {
        // Facebook sets a few more cookies right after login; give it a moment so the header is complete.
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        const complete = cookieHeader(await open.cookies().catch(() => [])) || header;
        await onSession(hasSessionCookies(complete) ? complete : header);
        store.__flipwatchFbConnect = { state: "connected", at: now() };
        return;
      }
      if (userClosed) throw new Error("The login window was closed before you finished logging in — nothing was saved.");
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    throw new Error("Timed out waiting for the Facebook login (5 minutes) — nothing was saved.");
  } catch (err) {
    store.__flipwatchFbConnect = { state: "error", message: err instanceof Error ? err.message : String(err) };
  } finally {
    store.__flipwatchFbConnectCancel = undefined;
    await browser?.close();
  }
}
