import Link from "next/link";
import { BellRing, Radar, SearchX } from "lucide-react";
import { buttonClasses } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

const addChannel = (
  <Link href="/settings" className={buttonClasses("secondary", "md")}>
    <BellRing className="size-4" aria-hidden />
    Add an alert channel
  </Link>
);

/** What to show when the feed has no cards, depending on why. */
export function FeedEmpty({
  totalSearches,
  activeSearches,
  enabledChannels,
  filtered,
}: {
  totalSearches: number;
  activeSearches: number;
  enabledChannels: number;
  filtered: boolean;
}) {
  if (filtered) {
    return (
      <EmptyState
        icon={<SearchX className="size-8" aria-hidden />}
        title="Nothing matches these filters"
        description="Try a lower deal score, another marketplace or include dismissed and quiet matches."
        action={
          <Link href="/" className={buttonClasses("secondary", "md")}>
            Clear filters
          </Link>
        }
      />
    );
  }

  if (totalSearches === 0) {
    return (
      <EmptyState
        icon={<Radar className="size-8" aria-hidden />}
        title="Create your first search"
        description="Tell FlipWatch what you flip — say “PS5 under $400 near Vancouver” — and new listings from Craigslist, Kijiji, eBay and more land here within minutes."
        action={
          <div className="flex flex-wrap justify-center gap-2">
            <Link href="/searches/new" className={buttonClasses("primary", "md")}>
              <Radar className="size-4" aria-hidden />
              New search
            </Link>
            {enabledChannels === 0 ? addChannel : null}
          </div>
        }
      />
    );
  }

  return (
    <EmptyState
      icon={<Radar className="size-8" aria-hidden />}
      title="No deals yet"
      description={
        activeSearches > 0
          ? `Watching ${activeSearches} ${activeSearches === 1 ? "search" : "searches"}. New matches appear here automatically — keep this tab open or get alerts on your phone.`
          : "All your searches are paused. Resume one to start getting matches."
      }
      action={
        <div className="flex flex-wrap justify-center gap-2">
          <Link href="/searches" className={buttonClasses("secondary", "md")}>
            Manage searches
          </Link>
          {enabledChannels === 0 ? addChannel : null}
        </div>
      }
    />
  );
}
