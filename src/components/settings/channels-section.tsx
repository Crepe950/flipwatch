import { Bell } from "lucide-react";
import type { ChannelView } from "@/app/settings/channel-config";
import { ChannelAdder } from "./channel-adder";
import { ChannelRow } from "./channel-row";
import { SettingsSection } from "./section";
import type { WebPushInfo } from "./web-push-controls";

export function ChannelsSection({
  channels,
  webPush,
  smtpConfigured,
}: {
  channels: ChannelView[];
  webPush: WebPushInfo;
  /** SMTP_URL is set, so email channels can deliver. */
  smtpConfigured: boolean;
}) {
  const enabled = channels.filter((c) => c.enabled).length;
  return (
    <SettingsSection
      id="channels"
      icon={Bell}
      title="Notification channels"
      description={
        channels.length
          ? `${enabled} of ${channels.length} enabled. Searches notify every enabled channel unless they pick specific ones.`
          : "Where FlipWatch sends instant alerts for new deals and price drops."
      }
    >
      {channels.length ? (
        <ul className="mb-4 divide-y divide-border">
          {channels.map((channel) => (
            <ChannelRow key={channel.id} channel={channel} webPush={webPush} smtpConfigured={smtpConfigured} />
          ))}
        </ul>
      ) : (
        <p className="mb-4 text-sm text-muted">No channels yet. ntfy is the quickest start: install the app, pick a topic name, done.</p>
      )}
      <ChannelAdder webPush={webPush} smtpConfigured={smtpConfigured} startOpen={channels.length === 0} />
    </SettingsSection>
  );
}
