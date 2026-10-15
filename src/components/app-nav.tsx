"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bell, KanbanSquare, Radar, Settings, Sparkles } from "lucide-react";
import { cn } from "@/lib/cn";

const LINKS = [
  { href: "/", label: "Feed", icon: Bell, match: (p: string) => p === "/" || p.startsWith("/listings") },
  { href: "/hunt", label: "Hunt", icon: Sparkles, match: (p: string) => p.startsWith("/hunt") },
  { href: "/searches", label: "Searches", icon: Radar, match: (p: string) => p.startsWith("/searches") },
  { href: "/pipeline", label: "Pipeline", icon: KanbanSquare, match: (p: string) => p.startsWith("/pipeline") },
  { href: "/settings", label: "Settings", icon: Settings, match: (p: string) => p.startsWith("/settings") },
];

export function AppNav() {
  const pathname = usePathname() ?? "/";
  if (pathname.startsWith("/login")) return null;
  return (
    <>
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-56 flex-col border-r border-border bg-surface px-3 py-4 md:flex">
        <Link href="/" className="mb-6 flex items-center gap-2 px-2 text-lg font-bold tracking-tight">
          <span className="grid size-7 place-items-center rounded-lg bg-accent text-accent-contrast">
            <Radar className="size-4" />
          </span>
          FlipWatch
        </Link>
        <nav className="flex flex-col gap-1">
          {LINKS.map(({ href, label, icon: Icon, match }) => (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors",
                match(pathname) ? "bg-accent-soft text-accent" : "text-muted hover:bg-surface-2 hover:text-fg",
              )}
            >
              <Icon className="size-4" />
              {label}
            </Link>
          ))}
        </nav>
      </aside>

      {/* Mobile bottom tab bar */}
      <nav className="fixed inset-x-0 bottom-0 z-30 flex border-t border-border bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden">
        {LINKS.map(({ href, label, icon: Icon, match }) => (
          <Link
            key={href}
            href={href}
            className={cn(
              "flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] font-medium",
              match(pathname) ? "text-accent" : "text-muted",
            )}
          >
            <Icon className="size-5" />
            {label}
          </Link>
        ))}
      </nav>
    </>
  );
}
