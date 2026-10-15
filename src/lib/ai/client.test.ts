import Anthropic, { APIConnectionError, APIUserAbortError } from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AI_MAX_RETRIES, AI_TIMEOUT_MS, createAnthropicClient, DEFAULT_AI_MODEL, getAiClient, resolveModel, setAiClientFactory } from "./client";
import { AiNotConfiguredError, AiRequestError, redactSecrets, toAiError } from "./errors";
import { apiError, createFakeClient, textMessage } from "./testing/fake-client";

const ENV_KEYS = ["ANTHROPIC_API_KEY", "AI_MODEL"] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  setAiClientFactory(null);
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("client", () => {
  it("resolves the model from AI_MODEL with a fast, inexpensive default", () => {
    expect(resolveModel()).toBe(DEFAULT_AI_MODEL);
    expect(DEFAULT_AI_MODEL).toBe("claude-haiku-4-5");
    process.env.AI_MODEL = "  claude-opus-5-5 ";
    expect(resolveModel()).toBe("claude-opus-5-5");
  });

  it("refuses to build a client without an API key", () => {
    expect(() => getAiClient()).toThrow(AiNotConfiguredError);
  });

  it("builds the client lazily and once per API key", () => {
    const built: string[] = [];
    setAiClientFactory((key) => {
      built.push(key);
      return createFakeClient(() => textMessage("hi"));
    });
    process.env.ANTHROPIC_API_KEY = "key-1";
    const first = getAiClient();
    expect(getAiClient()).toBe(first);
    process.env.ANTHROPIC_API_KEY = "key-2";
    expect(getAiClient()).not.toBe(first);
    expect(built).toEqual(["key-1", "key-2"]);
  });

  it("configures retries and a request timeout on the real SDK client", () => {
    const client = createAnthropicClient("sk-ant-x");
    expect(client).toBeInstanceOf(Anthropic);
    expect(client.maxRetries).toBe(AI_MAX_RETRIES);
    expect(client.timeout).toBe(AI_TIMEOUT_MS);
    expect(AI_MAX_RETRIES).toBeGreaterThanOrEqual(2);
  });
});

describe("toAiError", () => {
  it("summarises API errors as status + type + short detail", () => {
    const error = toAiError(apiError(404, "not_found_error", "model: claude-nope"));
    expect(error).toBeInstanceOf(AiRequestError);
    expect(error.message).toBe("Claude API error 404 not_found_error: model: claude-nope");
  });

  it("truncates long details and redacts credentials", () => {
    const error = toAiError(apiError(401, "authentication_error", `invalid x-api-key: sk-ant-api03-SECRET ${"x".repeat(400)}`));
    expect(error.message).not.toContain("SECRET");
    expect(error.message.length).toBeLessThan(220);
    expect(redactSecrets("Authorization: Bearer abc123")).toBe("Authorization: [redacted]");
    expect(redactSecrets("key sk-ant-api03-XYZ_1 used")).toBe("key [redacted] used");
  });

  it("maps connection problems and passes other errors through", () => {
    expect(toAiError(new APIConnectionError({ message: "ECONNRESET" })).message).toBe("Could not reach the Claude API");
    expect(toAiError(new APIUserAbortError()).message).toBe("Claude API request was aborted");
    const plain = new Error("db down");
    expect(toAiError(plain)).toBe(plain);
    expect(toAiError("weird").message).toBe("Unexpected AI error: weird");
  });
});
