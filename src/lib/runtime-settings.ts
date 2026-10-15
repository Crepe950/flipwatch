/**
 * Settings the user changes in the app (Settings page, first-run setup) instead of in environment
 * variables: the AI engine and its key, the Facebook session, the area. They are kept in the
 * `app_settings` table under one key and mirrored here in memory, so the synchronous `config` getters
 * can prefer them over the environment without touching the database. `getDb()` loads them once per
 * process; saving goes through `saveRuntimeSettings`, which updates both.
 *
 * Secrets (API keys, the Facebook cookie) never leave the server: pages only get `publicRuntimeSettings`.
 */
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "./db";
import { appSettings } from "./db/schema";
import { AI_PROVIDERS, MODEL_NAME, type AiProviderId } from "./ai/engines";

export { AI_PROVIDERS, type AiProviderId };

export const RUNTIME_SETTINGS_KEY = "runtime";

/** Most Facebook accounts FlipWatch will split searches between. */
export const MAX_FACEBOOK_ACCOUNTS = 5;

const facebookAccountSchema = z.object({
  /** Stable id: keys the account's hourly budget and the Settings row. */
  id: z.string().regex(/^[a-z0-9]{1,16}$/),
  cookies: z.string().trim().min(1).max(20_000),
  /** The user's own label ("Main", "Spare"); blank = "Account 2". */
  name: z.string().trim().max(60).optional(),
  connectedAt: z.string().optional(),
  /** Relative share of Facebook searches (1–100); unset = an equal share. */
  share: z.number().int().min(1).max(100).optional(),
});

export type StoredFacebookAccount = z.infer<typeof facebookAccountSchema>;

const settingsSchema = z
  .object({
    aiProvider: z.enum(AI_PROVIDERS).optional(),
    anthropicApiKey: z.string().trim().max(500).optional(),
    openaiApiKey: z.string().trim().max(500).optional(),
    /** Model per provider; blank = that provider's default. */
    aiModels: z.partialRecord(z.enum(AI_PROVIDERS), z.union([z.literal(""), z.string().trim().regex(MODEL_NAME)])).optional(),
    facebookEnabled: z.boolean().optional(),
    /** Connected Facebook accounts; searches are split between them by share. */
    facebookAccounts: z.array(facebookAccountSchema).max(MAX_FACEBOOK_ACCOUNTS).optional(),
    /** Before multiple accounts: the one connected session. Read as the first account; cleared on the next change. */
    facebookCookies: z.string().trim().max(20_000).optional(),
    facebookConnectedAt: z.string().optional(),
    facebookAccountName: z.string().trim().max(200).optional(),
    /** eBay Browse API Production keyset (developer.ebay.com): App ID and Cert ID. */
    ebayClientId: z.string().trim().max(200).optional(),
    ebayClientSecret: z.string().trim().max(200).optional(),
    /** Discord bot token, and the user ids allowed to use its commands (comma/space separated; empty = server owner). */
    discordBotToken: z.string().trim().max(200).optional(),
    discordAllowedUserIds: z.string().trim().max(500).optional(),
    /** The user finished (or skipped) the first-run setup. */
    setupDone: z.boolean().optional(),
  })
  .strip();

export type RuntimeSettings = z.infer<typeof settingsSchema>;

const state = globalThis as unknown as { __flipwatchRuntimeSettings?: RuntimeSettings; __flipwatchRuntimeLoaded?: boolean };

/** The in-memory copy (empty until loaded). */
export function runtimeSettings(): RuntimeSettings {
  return state.__flipwatchRuntimeSettings ?? {};
}

/** Test hook: replace the in-memory copy. */
export function setRuntimeSettingsForTests(next: RuntimeSettings | null): void {
  state.__flipwatchRuntimeSettings = next ?? undefined;
  state.__flipwatchRuntimeLoaded = next !== null;
}

export function runtimeSettingsLoaded(): boolean {
  return state.__flipwatchRuntimeLoaded === true;
}

/** Read the saved settings into memory. A broken row is ignored (the environment still applies). */
export async function loadRuntimeSettings(db: Db): Promise<RuntimeSettings> {
  const [row] = await db.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, RUNTIME_SETTINGS_KEY)).limit(1);
  const parsed = settingsSchema.safeParse(row?.value ?? {});
  state.__flipwatchRuntimeSettings = parsed.success ? parsed.data : {};
  state.__flipwatchRuntimeLoaded = true;
  return state.__flipwatchRuntimeSettings;
}

/** Merge `patch` into the saved settings. `undefined` leaves a field alone; `""` clears a text field. */
export async function saveRuntimeSettings(db: Db, patch: Partial<RuntimeSettings>, now = new Date()): Promise<RuntimeSettings> {
  const current = runtimeSettingsLoaded() ? runtimeSettings() : await loadRuntimeSettings(db);
  const merged: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === "") delete merged[key];
    else merged[key] = value;
  }
  const next = settingsSchema.parse(merged);
  await db
    .insert(appSettings)
    .values({ key: RUNTIME_SETTINGS_KEY, value: next, updatedAt: now })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: next, updatedAt: now } });
  state.__flipwatchRuntimeSettings = next;
  state.__flipwatchRuntimeLoaded = true;
  return next;
}

/** "sk-ant-…3f9a": enough to recognise a key without revealing it. */
export function maskSecret(secret: string | undefined): string | null {
  if (!secret) return null;
  const s = secret.trim();
  if (s.length <= 10) return "•".repeat(s.length);
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

/** The saved Facebook accounts, including a session saved before multiple accounts were supported. */
export function storedFacebookAccounts(s: RuntimeSettings = runtimeSettings()): StoredFacebookAccount[] {
  if (s.facebookAccounts?.length) return s.facebookAccounts;
  if (!s.facebookCookies) return [];
  return [{ id: "main", cookies: s.facebookCookies, name: s.facebookAccountName || undefined, connectedAt: s.facebookConnectedAt }];
}

/** Settings patch that saves `accounts` and drops the pre-multi-account fields. */
export function facebookAccountsPatch(accounts: StoredFacebookAccount[]): Partial<RuntimeSettings> {
  return { facebookAccounts: accounts, facebookCookies: "", facebookConnectedAt: "", facebookAccountName: "" };
}

/** Facebook's numeric account id (the c_user cookie), or null. */
export function facebookUserId(cookies: string): string | null {
  const match = /(?:^|;\s*)c_user=(\d+)/.exec(cookies);
  return match ? match[1] : null;
}

/** The label pages and status messages use for an account. */
export function facebookAccountLabel(account: Pick<StoredFacebookAccount, "name">, index: number): string {
  return account.name?.trim() || `Account ${index + 1}`;
}

export class TooManyFacebookAccountsError extends Error {
  constructor() {
    super(`You can connect up to ${MAX_FACEBOOK_ACCOUNTS} Facebook accounts. Remove one first.`);
    this.name = "TooManyFacebookAccountsError";
  }
}

/**
 * Add a freshly captured session. Logging in to an account that is already listed (same c_user) refreshes
 * that account's session and keeps its name and share; anything else becomes a new account.
 */
export function withFacebookSession(
  accounts: StoredFacebookAccount[],
  cookies: string,
  now = new Date(),
  newId: () => string = () => Math.random().toString(36).slice(2, 10) || "acct",
): StoredFacebookAccount[] {
  const userId = facebookUserId(cookies);
  const connectedAt = now.toISOString();
  const existing = userId ? accounts.findIndex((a) => facebookUserId(a.cookies) === userId) : -1;
  if (existing >= 0) return accounts.map((a, i) => (i === existing ? { ...a, cookies, connectedAt } : a));
  if (accounts.length >= MAX_FACEBOOK_ACCOUNTS) throw new TooManyFacebookAccountsError();
  let id = newId();
  while (accounts.some((a) => a.id === id)) id = newId();
  return [...accounts, { id, cookies, connectedAt }];
}

/** A Facebook account as pages see it: no cookies, just enough to tell the accounts apart. */
export interface PublicFacebookAccount {
  id: string;
  name: string | null;
  label: string;
  /** Last 4 digits of the Facebook account id, to tell two unnamed accounts apart. */
  userIdHint: string | null;
  connectedAt: string | null;
  /** The saved share setting (1–100), or null for an equal share. */
  share: number | null;
  /** What it works out to: percent of Facebook searches. */
  percent: number;
}

export function publicFacebookAccounts(accounts: StoredFacebookAccount[]): PublicFacebookAccount[] {
  const weights = accounts.map((a) => a.share ?? Number.NaN);
  const known = weights.filter(Number.isFinite);
  const fallback = known.length ? known.reduce((x, y) => x + y, 0) / known.length : 1;
  const filled = weights.map((w) => (Number.isFinite(w) ? w : fallback));
  const sum = filled.reduce((x, y) => x + y, 0) || 1;
  return accounts.map((a, i) => {
    const userId = facebookUserId(a.cookies);
    return {
      id: a.id,
      name: a.name?.trim() || null,
      label: facebookAccountLabel(a, i),
      userIdHint: userId ? userId.slice(-4) : null,
      connectedAt: a.connectedAt ?? null,
      share: a.share ?? null,
      percent: Math.round((filled[i] / sum) * 100),
    };
  });
}

/** What pages may see: no secrets, only whether they're set. */
export interface PublicRuntimeSettings {
  aiProvider: AiProviderId | null;
  anthropicKey: string | null;
  openaiKey: string | null;
  aiModels: Partial<Record<AiProviderId, string>>;
  facebookEnabled: boolean;
  facebookConnected: boolean;
  facebookAccounts: PublicFacebookAccount[];
  ebayClientId: string | null;
  ebaySecret: string | null;
  discordToken: string | null;
  discordAllowedUserIds: string;
  setupDone: boolean;
}

export function publicRuntimeSettings(s: RuntimeSettings = runtimeSettings()): PublicRuntimeSettings {
  return {
    aiProvider: s.aiProvider ?? null,
    anthropicKey: maskSecret(s.anthropicApiKey),
    openaiKey: maskSecret(s.openaiApiKey),
    aiModels: s.aiModels ?? {},
    facebookEnabled: s.facebookEnabled === true,
    facebookConnected: storedFacebookAccounts(s).length > 0,
    facebookAccounts: publicFacebookAccounts(storedFacebookAccounts(s)),
    // The App ID isn't a secret (it's sent with every eBay request); the Cert ID and bot token are.
    ebayClientId: s.ebayClientId ?? null,
    ebaySecret: maskSecret(s.ebayClientSecret),
    discordToken: maskSecret(s.discordBotToken),
    discordAllowedUserIds: s.discordAllowedUserIds ?? "",
    setupDone: s.setupDone === true,
  };
}
