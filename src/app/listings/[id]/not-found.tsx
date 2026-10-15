import Link from "next/link";
import { SearchX } from "lucide-react";
import { buttonClasses } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

export default function ListingNotFound() {
  return (
    <EmptyState
      icon={<SearchX className="size-8" aria-hidden />}
      title="Listing not found"
      description="It may have been removed from FlipWatch, or the link is wrong."
      action={
        <Link href="/" className={buttonClasses("secondary", "md")}>
          Back to deals
        </Link>
      }
    />
  );
}
