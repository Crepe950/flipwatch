import { AlarmClock, CalendarClock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { FollowUpState } from "@/lib/deals";

export function FollowUpBadge({ state, label }: { state: FollowUpState; label: string }) {
  if (state === "overdue") {
    return (
      <Badge tone="red" title={`Follow-up was due ${label}`}>
        <AlarmClock className="size-3" aria-hidden />
        Overdue · {label}
      </Badge>
    );
  }
  if (state === "today") {
    return (
      <Badge tone="amber" title="Follow up today">
        <AlarmClock className="size-3" aria-hidden />
        Follow up today
      </Badge>
    );
  }
  return (
    <Badge title={`Follow up on ${label}`}>
      <CalendarClock className="size-3" aria-hidden />
      {label}
    </Badge>
  );
}
