import type { Metadata } from "next";
import { AccountSection } from "@/components/settings/account-section";
import { ChannelsSection } from "@/components/settings/channels-section";
import { BlockedSellersSection } from "@/components/settings/blocked-sellers-section";
import { MarketplacesSection, type MarketplaceStatusView } from "@/components/settings/marketplaces-section";
import { SettingsNav, SettingsSection } from "@/components/settings/section";
import { AiEngineForm } from "@/components/setup/ai-engine-form";
import { AreaPicker } from "@/components/setup/area-picker";
import { FacebookConnect } from "@/components/setup/facebook-connect";
import { Badge } from "@/components/ui/badge";
import { Bot, MapPin, ShoppingBag, Sparkles, Store } from "lucide-react";
import { DiscordBotForm } from "@/components/setup/discord-bot-form";
import { EbayKeysForm } from "@/components/setup/ebay-keys-form";
import { discordBotStatus, discordInviteUrl } from "@/lib/discord-bot";
import { publicRuntimeSettings } from "@/lib/runtime-settings";
import { loadArea } from "../setup/load-area";
import { WorkerSection } from "@/components/settings/worker-section";
import { PageHeader } from "@/components/ui/page-header";
import { config } from "@/lib/config";
import { getDb } from "@/lib/db";
import type { MarketplaceHealth } from "@/lib/db/schema";
import { listAdapters } from "@/lib/marketplaces/registry";
import { getVapidPublicKey } from "@/lib/notify";
import {
  getWorkerHeartbeat,
  heartbeatStatus,
  listChannels,
  listMarketplaceHealth,
  listRecentScrapeRuns,
} from "@/lib/queries/settings";
import { listBlockedSellers } from "@/lib/queries/blocked-sellers";
import { marketplaceOption, safeAiStatus } from "../searches/editor-data";
import { toChannelView } from "./channel-config";

export const metadata: Metadata = { title: "Settings" };

function healthView(row: MarketplaceHealth | undefined, now: Date): MarketplaceStatusView["health"] {
  if (!row) return null;
  const backoffMs = row.backoffUntil ? row.backoffUntil.getTime() - now.getTime() : 0;
  return {
    consecutiveFailures: row.consecutiveFailures,
    backoffMinutesLeft: backoffMs > 0 ? Math.ceil(backoffMs / 60_000) : 0,
    lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
    lastError: row.lastError,
    lastErrorAt: row.lastErrorAt?.toISOString() ?? null,
  };
}

function safeVapidPublicKey(): string | null {
  try {
    return getVapidPublicKey();
  } catch {
    return null;
  }
}

async function loadSettings() {
  const db = await getDb();
  const now = new Date();
  const [channels, health, runs, heartbeat, area, blocked] = await Promise.all([
    listChannels(db),
    listMarketplaceHealth(db),
    listRecentScrapeRuns(db, 50),
    getWorkerHeartbeat(db),
    loadArea(db),
    listBlockedSellers(db),
  ]);
  const healthById = new Map(health.map((h) => [h.marketplace, h]));
  const vapidPublicKey = safeVapidPublicKey();

  return {
    channels: channels.map(toChannelView),
    webPush: { vapidPublicKey, configured: Boolean(vapidPublicKey && config.vapidPrivateKey) },
    smtpConfigured: Boolean(config.smtpUrl),
    marketplaces: listAdapters().map((adapter) => ({ ...marketplaceOption(adapter), health: healthView(healthById.get(adapter.id), now) })),
    ai: safeAiStatus(),
    worker: {
      mode: config.workerMode,
      status: heartbeatStatus(heartbeat, config.workerMode, now),
      heartbeatAt: heartbeat?.at.toISOString() ?? null,
      pid: heartbeat?.pid,
      hostname: heartbeat?.hostname,
    },
    runs: runs.map((run) => ({
      id: run.id,
      startedAt: run.startedAt.toISOString(),
      searchId: run.searchId,
      searchName: run.searchName,
      marketplace: run.marketplace,
      resultCount: run.resultCount,
      newCount: run.newCount,
      priceDropCount: run.priceDropCount,
      durationMs: run.durationMs,
      error: run.error,
    })),
    area,
    runtime: publicRuntimeSettings(),
    discordBot: (() => {
      const status = discordBotStatus();
      const appId = "applicationId" in status ? status.applicationId : null;
      return { status, inviteUrl: appId ? discordInviteUrl(appId) : null, runsHere: config.workerMode === "inline" };
    })(),
    passwordEnabled: Boolean(config.appPassword),
    blocked: blocked.map((b) => ({ id: b.id, marketplace: b.marketplace, sellerName: b.sellerName, createdAt: b.createdAt.toISOString() })),
  };
}

export default async function SettingsPage() {
  const data = await loadSettings();
  return (
    <>
      <PageHeader title="Settings" description="Alerts, marketplaces, AI, and how FlipWatch runs." />
      <SettingsNav />
      <div className="space-y-5">
        <ChannelsSection channels={data.channels} webPush={data.webPush} smtpConfigured={data.smtpConfigured} />
        <MarketplacesSection marketplaces={data.marketplaces} />
        <SettingsSection
          id="ai"
          icon={Sparkles}
          title="AI engine"
          description="Estimates resale value, scores deals, runs Deal Hunts and drafts seller messages."
          aside={data.ai.configured ? <Badge tone="green">On</Badge> : <Badge>Off</Badge>}
        >
          <AiEngineForm initial={data.runtime} />
        </SettingsSection>
        <SettingsSection
          id="facebook"
          icon={Store}
          title="Facebook Marketplace"
          description="Optional. Searches Marketplace through your own logged-in Facebook session."
          aside={data.runtime.facebookConnected && data.runtime.facebookEnabled ? <Badge tone="green">Connected</Badge> : <Badge>Off</Badge>}
        >
          <FacebookConnect initial={data.runtime} />
        </SettingsSection>
        <SettingsSection
          id="ebay"
          icon={ShoppingBag}
          title="eBay"
          description="Optional. Search eBay listings and use them in price checks, through eBay's free official API."
          aside={data.runtime.ebayClientId && data.runtime.ebaySecret ? <Badge tone="green">Keys saved</Badge> : <Badge>Off</Badge>}
        >
          <EbayKeysForm initial={data.runtime} />
        </SettingsSection>
        <SettingsSection
          id="discord"
          icon={Bot}
          title="Discord bot"
          description="Optional. Manage searches and run Deal Hunts from Discord, and post alerts through the bot."
          aside={data.discordBot.status.state === "connected" ? <Badge tone="green">Connected</Badge> : <Badge>{data.runtime.discordToken ? "Not connected" : "Off"}</Badge>}
        >
          <DiscordBotForm initial={data.runtime} initialBot={data.discordBot} />
        </SettingsSection>
        <WorkerSection worker={data.worker} runs={data.runs} />
        <SettingsSection
          id="defaults"
          icon={MapPin}
          title="Your area"
          description="Where new searches, Deal Hunts and price checks look. Existing searches keep their own area."
        >
          <AreaPicker initial={data.area} />
        </SettingsSection>
        <BlockedSellersSection sellers={data.blocked} />
        <AccountSection passwordEnabled={data.passwordEnabled} />
      </div>
    </>
  );
}
