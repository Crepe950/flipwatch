import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Plus } from "lucide-react";
import { FeedEmpty } from "@/components/feed/feed-empty";
import { FeedFilters } from "@/components/feed/feed-filters";
import { FeedList } from "@/components/feed/feed-list";
import { filtersToSearchParams, hasActiveFilters, parseFeedQueryLenient, queryToFilters } from "@/components/feed/filter-params";
import { StatsStrip } from "@/components/feed/stats-strip";
import { buttonClasses } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { config } from "@/lib/config";
import { getDb } from "@/lib/db";
import { countUnseen, getFeedPage, getFeedStats, listSearchOptions } from "@/lib/queries/feed";
import { runtimeSettings } from "@/lib/runtime-settings";

// The root layout's title template only applies to child segments, so spell it out here.
export const metadata: Metadata = { title: { absolute: "Deals · FlipWatch" } };

export default async function FeedPage({ searchParams }: PageProps<"/">) {
  const filters = queryToFilters(parseFeedQueryLenient(await searchParams));
  const db = await getDb();
  // First run: set up the AI engine, area and (optionally) Facebook before showing an empty feed.
  if (!runtimeSettings().setupDone) redirect("/setup");
  const now = new Date();
  const [page, unseen, stats, searches] = await Promise.all([
    getFeedPage(db, filters),
    countUnseen(db, filters),
    getFeedStats(db, { now, workerMode: config.workerMode }),
    listSearchOptions(db),
  ]);
  const queryString = filtersToSearchParams(filters).toString();

  return (
    <>
      <PageHeader
        title="Deals"
        description="Fresh matches and price drops from your searches, live."
        actions={
          <Link href="/searches/new" className={buttonClasses("secondary", "sm")}>
            <Plus className="size-4" aria-hidden />
            New search
          </Link>
        }
      />
      <StatsStrip stats={stats} />
      <FeedFilters filters={filters} searches={searches}>
        <FeedList
          key={queryString}
          initialItems={page.items}
          initialCursor={page.nextCursor}
          initialUnseen={unseen}
          queryString={queryString}
          includeDismissed={filters.includeDismissed}
          generatedAt={now.toISOString()}
          emptyState={
            <FeedEmpty
              totalSearches={stats.totalSearches}
              activeSearches={stats.activeSearches}
              enabledChannels={stats.enabledChannels}
              filtered={hasActiveFilters(filters)}
            />
          }
        />
      </FeedFilters>
    </>
  );
}
