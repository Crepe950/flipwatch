import type { Metadata } from "next";
import Link from "next/link";
import { Plus } from "lucide-react";
import { EmptySearches } from "@/components/searches/empty-searches";
import { SearchCard } from "@/components/searches/search-card";
import { Toaster } from "@/components/searches/toaster";
import { buttonClasses } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { getDb } from "@/lib/db";
import { ebayConfigured } from "@/lib/engine";
import { listSearchesWithStats } from "@/lib/queries/searches";
import { skipReasonsFor } from "./editor-data";

export const metadata: Metadata = { title: "Searches" };

export default async function SearchesPage() {
  const searches = await listSearchesWithStats(await getDb());
  const active = searches.filter((s) => s.enabled).length;
  const paused = searches.length - active;
  // eBay's daily API quota is shared by the enabled searches that poll it (once eBay is set up).
  const ebaySearches = ebayConfigured() ? searches.filter((s) => s.enabled && s.marketplaces.includes("ebay")).length : null;

  return (
    <>
      <PageHeader
        title="Searches"
        description={
          searches.length
            ? `${active} active${paused ? ` · ${paused} paused` : ""} — each one is polled on its own schedule.`
            : "Saved searches FlipWatch polls for new listings and price drops."
        }
        actions={
          searches.length ? (
            <Link href="/searches/new" className={buttonClasses()}>
              <Plus className="size-4" />
              New search
            </Link>
          ) : null
        }
      />
      {searches.length ? (
        <ul className="space-y-3">
          {searches.map((search) => (
            <SearchCard key={search.id} search={search} skipReasons={skipReasonsFor(search.location.countryCode)} ebaySearches={ebaySearches} />
          ))}
        </ul>
      ) : (
        <EmptySearches />
      )}
      <Toaster />
    </>
  );
}
