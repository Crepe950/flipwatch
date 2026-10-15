"use client";

import { useEffect, useState, useTransition } from "react";
import { Bot, CircleCheck, ExternalLink, LoaderCircle, TriangleAlert } from "lucide-react";
import { discordBotStatusAction, removeDiscordBotAction, saveDiscordBotAction, type DiscordBotView } from "@/app/setup/actions";
import { Button, buttonClasses } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import type { PublicRuntimeSettings } from "@/lib/runtime-settings";

/** Discord bot token + who may use it, live connection status and the "add to server" link. */
export function DiscordBotForm({ initial, initialBot }: { initial: PublicRuntimeSettings; initialBot: DiscordBotView }) {
  const [settings, setSettings] = useState(initial);
  const [bot, setBot] = useState(initialBot);
  const [token, setToken] = useState("");
  const [allowed, setAllowed] = useState(initial.discordAllowedUserIds);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  // While the bot is (re)connecting, keep checking so the status turns into "Connected" or an error.
  useEffect(() => {
    if (bot.status.state !== "connecting") return;
    const timer = setInterval(async () => {
      const next = await discordBotStatusAction().catch(() => null);
      if (next) setBot(next);
    }, 1_500);
    return () => clearInterval(timer);
  }, [bot.status.state]);

  function save() {
    setError(null);
    start(async () => {
      const result = await saveDiscordBotAction({ token: token || undefined, allowedUserIds: allowed });
      if (!result.ok || !result.settings) return setError(result.error ?? "Couldn't save.");
      setSettings(result.settings);
      if (result.bot) setBot(result.bot);
      setToken("");
    });
  }

  function remove() {
    setError(null);
    start(async () => {
      const result = await removeDiscordBotAction();
      if (result.settings) setSettings(result.settings);
      if (result.bot) setBot(result.bot);
    });
  }

  const status = bot.status;
  return (
    <div className="space-y-4 text-sm">
      <p className="text-muted">
        Optional. A bot lets you manage searches and run Deal Hunts from Discord (<code>/search</code>, <code>/searches</code>,{" "}
        <code>/hunt</code>) and post alerts to a channel. For alerts only, a Discord webhook under Notifications is simpler.
      </p>
      {!settings.discordToken ? (
        <ol className="list-decimal space-y-1 pl-5 text-muted">
          <li>
            Open the{" "}
            <a href="https://discord.com/developers/applications" target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-accent underline">
              Discord Developer Portal <ExternalLink className="size-3" />
            </a>{" "}
            → New Application (name it e.g. “FlipWatch”).
          </li>
          <li>Go to Bot → Reset Token, and copy the token.</li>
          <li>Paste it below and save — then use “Add the bot to your server”.</li>
        </ol>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Bot token" htmlFor="discord-token" hint={settings.discordToken ? <>Saved: <code className="font-mono">{settings.discordToken}</code>. Paste a new one to replace it.</> : undefined}>
          <Input id="discord-token" type="password" spellCheck={false} autoComplete="off" placeholder={settings.discordToken ? "•••••••• (saved)" : "MTU…"} value={token} onChange={(e) => setToken(e.target.value)} className="font-mono" />
        </Field>
        <Field label="Who may use the commands (optional)" htmlFor="discord-users" hint="Discord user IDs, comma-separated. Empty = the server owner only. (Discord: Settings → Advanced → Developer Mode, then right-click a user → Copy User ID.)">
          <Input id="discord-users" spellCheck={false} placeholder="Server owner" value={allowed} onChange={(e) => setAllowed(e.target.value)} className="font-mono" />
        </Field>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" onClick={save} disabled={pending || (!token && allowed === settings.discordAllowedUserIds)}>
          {pending ? <LoaderCircle className="size-4 animate-spin" /> : <Bot className="size-4" />}
          {settings.discordToken ? "Save & restart bot" : "Save & start bot"}
        </Button>
        {bot.inviteUrl ? (
          <a href={bot.inviteUrl} target="_blank" rel="noreferrer" className={buttonClasses("secondary")}>
            Add the bot to your server <ExternalLink className="size-3.5" />
          </a>
        ) : null}
        {settings.discordToken ? (
          <Button type="button" variant="ghost" onClick={remove} disabled={pending}>
            Remove bot
          </Button>
        ) : null}
      </div>

      {status.state === "connected" ? (
        <p role="status" className="flex items-center gap-1.5 text-accent">
          <CircleCheck className="size-4" /> Connected as <span className="font-medium">{status.username}</span>. Its commands appear in every server it&apos;s in.
        </p>
      ) : status.state === "connecting" ? (
        <p className="flex items-center gap-1.5 text-muted">
          <LoaderCircle className="size-4 animate-spin" /> Connecting to Discord…
        </p>
      ) : status.state === "error" ? (
        <p role="alert" className="flex items-start gap-1.5 text-danger">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" /> {status.message}
        </p>
      ) : settings.discordToken && !bot.runsHere ? (
        <p className="text-muted">The bot runs in the separate worker process (WORKER_MODE=external): restart the worker to apply changes.</p>
      ) : null}
      {error ? <p role="alert" className="text-danger">{error}</p> : null}
      <p className="text-xs text-muted">The token is stored only on this computer. To get alerts in a channel, add a “Discord (FlipWatch bot)” channel under Notifications.</p>
    </div>
  );
}
