/**
 * The AI engines FlipWatch can run on: plain constants, safe for client components (no SDKs, no secrets).
 */

export const AI_PROVIDERS = ["anthropic", "openai", "claude-cli", "codex-cli"] as const;
export type AiProviderId = (typeof AI_PROVIDERS)[number];

/** What a model name may contain (e.g. "claude-haiku-4-5", "gpt-5.6-luna", "sonnet"). Anything else is refused. */
export const MODEL_NAME = /^[A-Za-z0-9._:-]{1,64}$/;

/**
 * Default model per engine. Listing evaluation runs automatically on every new match of AI-enabled
 * searches, so the API defaults are fast and cheap at volume; users can pick another model in Settings → AI.
 * The CLI engines use the user's own subscription: "sonnet" lets Claude Code pick its current Sonnet, and
 * Codex uses whatever model the user configured for it.
 */
export const DEFAULT_MODELS: Record<AiProviderId, string> = {
  anthropic: "claude-haiku-4-5",
  openai: "gpt-5-mini",
  "claude-cli": "sonnet",
  "codex-cli": "",
};

export const PROVIDER_LABELS: Record<AiProviderId, string> = {
  anthropic: "Claude (Anthropic API key)",
  openai: "ChatGPT models (OpenAI API key)",
  "claude-cli": "Claude Code on this computer",
  "codex-cli": "Codex on this computer",
};

export interface EngineInfo {
  /** Short pitch shown under the option. */
  summary: string;
  /** Needs an API key pasted into FlipWatch. */
  needsKey: boolean;
  keyPrefix?: string;
  keyUrl?: string;
  keyHelp?: string;
  /** For the CLI engines: how to install and sign in. */
  setup?: string[];
  /** Example model names for the model box. */
  modelHint: string;
}

export const ENGINE_INFO: Record<AiProviderId, EngineInfo> = {
  anthropic: {
    summary: "Pay-as-you-go with your own Anthropic API key. Reads listing photos too.",
    needsKey: true,
    keyPrefix: "sk-ant-",
    keyUrl: "https://console.anthropic.com/settings/keys",
    keyHelp: "Create a key at console.anthropic.com → API keys (add a little credit first).",
    modelHint: "e.g. claude-haiku-4-5 (cheapest), claude-sonnet-5-5 (smarter)",
  },
  openai: {
    summary: "Pay-as-you-go with your own OpenAI API key. Reads listing photos too.",
    needsKey: true,
    keyPrefix: "sk-",
    keyUrl: "https://platform.openai.com/api-keys",
    keyHelp: "Create a key at platform.openai.com → API keys (add a little credit first).",
    modelHint: "e.g. gpt-5-mini — any chat model your key can use",
  },
  "claude-cli": {
    summary: "Uses Claude Code that you installed and signed into yourself, on this computer. Photos aren't sent.",
    needsKey: false,
    setup: [
      "Install Claude Code (claude.com/claude-code) or the Claude desktop app.",
      "Run `claude` in a terminal once and sign in with /login.",
      "FlipWatch then runs it in the background for each request, on your own plan's usage.",
    ],
    modelHint: "sonnet, opus or haiku — or a full model name",
  },
  "codex-cli": {
    summary: "Uses OpenAI Codex that you installed and signed into yourself, on this computer. Photos aren't sent.",
    needsKey: false,
    setup: [
      "Install Codex: `npm install -g @openai/codex`.",
      "Run `codex login` in a terminal once and sign in.",
      "FlipWatch then runs it in the background (read-only) for each request, on your own plan's usage.",
    ],
    modelHint: "leave blank for Codex's default",
  },
};
