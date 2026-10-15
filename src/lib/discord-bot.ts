/**
 * Discord bot for FlipWatch: `/search <request>` (change searches in plain words, applied by Claude via
 * search-assistant), `/searches` (list them) and `/hunt <request>` (a Deal Hunt: live search + ranked picks). It connects out to Discord's gateway over a WebSocket,
 * so it needs no public URL, and registers its commands in every server it is in. Only the users in
 * DISCORD_ALLOWED_USER_IDS may use it, or by default the owner of the server the command came from.
 *
 * Runs wherever the scheduler runs (inline web server or the standalone worker), once per process.
 */
import { eq } from "drizzle-orm";
import { startHunt, type HuntResult } from "./ai/deal-hunt";
import { config } from "./config";
import type { Db } from "./db";
import { hunts } from "./db/schema";
import { errorMessage, log } from "./engine/log";
import { formatPrice } from "./format";
import { escapeDiscord, truncate } from "./notify/escape";
import { applySearchPlan, runSearchRequest } from "./search-assistant";

const API = "https://discord.com/api/v10";
const INTENT_GUILDS = 1 << 0;
const MAX_MESSAGE = 2000;

const COMMANDS = [
  {
    name: "search",
    description: "Create or change a FlipWatch search in plain words",
    options: [
      {
        type: 3,
        name: "request",
        description: "e.g. “watch for RTX 3080s under $450” or “make PS5 max $700”",
        required: true,
        max_length: 1500,
      },
    ],
  },
  { name: "searches", description: "List your FlipWatch searches" },
  {
    name: "hunt",
    description: "Search the marketplaces right now and rank the best deals",
    options: [
      {
        type: 3,
        name: "request",
        description: "e.g. “RTX 4070 Ti under $600” or “gaming PCs to part out under $500”",
        required: true,
        max_length: 1000,
      },
    ],
  },
];

/** Discord's interaction token lasts 15 minutes; stop waiting on a hunt a bit before that. */
const HUNT_WAIT_MS = 14 * 60_000;
/** A hunt still running after this long was cut off (see deal-hunt STALE_MS); stop watching it. */
const HUNT_MAX_MS = 60 * 60_000;
const HUNT_POLL_MS = 3_000;
const HUNT_PICKS_SHOWN = 5;

/** URL usable inside a markdown [label](url) link. */
function linkUrl(url: string): string {
  return url.replace(/\(/g, "%28").replace(/\)/g, "%29").replace(/ /g, "%20");
}

/** A finished hunt as a Discord message: summary, top picks with links, and where to see the rest. */
export function formatHuntReply(request: string, result: HuntResult, huntUrl: string): string {
  const money = (cents: number | null, currency: string) => (cents === null ? "?" : formatPrice(cents, currency));
  const lines = [`> ${escapeDiscord(truncate(request, 200))}`];
  if (result.summary) lines.push(escapeDiscord(truncate(result.summary, 500)));
  if (result.marketNotes) lines.push(`-# Market: ${escapeDiscord(truncate(result.marketNotes, 250))}`);
  for (const p of result.picks.slice(0, HUNT_PICKS_SHOWN)) {
    const profit =
      p.estimatedProfitCents === null ? "" : ` (${p.estimatedProfitCents >= 0 ? "+" : "−"}${money(Math.abs(p.estimatedProfitCents), p.currency)})`;
    const checked = p.checked ? " ✓" : "";
    const worth = p.estimatedValueCents === null ? "" : ` → worth ~${money(p.estimatedValueCents, p.currency)}${checked}${profit}`;
    lines.push(
      `**${p.rank}. [${escapeDiscord(truncate(p.title, 90))}](${linkUrl(p.url)})** · ${money(p.priceCents, p.currency)}${worth} · ${p.score}/100 · ${p.marketplace}`,
      `-# ${escapeDiscord(truncate(p.why, 180))}${p.redFlags.length ? ` ⚠ ${escapeDiscord(truncate(p.redFlags.join("; "), 120))}` : ""}`,
    );
  }
  if (result.picks.length === 0) lines.push("No real deals right now.");
  else if (result.picks.some((p) => p.checked)) lines.push("-# ✓ = value verified by a price check against live listings (parts searched one by one)");
  const more = result.picks.length > HUNT_PICKS_SHOWN ? `${result.picks.length - HUNT_PICKS_SHOWN} more picks and ` : "";
  lines.push(`-# ${result.considered} listings compared · [${more}full results in FlipWatch](${linkUrl(huntUrl)})`);
  // Keep whole lines when trimming to Discord's limit.
  let out = "";
  for (const line of lines) {
    if (out.length + line.length + 1 > MAX_MESSAGE) break;
    out += (out ? "\n" : "") + line;
  }
  return out;
}

interface GatewayPayload {
  op: number;
  d: unknown;
  s: number | null;
  t: string | null;
}

interface Interaction {
  id: string;
  token: string;
  type: number;
  application_id: string;
  guild_id?: string;
  channel_id?: string;
  member?: { user?: { id: string } };
  user?: { id: string };
  data?: { name?: string; options?: Array<{ name: string; value: unknown }> };
}

export interface DiscordBot {
  stop(): void;
}

async function rest(path: string, init: { method: string; body?: unknown; auth?: boolean }): Promise<unknown> {
  const res = await fetch(`${API}${path}`, {
    method: init.method,
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "DiscordBot (https://github.com/flipwatch, 0.1)",
      ...(init.auth === false ? {} : { Authorization: `Bot ${config.discordBotToken}` }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Discord ${init.method} ${path.replace(/\/[\w-]{60,}/g, "/…")} → HTTP ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

function fitMessage(text: string): string {
  return text.length <= MAX_MESSAGE ? text : `${text.slice(0, MAX_MESSAGE - 1)}…`;
}

function reply(interaction: Interaction, content: string, ephemeral = false) {
  return rest(`/interactions/${interaction.id}/${interaction.token}/callback`, {
    method: "POST",
    auth: false,
    body: { type: 4, data: { content: fitMessage(content), allowed_mentions: { parse: [] }, flags: ephemeral ? 64 : 0 } },
  });
}

function editReply(interaction: Interaction, content: string) {
  return rest(`/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
    method: "PATCH",
    auth: false,
    body: { content: fitMessage(content), allowed_mentions: { parse: [] } },
  });
}

/** What Settings shows about the bot. `applicationId` is known once Discord accepted the token. */
export type DiscordBotStatus =
  | { state: "off" }
  | { state: "connecting"; applicationId: string | null }
  | { state: "connected"; username: string; applicationId: string | null }
  | { state: "error"; message: string; applicationId: string | null };

const globalForBot = globalThis as unknown as { __flipwatchDiscordBot?: DiscordBot; __flipwatchDiscordStatus?: DiscordBotStatus };

export function discordBotStatus(): DiscordBotStatus {
  return globalForBot.__flipwatchDiscordStatus ?? { state: "off" };
}

function setStatus(next: DiscordBotStatus): void {
  globalForBot.__flipwatchDiscordStatus = next;
}

/**
 * Link that adds the bot to a server with the permissions it needs (view channels, send messages) and its
 * slash commands.
 */
export function discordInviteUrl(applicationId: string): string {
  const params = new URLSearchParams({ client_id: applicationId, scope: "bot applications.commands", permissions: String(1024 + 2048) });
  return `https://discord.com/oauth2/authorize?${params}`;
}

/** Stop the running bot (if any) and start it again with the current token — after it changed in Settings. */
export function restartDiscordBot(getDb: () => Promise<Db>): DiscordBot | null {
  globalForBot.__flipwatchDiscordBot?.stop();
  globalForBot.__flipwatchDiscordBot = undefined;
  return startDiscordBot(getDb);
}

/** Start the bot when a bot token is set (Settings → Discord bot, or DISCORD_BOT_TOKEN). Safe to call more than once per process. */
export function startDiscordBot(getDb: () => Promise<Db>): DiscordBot | null {
  if (!config.discordBotToken) {
    setStatus({ state: "off" });
    return null;
  }
  if (globalForBot.__flipwatchDiscordBot) return globalForBot.__flipwatchDiscordBot;
  setStatus({ state: "connecting", applicationId: null });

  let ws: WebSocket | null = null;
  let stopped = false;
  let seq: number | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let firstBeat: ReturnType<typeof setTimeout> | null = null;
  let acked = true;
  let backoffMs = 2_000;
  let botApplicationId: string | null = null;
  const owners = new Map<string, string>();
  const registered = new Set<string>();
  // One request at a time, so two quick commands can't edit the same search from stale state.
  let queue: Promise<unknown> = Promise.resolve();

  const send = (op: number, d: unknown) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ op, d }));

  const clearTimers = () => {
    if (heartbeat) clearInterval(heartbeat);
    if (firstBeat) clearTimeout(firstBeat);
    heartbeat = firstBeat = null;
  };

  async function registerCommands(applicationId: string, guildId: string) {
    if (registered.has(guildId)) return;
    try {
      await rest(`/applications/${applicationId}/guilds/${guildId}/commands`, { method: "PUT", body: COMMANDS });
      registered.add(guildId);
      log.info(`Discord bot: ${COMMANDS.map((c) => `/${c.name}`).join(", ")} registered in server ${guildId}`);
    } catch (err) {
      log.warn(`Discord bot: could not register commands in server ${guildId}: ${errorMessage(err)}`);
    }
  }

  function allowed(interaction: Interaction): boolean {
    const userId = interaction.member?.user?.id ?? interaction.user?.id;
    if (!userId) return false;
    const list = config.discordAllowedUserIds;
    if (list.length > 0) return list.includes(userId);
    return interaction.guild_id !== undefined && owners.get(interaction.guild_id) === userId;
  }

  async function handleInteraction(interaction: Interaction) {
    if (interaction.type !== 2 || !interaction.data?.name) return;
    const name = interaction.data.name;
    if (name !== "search" && name !== "searches" && name !== "hunt") return;
    try {
      if (!allowed(interaction)) {
        await reply(interaction, "Only the FlipWatch owner can use FlipWatch commands.", true);
        return;
      }
      // Acknowledge within Discord's 3 s limit; Claude takes longer.
      await rest(`/interactions/${interaction.id}/${interaction.token}/callback`, { method: "POST", auth: false, body: { type: 5 } });
      const request = String(interaction.data.options?.find((o) => o.name === "request")?.value ?? "").trim();
      if (name === "hunt") {
        await runHuntCommand(interaction, request);
        return;
      }
      const task = queue.then(async () => {
        const db = await getDb();
        const result =
          name === "searches" || !request
            ? await applySearchPlan(db, { action: "list", searchId: null, changes: {}, reply: "" })
            : await runSearchRequest(db, request);
        return name === "search" ? `> ${request}\n${result.reply}` : result.reply;
      });
      queue = task.catch(() => undefined);
      await editReply(interaction, await task);
      log.info(`Discord bot: /${name} ${request ? `"${request.slice(0, 80)}"` : ""} handled`);
    } catch (err) {
      log.warn(`Discord bot: /${name} failed: ${errorMessage(err)}`);
      await editReply(interaction, `Couldn't do that: ${errorMessage(err).slice(0, 300)}`).catch(() => undefined);
    }
  }

  /** Start a Deal Hunt, show its progress in the reply, then replace it with the ranked picks. */
  async function runHuntCommand(interaction: Interaction, request: string) {
    const db = await getDb();
    const id = await startHunt(db, request);
    const quoted = `> ${escapeDiscord(truncate(request, 200))}`;
    // The interaction token (for editing the reply) lasts 15 minutes; a hunt that price-checks many picks
    // can take longer, so after that the finished result is posted as a new message in the same channel.
    const replyDeadline = Date.now() + HUNT_WAIT_MS;
    const giveUp = Date.now() + HUNT_MAX_MS;
    let shown = "";
    let viaChannel = false;
    while (Date.now() < giveUp) {
      await new Promise((r) => setTimeout(r, HUNT_POLL_MS));
      const [row] = await db.select().from(hunts).where(eq(hunts.id, id));
      if (!row) throw new Error("The hunt disappeared");
      if (row.status === "error") throw new Error(row.error ?? "The hunt failed");
      if (row.status === "done" && row.result) {
        const text = formatHuntReply(request, row.result as HuntResult, `${config.appUrl}/hunt`);
        if (viaChannel && interaction.channel_id) {
          await rest(`/channels/${interaction.channel_id}/messages`, { method: "POST", body: { content: text, allowed_mentions: { parse: [] } } });
        } else {
          await editReply(interaction, text);
        }
        log.info(`Discord bot: /hunt "${request.slice(0, 80)}" handled`);
        return;
      }
      if (!viaChannel && Date.now() >= replyDeadline) {
        viaChannel = true;
        await editReply(interaction, `${quoted}\n⏳ Still price-checking — I'll post the results here when it's done.`).catch(() => undefined);
        continue;
      }
      const stage = row.stage ?? "Working…";
      if (!viaChannel && stage !== shown) {
        shown = stage;
        await editReply(interaction, `${quoted}\n⏳ ${escapeDiscord(stage)}`).catch(() => undefined);
      }
    }
  }

  function onDispatch(t: string, d: Record<string, unknown>) {
    if (t === "READY") {
      backoffMs = 2_000;
      const user = d.user as { username?: string } | undefined;
      log.info(`Discord bot connected as ${user?.username ?? "bot"}`);
      setStatus({ state: "connected", username: user?.username ?? "bot", applicationId: botApplicationId });
    } else if (t === "GUILD_CREATE") {
      const guildId = String(d.id);
      owners.set(guildId, String(d.owner_id));
      if (botApplicationId) void registerCommands(botApplicationId, guildId);
    } else if (t === "INTERACTION_CREATE") {
      void handleInteraction(d as unknown as Interaction);
    }
  }

  async function connect() {
    if (stopped) return;
    let url: string;
    try {
      const app = (await rest("/applications/@me", { method: "GET" })) as { id: string };
      botApplicationId = app.id;
      url = ((await rest("/gateway/bot", { method: "GET" })) as { url: string }).url;
    } catch (err) {
      log.warn(`Discord bot: could not reach Discord (${errorMessage(err)}); retrying in ${Math.round(backoffMs / 1000)} s`);
      if (stopped) return;
      // A 401 here means the token itself is wrong: say so instead of retrying forever.
      if (/\b401\b|unauthori[sz]ed/i.test(errorMessage(err))) {
        setStatus({ state: "error", message: "Discord rejected the bot token — copy it again from the Developer Portal (Bot → Reset Token).", applicationId: null });
        return;
      }
      setStatus({ state: "error", message: `Couldn't reach Discord (${errorMessage(err)}); retrying…`, applicationId: botApplicationId });
      setTimeout(connect, backoffMs);
      backoffMs = Math.min(backoffMs * 2, 300_000);
      return;
    }

    ws = new WebSocket(`${url}/?v=10&encoding=json`);
    ws.addEventListener("message", (event) => {
      let payload: GatewayPayload;
      try {
        payload = JSON.parse(String(event.data)) as GatewayPayload;
      } catch {
        return;
      }
      if (payload.s !== null && payload.s !== undefined) seq = payload.s;
      switch (payload.op) {
        case 10: {
          const interval = (payload.d as { heartbeat_interval: number }).heartbeat_interval;
          acked = true;
          const beat = () => {
            if (!acked) {
              log.warn("Discord bot: heartbeat not acknowledged; reconnecting");
              ws?.close(4000);
              return;
            }
            acked = false;
            send(1, seq);
          };
          firstBeat = setTimeout(() => {
            beat();
            heartbeat = setInterval(beat, interval);
          }, interval * Math.random());
          send(2, {
            token: config.discordBotToken,
            intents: INTENT_GUILDS,
            properties: { os: process.platform, browser: "flipwatch", device: "flipwatch" },
          });
          break;
        }
        case 11:
          acked = true;
          break;
        case 1:
          send(1, seq);
          break;
        case 7: // reconnect requested
        case 9: // invalid session
          ws?.close(4000);
          break;
        case 0:
          if (payload.t) onDispatch(payload.t, (payload.d ?? {}) as Record<string, unknown>);
          break;
      }
    });
    ws.addEventListener("close", (event) => {
      clearTimers();
      ws = null;
      if (stopped) return;
      // 4004: bad token, 4013/4014: invalid/disallowed intents — retrying won't help.
      if ([4004, 4013, 4014].includes(event.code)) {
        log.error(`Discord bot: Discord refused the connection (${event.code} ${event.reason}); check the bot token`);
        setStatus({
          state: "error",
          message: event.code === 4004 ? "Discord rejected the bot token — copy it again from the Developer Portal (Bot → Reset Token)." : `Discord refused the connection (${event.code} ${event.reason}).`,
          applicationId: botApplicationId,
        });
        return;
      }
      setStatus({ state: "connecting", applicationId: botApplicationId });
      setTimeout(connect, backoffMs);
      backoffMs = Math.min(backoffMs * 2, 300_000);
    });
    ws.addEventListener("error", () => {
      // "close" follows and reconnects.
    });
  }

  void connect();
  const bot: DiscordBot = {
    stop() {
      stopped = true;
      clearTimers();
      ws?.close(1000);
      if (globalForBot.__flipwatchDiscordBot === bot) {
        globalForBot.__flipwatchDiscordBot = undefined;
        setStatus({ state: "off" });
      }
    },
  };
  globalForBot.__flipwatchDiscordBot = bot;
  return bot;
}
