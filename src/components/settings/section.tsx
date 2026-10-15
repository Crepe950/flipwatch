import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Card } from "@/components/ui/card";

export const SETTINGS_SECTIONS = [
  { id: "channels", label: "Notifications" },
  { id: "marketplaces", label: "Marketplaces" },
  { id: "ai", label: "AI" },
  { id: "facebook", label: "Facebook" },
  { id: "ebay", label: "eBay" },
  { id: "discord", label: "Discord bot" },
  { id: "worker", label: "Worker" },
  { id: "defaults", label: "Area" },
  { id: "blocked", label: "Blocked sellers" },
  { id: "account", label: "Account" },
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];

/** Anchor nav; sticky under the top of the viewport while scrolling the settings page. */
export function SettingsNav() {
  return (
    <nav
      aria-label="Settings sections"
      className="sticky top-0 z-20 -mx-4 mb-4 overflow-x-auto border-b border-border bg-bg/90 px-4 py-2 backdrop-blur md:mx-0 md:rounded-xl md:border md:px-2"
    >
      <ul className="flex gap-1">
        {SETTINGS_SECTIONS.map((s) => (
          <li key={s.id}>
            <a
              href={`#${s.id}`}
              className="block rounded-lg px-3 py-1.5 text-sm font-medium whitespace-nowrap text-muted transition-colors hover:bg-surface-2 hover:text-fg"
            >
              {s.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function SettingsSection({
  id,
  icon: Icon,
  title,
  description,
  aside,
  children,
}: {
  id: SettingsSectionId;
  icon: LucideIcon;
  title: string;
  description?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-20">
      <Card>
        <div className="flex items-start gap-3 border-b border-border px-4 py-3.5">
          <div className="flex min-w-0 flex-1 items-start gap-3">
            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent">
              <Icon className="size-4" />
            </span>
            <div className="min-w-0">
              <h2 id={`${id}-title`} className="font-semibold">
                {title}
              </h2>
              {description ? <p className="mt-0.5 text-sm text-muted">{description}</p> : null}
            </div>
          </div>
          {aside ? <div className="shrink-0">{aside}</div> : null}
        </div>
        <div className="px-4 py-4">{children}</div>
      </Card>
    </section>
  );
}
