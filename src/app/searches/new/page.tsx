import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { POLL_INTERVALS, defaultFormValues, prefillFromSearchParams } from "@/components/searches/form-values";
import { SearchForm } from "@/components/searches/search-form";
import { PageHeader } from "@/components/ui/page-header";
import { getDb } from "@/lib/db";
import { getDefaultLocation } from "@/lib/queries/settings";
import { loadEditorOptions } from "../editor-data";

export const metadata: Metadata = { title: "New search" };

export default async function NewSearchPage(props: PageProps<"/searches/new">) {
  const db = await getDb();
  const [params, location, options] = await Promise.all([props.searchParams, getDefaultLocation(db), loadEditorOptions(db)]);

  // Preselect marketplaces that work right now and serve the default location.
  const available = options.marketplaces.filter((m) => m.ok && m.countries.includes(location.countryCode)).map((m) => m.id);
  // Default to every 2 minutes, or the first interval the server allows when its floor is higher.
  const floor = Math.max(120, options.minPollIntervalSec);
  const pollIntervalSec = String(POLL_INTERVALS.find((o) => o.value >= floor)?.value ?? floor);
  const initialValues = { ...defaultFormValues(location, available), pollIntervalSec, ...prefillFromSearchParams(params) };

  return (
    <>
      <Link href="/searches" className="mb-3 inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
        <ArrowLeft className="size-4" />
        Searches
      </Link>
      <PageHeader title="New search" description="Tell FlipWatch what to watch for. You can test it before saving." />
      <SearchForm searchId={null} initialValues={initialValues} {...options} />
    </>
  );
}
