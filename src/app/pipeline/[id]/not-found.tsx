import Link from "next/link";
import { KanbanSquare } from "lucide-react";
import { buttonClasses } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

export default function DealNotFound() {
  return (
    <EmptyState
      icon={<KanbanSquare className="size-8" aria-hidden />}
      title="Deal not found"
      description="It may have been deleted."
      action={
        <Link href="/pipeline" className={buttonClasses("secondary", "md")}>
          Back to pipeline
        </Link>
      }
    />
  );
}
