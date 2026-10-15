"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { aiStatus } from "@/lib/ai";
import { MODEL_NAME } from "@/lib/ai/engines";
import { getAiClient, resolveModel } from "@/lib/ai/client";
import { toAiError } from "@/lib/ai/errors";
import { responseText } from "@/lib/ai/response";
import { config } from "@/lib/config";
import { getDb } from "@/lib/db";
import { discordBotStatus, discordInviteUrl, restartDiscordBot, type DiscordBotStatus } from "@/lib/discord-bot";
import { getEbayAccessToken, resetEbayTokenCache } from "@/lib/marketplaces/ebay/auth";
import { resolveEbayCredentials } from "@/lib/marketplaces/ebay/credentials";
import { createAdapterContext } from "@/lib/marketplaces/registry";
import { locationFromPlace, placeAt, searchPlaces, type Place } from "@/lib/geocode";
import { cancelFacebookConnect, facebookConnectStatus, startFacebookConnect, type ConnectState } from "@/lib/marketplaces/facebook/connect";
import { hasSessionCookies, isSendableCookieHeader, normalizeCookieHeader } from "@/lib/marketplaces/facebook/settings";
import { setDefaultLocation } from "@/lib/queries/settings";
import { AI_PROVIDERS, publicRuntimeSettings, saveRuntimeSettings, type PublicRuntimeSettings } from "@/lib/runtime-settings";
import { requireAuth } from "../login/session";

function errorMessage(err: unknown): string {
  return err instanceof Error && err.message ? err.message : "Something went wrong";
}

function refresh() {
  revalidatePath("/settings");
  revalidatePath("/setup");
  revalidatePath("/");
}

// ---- AI engine ------------------------------------------------------------------------------------

export interface AiFormResult {
  ok: boolean;
  error?: string;
  settings?: PublicRuntimeSettings;
}

const aiInput = z.object({
  provider: z.enum(AI_PROVIDERS),
  /** Only sent when the user typed a new key; blank keeps the saved one. */
  apiKey: z.string().trim().max(500).optional(),
  model: z
    .string()
    .trim()
    .refine((m) => m === "" || MODEL_NAME.test(m), "Model names only use letters, numbers, dots, dashes and colons (e.g. claude-haiku-4-5)")
    .optional(),
});

export async function saveAiSettingsAction(input: z.input<typeof aiInput>): Promise<AiFormResult> {
  await requireAuth();
  const parsed = aiInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid settings" };
  const { provider, apiKey, model } = parsed.data;
  if (apiKey && provider === "anthropic" && !apiKey.startsWith("sk-ant-")) return { ok: false, error: "Claude API keys start with “sk-ant-”. Copy it from console.anthropic.com → API keys." };
  if (apiKey && provider === "openai" && !apiKey.startsWith("sk-")) return { ok: false, error: "OpenAI API keys start with “sk-”. Copy it from platform.openai.com → API keys." };
  try {
    const db = await getDb();
    const current = publicRuntimeSettings();
    const needsKey = provider === "anthropic" ? !current.anthropicKey : provider === "openai" ? !current.openaiKey : false;
    if (needsKey && !apiKey) return { ok: false, error: "Paste your API key first." };
    const settings = await saveRuntimeSettings(db, {
      aiProvider: provider,
      ...(apiKey && provider === "anthropic" ? { anthropicApiKey: apiKey } : {}),
      ...(apiKey && provider === "openai" ? { openaiApiKey: apiKey } : {}),
      aiModels: { ...(current.aiModels ?? {}), [provider]: model ?? "" },
    });
    refresh();
    return { ok: true, settings: publicRuntimeSettings(settings) };
  } catch (err) {
    return { ok: false, error: `Couldn't save: ${errorMessage(err)}` };
  }
}

export interface AiTestResult {
  ok: boolean;
  message: string;
}

/** One tiny request through the chosen engine, so the user knows it works before relying on it. */
export async function testAiAction(): Promise<AiTestResult> {
  await requireAuth();
  const status = aiStatus();
  if (!status.configured) return { ok: false, message: status.message ?? "Choose an AI engine first." };
  try {
    const text = responseText(
      await getAiClient().messages.create({
        model: resolveModel(),
        max_tokens: 200,
        system: "You are a connectivity check. Answer with the requested JSON only.",
        messages: [{ role: "user", content: 'Reply with {"ok": true}.' }],
        output_config: { format: { type: "json_schema", schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false } } },
      }),
    );
    if (!/"ok"\s*:\s*true/.test(text)) return { ok: false, message: `The AI answered, but not as expected: ${text.slice(0, 120)}` };
    return { ok: true, message: `Working — ${status.message}` };
  } catch (err) {
    return { ok: false, message: toAiError(err).message };
  }
}

// ---- Facebook -------------------------------------------------------------------------------------

export async function setFacebookEnabledAction(enabled: boolean, acknowledgedRisk: boolean): Promise<AiFormResult> {
  await requireAuth();
  if (enabled && !acknowledgedRisk) return { ok: false, error: "Tick the box to confirm you understand the risk first." };
  const settings = await saveRuntimeSettings(await getDb(), { facebookEnabled: enabled === true });
  refresh();
  return { ok: true, settings: publicRuntimeSettings(settings) };
}

async function storeSession(cookies: string): Promise<void> {
  await saveRuntimeSettings(await getDb(), { facebookCookies: cookies, facebookConnectedAt: new Date().toISOString(), facebookEnabled: true });
}

export async function startFacebookConnectAction(): Promise<ConnectState> {
  await requireAuth();
  return startFacebookConnect(storeSession);
}

export async function facebookConnectStatusAction(): Promise<{ status: ConnectState; settings: PublicRuntimeSettings }> {
  await requireAuth();
  const status = facebookConnectStatus();
  if (status.state === "connected") refresh();
  return { status, settings: publicRuntimeSettings() };
}

export async function cancelFacebookConnectAction(): Promise<void> {
  await requireAuth();
  cancelFacebookConnect();
}

export async function disconnectFacebookAction(): Promise<AiFormResult> {
  await requireAuth();
  const settings = await saveRuntimeSettings(await getDb(), { facebookCookies: "", facebookConnectedAt: "", facebookEnabled: false });
  refresh();
  return { ok: true, settings: publicRuntimeSettings(settings) };
}

/** Advanced: paste a Cookie header copied from the browser's developer tools. */
export async function saveFacebookCookieAction(raw: string): Promise<AiFormResult> {
  await requireAuth();
  const cookies = normalizeCookieHeader(typeof raw === "string" ? raw.slice(0, 20_000) : "");
  if (!cookies) return { ok: false, error: "Paste the Cookie header first." };
  if (!isSendableCookieHeader(cookies)) return { ok: false, error: "That contains characters a Cookie header can't have — copy the whole value again." };
  if (!hasSessionCookies(cookies)) return { ok: false, error: "That isn't a logged-in session: it needs the c_user and xs cookies." };
  await storeSession(cookies);
  refresh();
  return { ok: true, settings: publicRuntimeSettings() };
}

// ---- Area -----------------------------------------------------------------------------------------

export async function searchPlacesAction(query: string): Promise<{ places: Place[]; error?: string }> {
  await requireAuth();
  try {
    return { places: await searchPlaces(typeof query === "string" ? query : "") };
  } catch (err) {
    return { places: [], error: errorMessage(err) };
  }
}

export async function placeAtAction(lat: number, lng: number): Promise<{ place: Place | null; error?: string }> {
  await requireAuth();
  try {
    return { place: await placeAt(Number(lat), Number(lng)) };
  } catch (err) {
    return { place: null, error: errorMessage(err) };
  }
}

const areaInput = z.object({
  label: z.string().trim().min(1).max(120),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  countryCode: z.enum(["CA", "US"]),
  postalCode: z.string().trim().max(12).nullable().optional(),
  radiusKm: z.number().min(1, "Radius must be between 1 and 500 km").max(500, "Radius must be between 1 and 500 km"),
});

export async function saveAreaAction(input: z.input<typeof areaInput>): Promise<{ ok: boolean; error?: string }> {
  await requireAuth();
  const parsed = areaInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Pick a place first" };
  try {
    const { radiusKm, ...place } = parsed.data;
    await setDefaultLocation(await getDb(), locationFromPlace({ ...place, postalCode: place.postalCode ?? null }, radiusKm));
  } catch (err) {
    return { ok: false, error: `Couldn't save: ${errorMessage(err)}` };
  }
  refresh();
  return { ok: true };
}

// ---- Setup ----------------------------------------------------------------------------------------

export async function finishSetupAction(): Promise<void> {
  await requireAuth();
  await saveRuntimeSettings(await getDb(), { setupDone: true });
  refresh();
}

// ---- eBay -----------------------------------------------------------------------------------------

export interface KeysResult {
  ok: boolean;
  error?: string;
  message?: string;
  settings?: PublicRuntimeSettings;
}

const ebayInput = z.object({
  /** Blank keeps the saved value. */
  clientId: z.string().trim().max(200).optional(),
  clientSecret: z.string().trim().max(200).optional(),
});

export async function saveEbayKeysAction(input: z.input<typeof ebayInput>): Promise<KeysResult> {
  await requireAuth();
  const parsed = ebayInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid keys" };
  const { clientId, clientSecret } = parsed.data;
  if (clientId && /SBX/i.test(clientId)) return { ok: false, error: "That's a Sandbox App ID (it contains “SBX”) — use the Production keyset." };
  const settings = await saveRuntimeSettings(await getDb(), {
    ...(clientId ? { ebayClientId: clientId } : {}),
    ...(clientSecret ? { ebayClientSecret: clientSecret } : {}),
  });
  resetEbayTokenCache();
  refresh();
  return { ok: true, settings: publicRuntimeSettings(settings) };
}

/** Ask eBay for an access token with the saved keys: proves they work without spending a search. */
export async function testEbayAction(): Promise<KeysResult> {
  await requireAuth();
  const creds = resolveEbayCredentials();
  if (!creds) return { ok: false, error: "Save both the App ID and the Cert ID first." };
  try {
    resetEbayTokenCache();
    await getEbayAccessToken(createAdapterContext({ log: () => undefined }), creds);
    return { ok: true, message: "eBay accepted the keys. Tick eBay on a search to include it." };
  } catch (err) {
    const message = errorMessage(err);
    return { ok: false, error: /401|invalid_client|unauthori[sz]ed/i.test(message) ? "eBay rejected these keys — check you copied the Production App ID and Cert ID." : `eBay test failed: ${message}` };
  }
}

export async function clearEbayKeysAction(): Promise<KeysResult> {
  await requireAuth();
  const settings = await saveRuntimeSettings(await getDb(), { ebayClientId: "", ebayClientSecret: "" });
  resetEbayTokenCache();
  refresh();
  return { ok: true, settings: publicRuntimeSettings(settings) };
}

// ---- Discord bot ----------------------------------------------------------------------------------

export interface DiscordBotView {
  status: DiscordBotStatus;
  inviteUrl: string | null;
  /** The bot only runs inside the web server when WORKER_MODE=inline (the default). */
  runsHere: boolean;
}

function botView(): DiscordBotView {
  const status = discordBotStatus();
  const appId = "applicationId" in status ? status.applicationId : null;
  return { status, inviteUrl: appId ? discordInviteUrl(appId) : null, runsHere: config.workerMode === "inline" };
}

const discordInput = z.object({
  /** Blank keeps the saved token. */
  token: z.string().trim().max(200).optional(),
  allowedUserIds: z
    .string()
    .trim()
    .max(500)
    .refine((v) => v === "" || v.split(/[\s,]+/).every((id) => /^\d{5,25}$/.test(id)), "User IDs are numbers, separated by commas"),
});

export async function saveDiscordBotAction(input: z.input<typeof discordInput>): Promise<KeysResult & { bot?: DiscordBotView }> {
  await requireAuth();
  const parsed = discordInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid settings" };
  const { token, allowedUserIds } = parsed.data;
  if (token && !/^[\w-]{20,}\.[\w-]{4,}\.[\w-]{20,}$/.test(token)) return { ok: false, error: "That doesn't look like a bot token — copy it from the Developer Portal (Bot → Reset Token)." };
  const settings = await saveRuntimeSettings(await getDb(), { ...(token ? { discordBotToken: token } : {}), discordAllowedUserIds: allowedUserIds });
  if (config.workerMode === "inline") restartDiscordBot(getDb);
  refresh();
  return { ok: true, settings: publicRuntimeSettings(settings), bot: botView() };
}

export async function discordBotStatusAction(): Promise<DiscordBotView> {
  await requireAuth();
  return botView();
}

export async function removeDiscordBotAction(): Promise<KeysResult & { bot?: DiscordBotView }> {
  await requireAuth();
  const settings = await saveRuntimeSettings(await getDb(), { discordBotToken: "" });
  if (config.workerMode === "inline") restartDiscordBot(getDb);
  refresh();
  return { ok: true, settings: publicRuntimeSettings(settings), bot: botView() };
}