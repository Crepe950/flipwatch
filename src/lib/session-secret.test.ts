import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type Db } from "./db";
import { appSettings } from "./db/schema";
import { getSetting, setSetting } from "./queries/settings";
import { SESSION_SECRET_KEY, getSessionSecret } from "./session-secret";

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(() => close());

beforeEach(async () => {
  await db.delete(appSettings);
  vi.stubEnv("SESSION_SECRET", "");
  vi.stubEnv("APP_PASSWORD", "hunter2");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

/** A second copy of the module, as another bundle or process would have: no shared memory cache. */
async function freshModule() {
  vi.resetModules();
  return import("./session-secret");
}

describe("getSessionSecret", () => {
  it("uses SESSION_SECRET when set, without touching the database", async () => {
    vi.stubEnv("SESSION_SECRET", "from-env");
    await expect(getSessionSecret(db)).resolves.toBe("from-env");
    expect(await getSetting(db, SESSION_SECRET_KEY)).toBeUndefined();
  });

  it("otherwise generates a random secret, stores it and keeps using it", async () => {
    const { getSessionSecret: load } = await freshModule();
    const secret = await load(db);
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(secret).not.toBe("hunter2");
    expect(await getSetting(db, SESSION_SECRET_KEY)).toBe(secret);
    await expect(load(db)).resolves.toBe(secret);
    // Another process sharing the database (or a restart) signs with the same key.
    const other = await freshModule();
    await expect(other.getSessionSecret(db)).resolves.toBe(secret);
  });

  it("agrees on one secret when several processes create it at once", async () => {
    const copies = await Promise.all([freshModule(), freshModule(), freshModule()]);
    const secrets = await Promise.all(copies.map((m) => m.getSessionSecret(db)));
    expect(new Set(secrets).size).toBe(1);
    expect(await getSetting(db, SESSION_SECRET_KEY)).toBe(secrets[0]);
  });

  it("replaces a stored value that is too weak to sign with", async () => {
    await setSetting(db, SESSION_SECRET_KEY, "short");
    const { getSessionSecret: load } = await freshModule();
    const secret = await load(db);
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await getSetting(db, SESSION_SECRET_KEY)).toBe(secret);
  });

  it("retries after a database error instead of caching it", async () => {
    const { getSessionSecret: load } = await freshModule();
    let down = true;
    const flaky = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "select" && down) {
          down = false;
          return () => {
            throw new Error("db down");
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    await expect(load(flaky)).rejects.toThrow("db down");
    await expect(load(flaky)).resolves.toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
