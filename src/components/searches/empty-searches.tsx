import Link from "next/link";
import { ArrowRight, Plus, Radar } from "lucide-react";
import { buttonClasses } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { SEARCH_TEMPLATES, templateHref } from "./templates";

export function EmptySearches() {
  return (
    <div className="space-y-6">
      <EmptyState
        icon={<Radar className="size-8" />}
        title="Create your first search"
        description="A search watches Craigslist, Kijiji, eBay and more for the items you flip, and alerts you the moment a good deal is posted."
        action={
          <Link href="/searches/new" className={buttonClasses()}>
            <Plus className="size-4" />
            New search
          </Link>
        }
      />
      <section aria-labelledby="templates-heading">
        <h2 id="templates-heading" className="mb-3 text-sm font-semibold text-muted">
          Or start from a template
        </h2>
        <ul className="grid gap-3 sm:grid-cols-3">
          {SEARCH_TEMPLATES.map((template) => (
            <li key={template.id}>
              <Link
                href={templateHref(template)}
                className="group flex h-full flex-col rounded-xl border border-border bg-surface p-4 transition-colors hover:border-accent hover:bg-accent-soft/40"
              >
                <span className="font-medium">{template.title}</span>
                <span className="mt-1 flex-1 text-sm text-muted">{template.description}</span>
                <span className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-accent">
                  Use template <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
