import { runtimeSettings, type AiProviderId } from "./runtime-settings";

/**
 * Typed access to environment configuration. Read lazily so tests can mutate process.env.
 * Never import this from client components — it exposes secrets.
 */

function str(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v.trim() === "" ? undefined : v.trim();
}

function int(name: string, fallback: number): number {
  const v = str(name);
  if (v === undefined) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

export type WorkerMode = "inline" | "external" | "off";

/** Settings saved in the app (Settings page / first-run setup) win over the environment. */
const rt = () => runtimeSettings();

export const config = {
  /** Postgres connection string. When unset, an embedded PGlite database is used. */
  get databaseUrl() {
    return str("DATABASE_URL");
  },
  /** Directory for the embedded PGlite database (ignored when DATABASE_URL is set). */
  get pgliteDir() {
    return str("PGLITE_DIR") ?? ".data/pglite";
  },
  /**
   * Public base URL used in notification links. Set it to the public https:// URL when the app is
   * exposed so the session cookie is always marked Secure.
   */
  get appUrl() {
    return (str("APP_URL") ?? "http://localhost:3000").replace(/\/+$/, "");
  },
  /** Optional password gate for the whole app. */
  get appPassword() {
    return str("APP_PASSWORD");
  },
  /**
   * Secret used to sign session cookies. Optional: when unset, a random one is generated and stored in
   * the database (see lib/session-secret.ts). Never derived from APP_PASSWORD — a captured cookie
   * would allow an offline dictionary attack on the password.
   */
  get sessionSecret() {
    return str("SESSION_SECRET");
  },
  /**
   * Set when a reverse proxy you control sets X-Forwarded-For. Only then is that header used to
   * rate-limit logins per client; otherwise any client could spoof it.
   */
  get trustProxy() {
    return str("TRUST_PROXY") === "true";
  },
  /** Secret required by /api/cron/tick (for serverless schedulers). */
  get cronSecret() {
    return str("CRON_SECRET");
  },
  /**
   * inline   — the Next.js server runs the polling scheduler (default; simplest for self-hosting).
   * external — a separate `npm run worker` process polls; the web app only serves UI.
   * off      — nothing polls (use /api/cron/tick or "Run now").
   */
  get workerMode(): WorkerMode {
    const v = str("WORKER_MODE");
    return v === "external" || v === "off" ? v : "inline";
  },
  /** How often the scheduler wakes up to look for due searches. */
  get schedulerTickMs() {
    return int("SCHEDULER_TICK_MS", 5_000);
  },
  /** Hard floor for any search's poll interval. */
  get minPollIntervalSec() {
    return int("MIN_POLL_INTERVAL_SEC", 30);
  },
  get scraperUserAgent() {
    return str("SCRAPER_USER_AGENT");
  },
  get scraperTimeoutMs() {
    return int("SCRAPER_TIMEOUT_MS", 20_000);
  },

  // --- AI (Claude) ---
  get anthropicApiKey() {
    return rt().anthropicApiKey || str("ANTHROPIC_API_KEY");
  },
  get openaiApiKey() {
    return rt().openaiApiKey || str("OPENAI_API_KEY");
  },
  /** Model for the current provider: the one picked in Settings, else AI_MODEL, else the provider's default. */
  get aiModel() {
    return rt().aiModels?.[this.aiProvider] || str("AI_MODEL");
  },
  /**
   * anthropic (Claude API key) | openai (OpenAI API key) | claude-cli / codex-cli (the user's own installed and
   * signed-in Claude Code or Codex CLI). The Settings choice wins; else AI_PROVIDER; else whichever key is set.
   */
  get aiProvider(): AiProviderId {
    const chosen = rt().aiProvider;
    if (chosen) return chosen;
    const env = str("AI_PROVIDER");
    if (env === "claude-cli" || env === "codex-cli" || env === "openai" || env === "anthropic") return env;
    if (!str("ANTHROPIC_API_KEY") && str("OPENAI_API_KEY")) return "openai";
    return "anthropic";
  },
  /** Path to the `codex` executable for codex-cli; found on PATH when unset. */
  get codexCliPath() {
    return str("CODEX_CLI_PATH");
  },
  /** Path to the `claude` executable for AI_PROVIDER=claude-cli; auto-detected when unset. */
  get claudeCliPath() {
    return str("CLAUDE_CLI_PATH");
  },
  /** Claude requests run at the same time (listing evaluations, price checks, hunts). 1–16, default 6. */
  get aiConcurrency() {
    return Math.min(16, Math.max(1, int("AI_CONCURRENCY", 6)));
  },

  // --- eBay Browse API ---
  get ebayClientId() {
    return rt().ebayClientId || str("EBAY_CLIENT_ID");
  },
  get ebayClientSecret() {
    return rt().ebayClientSecret || str("EBAY_CLIENT_SECRET");
  },
  /** e.g. EBAY_US, EBAY_CA. Defaults from the search's country. */
  get ebayMarketplaceId() {
    return str("EBAY_MARKETPLACE_ID");
  },
  /** Also return auctions (default: Buy It Now / Best Offer only). Auction-only listings come back unpriced. */
  get ebayIncludeAuctions() {
    return str("EBAY_INCLUDE_AUCTIONS") === "true";
  },
  /** Only items offered for local pickup near the search's postal code (default: anywhere in its country). */
  get ebayLocalPickupOnly() {
    return str("EBAY_LOCAL_PICKUP_ONLY") === "true";
  },

  // --- Facebook Marketplace (opt-in; see README) ---
  get facebookEnabled() {
    return rt().facebookEnabled ?? str("FACEBOOK_ENABLED") === "true";
  },
  /** Raw Cookie header from a logged-in browser session ("Connect Facebook" in the app, or FACEBOOK_COOKIES). */
  get facebookCookies() {
    return rt().facebookCookies || str("FACEBOOK_COOKIES");
  },
  /**
   * Cookie headers of every Facebook account to search with: the one connected in the app, else
   * FACEBOOK_COOKIES, FACEBOOK_COOKIES_2, FACEBOOK_COOKIES_3.
   */
  get facebookAccountCookies(): Array<{ slot: number; cookies: string }> {
    const connected = rt().facebookCookies;
    if (connected) return [{ slot: 1, cookies: connected }];
    return [str("FACEBOOK_COOKIES"), str("FACEBOOK_COOKIES_2"), str("FACEBOOK_COOKIES_3")]
      .map((cookies, i) => ({ slot: i + 1, cookies }))
      .filter((a): a is { slot: number; cookies: string } => Boolean(a.cookies));
  },
  /**
   * Relative share of Facebook traffic per account slot, e.g. "35,65" (account 1, account 2). Missing or
   * invalid entries count as equal shares.
   */
  get facebookAccountShares(): number[] {
    return (str("FACEBOOK_ACCOUNT_SHARES") ?? "")
      .split(",")
      .map((s) => Number.parseFloat(s.trim()))
      .map((n) => (Number.isFinite(n) && n > 0 ? n : Number.NaN));
  },
  /** Most Facebook requests per hour (page loads + API calls); scheduled searches may use two thirds. */
  get facebookMaxRequestsPerHour() {
    return Math.max(3, int("FACEBOOK_MAX_REQUESTS_PER_HOUR", 60));
  },

  // --- Discord bot (manage searches with /search) ---
  /** Bot token from the Discord Developer Portal; unset = no bot. */
  get discordBotToken() {
    return rt().discordBotToken || str("DISCORD_BOT_TOKEN");
  },
  /** Discord user ids allowed to use the bot's commands. Empty = the owner of each server the bot is in. */
  get discordAllowedUserIds(): string[] {
    return (rt().discordAllowedUserIds || str("DISCORD_ALLOWED_USER_IDS") || "")
      .split(/[\s,]+/)
      .filter((id) => /^\d{5,25}$/.test(id));
  },

  // --- Notifications ---
  get vapidPublicKey() {
    return str("VAPID_PUBLIC_KEY") ?? str("NEXT_PUBLIC_VAPID_PUBLIC_KEY");
  },
  get vapidPrivateKey() {
    return str("VAPID_PRIVATE_KEY");
  },
  get vapidSubject() {
    return str("VAPID_SUBJECT") ?? "mailto:alerts@flipwatch.local";
  },
  /** SMTP connection URL for email alerts, e.g. smtps://user:pass@smtp.example.com:465 */
  get smtpUrl() {
    return str("SMTP_URL");
  },
  get emailFrom() {
    return str("EMAIL_FROM") ?? "FlipWatch <alerts@flipwatch.local>";
  },
};
