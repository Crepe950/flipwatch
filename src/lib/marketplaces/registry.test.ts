import { afterEach, describe, expect, it, vi } from "vitest";
import { facebookAccounts } from "./facebook/settings";
import { createAdapterContext } from "./registry";

afterEach(() => vi.unstubAllEnvs());

describe("createAdapterContext", () => {
  it("leaves Facebook to split traffic over every configured account", () => {
    vi.stubEnv("FACEBOOK_COOKIES", "c_user=1; xs=old");
    vi.stubEnv("FACEBOOK_COOKIES_2", "c_user=2; xs=new");
    vi.stubEnv("FACEBOOK_ACCOUNT_SHARES", "35,65");
    const accounts = facebookAccounts(createAdapterContext());
    expect(accounts.map((a) => [a.key, Math.round(a.share * 100)])).toEqual([
      ["account-1", 35],
      ["account-2", 65],
    ]);
  });
});
