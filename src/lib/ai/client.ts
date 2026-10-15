import Anthropic, { type ClientOptions } from "@anthropic-ai/sdk";
import { config } from "../config";
import { DEFAULT_MODELS, PROVIDER_LABELS, type AiProviderId } from "./engines";
import { createClaudeCliClient } from "./claude-cli";
import { createCodexCliClient } from "./codex-cli";
import { AiNotConfiguredError } from "./errors";
import { createOpenAiClient } from "./openai";

export { DEFAULT_MODELS, PROVIDER_LABELS };
/** Kept for callers and tests that predate multiple engines. */
export const DEFAULT_AI_MODEL = DEFAULT_MODELS.anthropic;

/** Per-attempt timeout. The SDK retries 408/409/429/5xx and connection errors with backoff. */
export const AI_TIMEOUT_MS = 60_000;
export const AI_MAX_RETRIES = 3;

/** The subset of the Anthropic client this module uses; tests inject a fake through setAiClientFactory. */
export interface AiClient {
  messages: {
    create(body: Anthropic.MessageCreateParamsNonStreaming, options?: Anthropic.RequestOptions): Promise<Anthropic.Message>;
  };
}

export type AiClientFactory = (apiKey: string) => AiClient;

export function resolveModel(): string {
  return config.aiModel ?? DEFAULT_MODELS[config.aiProvider];
}

export function createAnthropicClient(apiKey: string, overrides: Partial<ClientOptions> = {}): Anthropic {
  return new Anthropic({
    apiKey,
    // Never let an ambient ANTHROPIC_AUTH_TOKEN ride along: sending both credentials is a 401.
    authToken: null,
    maxRetries: AI_MAX_RETRIES,
    timeout: AI_TIMEOUT_MS,
    ...overrides,
  });
}

/** The key the current engine needs, or null for the CLI engines (they use their own sign-in). */
function providerKey(provider: AiProviderId): string | undefined | null {
  if (provider === "anthropic") return config.anthropicApiKey;
  if (provider === "openai") return config.openaiApiKey;
  return null;
}

/** True when AI calls can be made: the chosen engine's API key is set, or a CLI engine is chosen. */
export function isAiConfigured(): boolean {
  if (factory) return Boolean(config.anthropicApiKey);
  const key = providerKey(config.aiProvider);
  return key === null || Boolean(key);
}

let factory: AiClientFactory | null = null;
let cached: { id: string; client: AiClient } | null = null;

/** Replace how clients are built (tests). Pass null to restore the real clients. */
export function setAiClientFactory(next: AiClientFactory | null): void {
  factory = next;
  cached = null;
}

/** Lazily build (and reuse) a client for the configured engine. Throws AiNotConfiguredError without a key. */
export function getAiClient(): AiClient {
  if (factory) {
    const apiKey = config.anthropicApiKey;
    if (!apiKey) throw new AiNotConfiguredError();
    if (cached?.id !== `test:${apiKey}`) cached = { id: `test:${apiKey}`, client: factory(apiKey) };
    return cached.client;
  }
  const provider = config.aiProvider;
  const key = providerKey(provider);
  if (key === undefined || key === "") throw new AiNotConfiguredError();
  const id = `${provider}:${key ?? ""}`;
  if (cached?.id !== id) {
    const client =
      provider === "anthropic"
        ? createAnthropicClient(key!)
        : provider === "openai"
          ? createOpenAiClient(key!)
          : provider === "claude-cli"
            ? createClaudeCliClient()
            : createCodexCliClient();
    cached = { id, client };
  }
  return cached.client;
}
