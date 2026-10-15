import { DrizzleQueryError } from "drizzle-orm/errors";
import { describe, expect, it } from "vitest";
import { errorMessage } from "../log";

describe("errorMessage", () => {
  it("uses the innermost cause of wrapped errors", () => {
    const pgError = Object.assign(new Error("deadlock detected"), { code: "40P01" });
    expect(errorMessage(new DrizzleQueryError('update "listings" set …', [1, 2], pgError))).toBe("deadlock detected");
    const network = new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND example.test") });
    expect(errorMessage(network)).toBe("getaddrinfo ENOTFOUND example.test");
  });

  it("keeps the outer message when the cause has none or isn't an Error", () => {
    expect(errorMessage(new Error("outer", { cause: new Error("") }))).toBe("outer");
    expect(errorMessage(new Error("outer", { cause: "just a string" }))).toBe("outer");
  });

  it("survives cyclic causes and non-Error values", () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    (a as { cause?: unknown }).cause = b;
    expect(["a", "b"]).toContain(errorMessage(a));
    expect(errorMessage("plain")).toBe("plain");
    expect(errorMessage({ code: 1 })).toBe('{"code":1}');
    expect(errorMessage(new Error(""))).toBe("Error");
  });
});
