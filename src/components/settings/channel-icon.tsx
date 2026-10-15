import { Bell, BellRing, Hash, Mail, MessageSquare, MonitorSmartphone, Send, Smartphone, Webhook, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";

const ICONS: Record<string, LucideIcon> = {
  ntfy: Smartphone,
  discord: MessageSquare,
  discord_bot: MessageSquare,
  slack: Hash,
  telegram: Send,
  pushover: BellRing,
  email: Mail,
  webpush: MonitorSmartphone,
  webhook: Webhook,
};

export function ChannelIcon({ type, className }: { type: string; className?: string }) {
  const Icon = ICONS[type] ?? Bell;
  return (
    <span className={cn("grid size-9 shrink-0 place-items-center rounded-lg bg-surface-2 text-muted", className)}>
      <Icon className="size-4" />
    </span>
  );
}
