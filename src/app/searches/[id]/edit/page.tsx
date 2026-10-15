import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Info } from "lucide-react";
import { searchToFormValues } from "@/components/searches/form-values";
import { SearchForm } from "@/components/searches/search-form";
import { PageHeader } from "@/components/ui/page-header";
import { TimeAgo } from "@/components/ui/time-ago";
import { getDb } from "@/lib/db";
import { getSearch, parseSearchId } from "@/lib/queries/searches";
import { loadEditorOptions } from "../../editor-data";

export const metadata: Metadata = { title: "Edit search" };

export default async function EditSearchPage(props: PageProps<"/searches/[id]/edit">) {
  const [{ id: rawId }, params] = await Promise.all([props.params, props.searchParams]);
  const id = parseSearchId(rawId);
  if (!id) notFound();

  const db = await getDb();
  const [search, options] = await Promise.all([getSearch(db, id), loadEditorOptions(db, id)]);
  if (!search) notFound();

  // Drop ids of deleted channels so "none selected = all channels" in the form matches what gets saved.
  const channelIds = new Set(options.channels.map((c) => c.id));
  const values = searchToFormValues(search);
  const initialValues = { ...values, notifyChannelIds: values.notifyChannelIds.filter((channelId) => channelIds.has(channelId)) };

  return (
    <>
      <Link href="/searches" className="mb-3 inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
        <ArrowLeft className="size-4" />
        Searches
      </Link>
      <PageHeader
        title={`Edit “${search.name}”`}
        description={
          search.lastRunAt ? (
            <>
              Last run <TimeAgo date={search.lastRunAt} />. Saving schedules the next run right away.
            </>
          ) : (
            "Saving schedules the next run right away."
          )
        }
      />
      {params.duplicated ? (
        <p className="mb-4 flex items-start gap-2 rounded-xl bg-info-soft px-4 py-3 text-sm text-info">
          <Info className="mt-0.5 size-4 shrink-0" />
          This is a paused copy. Adjust it, switch it to Active and save.
        </p>
      ) : null}
      <SearchForm key={search.id} searchId={search.id} initialValues={initialValues} {...options} />
    </>
  );
}
