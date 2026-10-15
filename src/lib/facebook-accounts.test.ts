import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { config } from "./config";
import { createTestDb, type Db } from "./db";
import { facebookAccounts, facebookStatus } from "./marketplaces/facebook/settings";
import {
  facebookAccountsPatch,
  MAX_FACEBOOK_ACCOUNTS,
  publicRuntimeSettings,
  runtimeSettings,
  saveRuntimeSettings,
  setRuntimeSettingsForTests,
  storedFacebookAccounts,
  TooManyFacebookAccountsError,
  withFacebookSession,
  type StoredFacebookAccount,
} from "./runtime-settings";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(async () => {
  setRuntimeSettingsForTests(null);
  await close();
});
afterEach(() => vi.unstubAllEnvs());

const NOW = new Date("2026-10-15T12:00:00Z");
let nextId = 0;
const ids = () => `id${++nextId}`;

describe("withFacebookSession", () => {
  it("adds a new account for each different Facebook login", () => {
    const one = withFacebookSession([], "c_user=1001; xs=a", NOW, ids);
    const two = withFacebookSession(one, "c_user=2002; xs=b", NOW, ids);
    expect(two).toHaveLength(2);
    expect(two.map((a) => a.cookies)).toEqual(["c_user=1001; xs=a", "c_user=2002; xs=b"]);
    expect(new Set(two.map((a) => a.id)).size).toBe(2);
  });

  it("refreshes an account that is already connected, keeping its name and share", () => {
    const accounts: StoredFacebookAccount[] = [
      { id: "main", cookies: "c_user=1001; xs=old", name: "Main", share: 65, connectedAt: "2026-10-01T00:00:00Z" },
      { id: "spare", cookies: "c_user=2002; xs=b", share: 35 },
    ];
    const next = withFacebookSession(accounts, "c_user=1001; xs=new", NOW, ids);
    expect(next).toHaveLength(2);
    expect(next[0]).toEqual({ id: "main", cookies: "c_user=1001; xs=new", name: "Main", share: 65, connectedAt: NOW.toISOString() });
    expect(next[1]).toBe(accounts[1]);
  });

  it("refuses more than the maximum number of accounts", () => {
    let accounts: StoredFacebookAccount[] = [];
    for (let i = 0; i < MAX_FACEBOOK_ACCOUNTS; i++) accounts = withFacebookSession(accounts, `c_user=${i + 1}; xs=x`, NOW, ids);
    expect(() => withFacebookSession(accounts, "c_user=99; xs=x", NOW, ids)).toThrow(TooManyFacebookAccountsError);
    // Refreshing one that's already there still works when full.
    expect(withFacebookSession(accounts, "c_user=1; xs=fresh", NOW, ids)[0].cookies).toBe("c_user=1; xs=fresh");
  });
});

describe("Facebook accounts saved in the app", () => {
  it("reads a session saved before multiple accounts as the first account", () => {
    setRuntimeSettingsForTests({ facebookEnabled: true, facebookCookies: "c_user=1001; xs=a", facebookConnectedAt: "2026-10-01T00:00:00Z" });
    expect(storedFacebookAccounts()).toEqual([{ id: "main", cookies: "c_user=1001; xs=a", connectedAt: "2026-10-01T00:00:00Z" }]);
    expect(config.facebookCookies).toBe("c_user=1001; xs=a");
    expect(publicRuntimeSettings().facebookAccounts).toEqual([
      { id: "main", name: null, label: "Account 1", userIdHint: "1001", connectedAt: "2026-10-01T00:00:00Z", share: null, percent: 100 },
    ]);
  });

  it("split searches by share, win over the environment, and never reach pages", async () => {
    vi.stubEnv("FACEBOOK_COOKIES", "c_user=9; xs=env");
    setRuntimeSettingsForTests({ facebookEnabled: true, facebookCookies: "c_user=1001; xs=legacy" });
    const accounts: StoredFacebookAccount[] = [
      { id: "main", cookies: "c_user=1001; xs=a", name: "Main", share: 65 },
      { id: "spare", cookies: "c_user=2002; xs=b", share: 35 },
    ];
    await saveRuntimeSettings(db, facebookAccountsPatch(accounts), NOW);

    // The pre-multi-account field is gone once the list is saved.
    expect(runtimeSettings().facebookCookies).toBeUndefined();
    expect(facebookAccounts().map((a) => [a.key, a.label, Math.round(a.share * 100)])).toEqual([
      ["fb-main", "Main", 65],
      ["fb-spare", "Account 2", 35],
    ]);
    expect(facebookStatus().message).toMatch(/^Enabled with 2 accounts: Main 65% .*; Account 2 35% /);

    const visible = publicRuntimeSettings();
    expect(visible.facebookAccounts.map((a) => [a.label, a.userIdHint, a.percent])).toEqual([
      ["Main", "1001", 65],
      ["Account 2", "2002", 35],
    ]);
    expect(JSON.stringify(visible)).not.toMatch(/xs=/);
  });

  it("gives accounts without a share the average of the others", async () => {
    await saveRuntimeSettings(
      db,
      facebookAccountsPatch([
        { id: "a", cookies: "c_user=1; xs=a", share: 60 },
        { id: "b", cookies: "c_user=2; xs=b" },
        { id: "c", cookies: "c_user=3; xs=c", share: 30 },
      ]),
      NOW,
    );
    // Blank share = average of 60 and 30 = 45, so 60 : 45 : 30.
    expect(facebookAccounts().map((a) => Math.round(a.share * 100))).toEqual([44, 33, 22]);
    expect(publicRuntimeSettings().facebookAccounts.map((a) => a.percent)).toEqual([44, 33, 22]);
  });

  it("falls back to the environment's accounts when none are saved in the app", async () => {
    vi.stubEnv("FACEBOOK_COOKIES", "c_user=1; xs=old");
    vi.stubEnv("FACEBOOK_COOKIES_2", "c_user=2; xs=new");
    vi.stubEnv("FACEBOOK_ACCOUNT_SHARES", "35,65");
    await saveRuntimeSettings(db, facebookAccountsPatch([]), NOW);
    expect(facebookAccounts().map((a) => [a.key, Math.round(a.share * 100)])).toEqual([
      ["account-1", 35],
      ["account-2", 65],
    ]);
    expect(publicRuntimeSettings().facebookConnected).toBe(false);
  });
});
