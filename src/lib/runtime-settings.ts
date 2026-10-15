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


const settingsSchema = z
  .object({
    aiProvider: z.enum(AI_PROVIDERS).optional(),
    anthropicApiKey: z.string().trim().max(500).optional(),
    openaiApiKey: z.string().trim().max(500).optional(),
    /** Model per provider; blank = that provider's default. */
    aiModels: z.partialRecord(z.enum(AI_PROVIDERS), z.union([z.literal(""), z.string().trim().regex(MODEL_NAME)])).optional(),
    facebookEnabled: z.boolean().optional(),
    facebookCookies: z.string().trim().max(20_000).optional(),
    /** When the Facebook session was captured, for "connected 3 days ago". */
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

/** What pages may see: no secrets, only whether they're set. */
export interface PublicRuntimeSettings {
  aiProvider: AiProviderId | null;
  anthropicKey: string | null;
  openaiKey: string | null;
  aiModels: Partial<Record<AiProviderId, string>>;
  facebookEnabled: boolean;
  facebookConnected: boolean;
  facebookConnectedAt: string | null;
  facebookAccountName: string | null;
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
    facebookConnected: Boolean(s.facebookCookies),
    facebookConnectedAt: s.facebookConnectedAt ?? null,
    facebookAccountName: s.facebookAccountName ?? null,
    // The App ID isn't a secret (it's sent with every eBay request); the Cert ID and bot token are.
    ebayClientId: s.ebayClientId ?? null,
    ebaySecret: maskSecret(s.ebayClientSecret),
    discordToken: maskSecret(s.discordBotToken),
    discordAllowedUserIds: s.discordAllowedUserIds ?? "",
    setupDone: s.setupDone === true,
  };
}
