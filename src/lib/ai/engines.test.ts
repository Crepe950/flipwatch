import type Anthropic from "@anthropic-ai/sdk";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, type Db } from "../db";
import { loadRuntimeSettings, maskSecret, publicRuntimeSettings, runtimeSettings, saveRuntimeSettings, setRuntimeSettingsForTests } from "../runtime-settings";
import { config } from "../config";
import { getAiClient, isAiConfigured, resolveModel } from "./client";
import { codexArgs, codexError, OPTIONAL_DISABLED, REQUIRED_DISABLED, resolveCodexCommand, unknownFeatures } from "./codex-cli";
import { createOpenAiClient, toChatRequest } from "./openai";
import { responseText } from "./response";

const body: Anthropic.MessageCreateParamsNonStreaming = {
  model: "gpt-test",
  max_tokens: 500,
  system: "You value listings.",
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "Listing: RTX 3070 for $300" },
        { type: "image", source: { type: "url", url: "https://example.com/a.jpg" } },
      ],
    },
  ],
  output_config: { format: { type: "json_schema", schema: { type: "object", properties: { score: { type: "integer" } } } } },
};

function fakeFetch(...responses: Array<{ status: number; json: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = vi.fn(async (url: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const next = responses.shift() ?? { status: 500, json: {} };
    return new Response(JSON.stringify(next.json), { status: next.status, headers: { "Content-Type": "application/json" } });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

describe("OpenAI engine", () => {
  it("translates system, text, images and the answer schema", () => {
    const req = toChatRequest(body) as { messages: Array<{ role: string; content: unknown }>; response_format: { json_schema: { schema: unknown } }; max_completion_tokens: number };
    expect(req.messages[0]).toEqual({ role: "system", content: "You value listings." });
    expect(req.messages[1].content).toEqual([
      { type: "text", text: "Listing: RTX 3070 for $300" },
      { type: "image_url", image_url: { url: "https://example.com/a.jpg" } },
    ]);
    expect(req.response_format.json_schema.schema).toEqual({ type: "object", properties: { score: { type: "integer" } } });
    expect(req.max_completion_tokens).toBe(500);
  });

  it("returns the answer as a message, with the key only in the Authorization header", async () => {
    const { impl, calls } = fakeFetch({ status: 200, json: { choices: [{ finish_reason: "stop", message: { content: '{"score":80}' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } } });
    const message = await createOpenAiClient("sk-test-1234567890abcdef", impl).messages.create(body);
    expect(responseText(message)).toBe('{"score":80}');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test-1234567890abcdef");
    expect(String(calls[0].init.body)).not.toContain("sk-test");
  });

  it("explains a bad key without retrying, and retries rate limits", async () => {
    const bad = fakeFetch({ status: 401, json: { error: { message: "Incorrect API key provided: sk-proj-abcdefghijklmnopqrstuvwx" } } });
    await expect(createOpenAiClient("x", bad.impl).messages.create(body)).rejects.toThrow(/rejected the API key/);
    expect(bad.calls).toHaveLength(1);

    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 1000 });
    try {
      const busy = fakeFetch({ status: 429, json: { error: { message: "slow down" } } }, { status: 200, json: { choices: [{ message: { content: "ok" } }] } });
      const message = await createOpenAiClient("x", busy.impl).messages.create(body);
      expect(responseText(message)).toBe("ok");
      expect(busy.calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports refusals and cut-off answers like Claude's", async () => {
    const refused = await createOpenAiClient("x", fakeFetch({ status: 200, json: { choices: [{ message: { content: null, refusal: "no" } }] } }).impl).messages.create(body);
    expect(() => responseText(refused)).toThrow(/declined/);
    const message = await createOpenAiClient("x", fakeFetch({ status: 200, json: { choices: [{ finish_reason: "length", message: { content: '{"sc' } }] } }).impl).messages.create(body);
    expect(() => responseText(message)).toThrow(/cut off/);
  });
});

describe("Codex engine", () => {
  it("runs read-only, ephemeral, outside git, without the user's config and with its tools off", () => {
    const args = codexArgs("gpt-5-codex", "/tmp/s.json", "/tmp/a.txt");
    expect(args.slice(0, 7)).toEqual(["exec", "--skip-git-repo-check", "--ephemeral", "--sandbox", "read-only", "--ignore-user-config", "--color"]);
    for (const feature of [...REQUIRED_DISABLED, ...OPTIONAL_DISABLED]) expect(args.join(" ")).toContain(`--disable ${feature}`);
    expect(args.join(" ")).toContain('-c web_search="disabled"');
    expect(args.slice(-5)).toEqual(["--output-schema", "/tmp/s.json", "-m", "gpt-5-codex", "-"]);
    expect(codexArgs("", null, "/tmp/a.txt")).not.toContain("-m");
    expect(codexArgs("", null, "/tmp/a.txt", ["shell_tool"]).filter((a) => a === "--disable")).toHaveLength(1);
  });

  it("refuses model names that could be read as commands", () => {
    for (const bad of ['x" & calc & "', "gpt-5; rm -rf /", "a b", "$(whoami)", "x|y", "x".repeat(65)]) {
      expect(() => codexArgs(bad, null, "/tmp/a.txt"), bad).toThrow(/isn't a valid model name/);
    }
    expect(() => codexArgs("gpt-5.6-luna", null, "/tmp/a.txt")).not.toThrow();
  });

  it("starts npm's Codex through node directly instead of cmd.exe", () => {
    // A bare name that isn't installed anywhere on PATH is reported, not run through a shell.
    expect(() => resolveCodexCommand("codex", "win32", "")).toThrow(/Couldn't find Codex/);
    expect(resolveCodexCommand("C:\\tools\\codex.exe", "win32")).toEqual({ file: "C:\\tools\\codex.exe", prefix: [] });
    expect(resolveCodexCommand("C:\\tools\\codex.js", "win32")).toEqual({ file: process.execPath, prefix: ["C:\\tools\\codex.js"] });
    expect(resolveCodexCommand("codex", "linux")).toEqual({ file: "codex", prefix: [] });
  });

  it("knows which tool switches an older Codex lacks", () => {
    expect(unknownFeatures("Error: Unknown feature flag: in_app_browser\n")).toEqual(["in_app_browser"]);
    expect(unknownFeatures("all good")).toEqual([]);
  });

  it("explains an unsupported model or a missing sign-in", () => {
    const unsupported = `ERROR: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The 'gpt-6-sol' model is not supported when using Codex with a ChatGPT account."}}`;
    expect(codexError(unsupported, 1).message).toMatch(/can't use that model.*gpt-6-sol.*Settings → AI/);
    expect(codexError("Error: Not logged in. Run `codex login`.", 1).message).toMatch(/isn't signed in/);
    expect(codexError("something else broke", 2).message).toMatch(/exit 2.*something else broke/);
  });
});

describe("engine choice from saved settings", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => {
    setRuntimeSettingsForTests(null);
    await close();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("prefers settings saved in the app over the environment, and hides secrets from pages", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-env");
    setRuntimeSettingsForTests({});
    expect(config.aiProvider).toBe("anthropic");

    await saveRuntimeSettings(db, { aiProvider: "openai", openaiApiKey: "sk-proj-abcdefghijklmnop1234", aiModels: { openai: "gpt-x" } });
    expect(config.aiProvider).toBe("openai");
    expect(config.openaiApiKey).toBe("sk-proj-abcdefghijklmnop1234");
    expect(resolveModel()).toBe("gpt-x");
    expect(isAiConfigured()).toBe(true);
    expect(getAiClient()).toBeDefined();

    const shown = publicRuntimeSettings();
    expect(JSON.stringify(shown)).not.toContain("abcdefghijklmnop");
    expect(shown.openaiKey).toBe(maskSecret("sk-proj-abcdefghijklmnop1234"));

    // Saved to the database, not just memory; "" clears a field.
    setRuntimeSettingsForTests(null);
    await loadRuntimeSettings(db);
    expect(runtimeSettings().aiProvider).toBe("openai");
    await saveRuntimeSettings(db, { openaiApiKey: "" });
    expect(isAiConfigured()).toBe(false);

    await saveRuntimeSettings(db, { aiProvider: "codex-cli" });
    expect(isAiConfigured()).toBe(true);
    expect(resolveModel()).toBe("");
  });
});
