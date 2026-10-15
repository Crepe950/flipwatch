import { afterEach, describe, expect, it, vi } from "vitest";
import { cookieHeader, facebookConnectStatus, resetFacebookConnect, startFacebookConnect, type BrowserCookie, type LoginBrowser } from "./connect";

afterEach(() => {
  resetFacebookConnect();
  vi.useRealTimers();
});

function fakeBrowser(cookieSteps: BrowserCookie[][]) {
  let step = 0;
  let resolveClosed!: () => void;
  const browser: LoginBrowser & { closeCalls: number } = {
    name: "Fake Browser",
    goto: vi.fn(async () => undefined),
    cookies: async () => cookieSteps[Math.min(step++, cookieSteps.length - 1)],
    closed: new Promise((resolve) => (resolveClosed = resolve)),
    closeCalls: 0,
    async close() {
      this.closeCalls++;
      resolveClosed();
    },
  };
  return browser;
}

const fb = (name: string, value: string): BrowserCookie => ({ name, value, domain: ".facebook.com" });

async function settle(predicate: () => boolean) {
  for (let i = 0; i < 200 && !predicate(); i++) await vi.advanceTimersByTimeAsync(1_000);
}

describe("Facebook connect", () => {
  it("keeps only facebook.com cookies in the header", () => {
    expect(cookieHeader([fb("c_user", "1"), fb("xs", "a%3Ab"), { name: "sid", value: "x", domain: ".google.com" }, { name: "datr", value: "d", domain: "www.facebook.com" }])).toBe(
      "c_user=1; xs=a%3Ab; datr=d",
    );
  });

  it("saves the session once the user has logged in, then closes the window", async () => {
    vi.useFakeTimers();
    const browser = fakeBrowser([[fb("datr", "d")], [fb("datr", "d")], [fb("datr", "d"), fb("c_user", "42"), fb("xs", "s")]]);
    const saved: string[] = [];
    startFacebookConnect(async (cookies) => void saved.push(cookies), async () => browser);
    await settle(() => facebookConnectStatus().state === "connected");
    expect(facebookConnectStatus().state).toBe("connected");
    expect(saved).toEqual(["datr=d; c_user=42; xs=s"]);
    expect(browser.closeCalls).toBeGreaterThan(0);
  });

  it("saves nothing when the user closes the window first, and explains", async () => {
    vi.useFakeTimers();
    const browser = fakeBrowser([[fb("datr", "d")]]);
    const save = vi.fn(async () => undefined);
    startFacebookConnect(save, async () => browser);
    await vi.advanceTimersByTimeAsync(1_000);
    await browser.close();
    await settle(() => facebookConnectStatus().state === "error");
    expect(facebookConnectStatus()).toMatchObject({ state: "error", message: expect.stringMatching(/closed before you finished/) });
    expect(save).not.toHaveBeenCalled();
  });

  it("reports a missing browser", async () => {
    vi.useFakeTimers();
    startFacebookConnect(async () => undefined, async () => {
      throw new Error("Couldn't open Chrome or Edge");
    });
    await settle(() => facebookConnectStatus().state === "error");
    expect(facebookConnectStatus()).toMatchObject({ state: "error", message: expect.stringMatching(/Chrome or Edge/) });
  });
});
