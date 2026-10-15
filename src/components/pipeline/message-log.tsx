import { Inbox, Send, Sparkles, StickyNote } from "lucide-react";
import { TimeAgo } from "@/components/ui/time-ago";
import { cn } from "@/lib/cn";
import type { DealMessage } from "@/lib/db/schema";

const DIRECTIONS = {
  out: { label: "You", icon: Send, bubble: "bg-accent-soft", align: "ml-6" },
  in: { label: "Seller", icon: Inbox, bubble: "bg-surface-2", align: "mr-6" },
  note: { label: "Note", icon: StickyNote, bubble: "border border-dashed border-border", align: "" },
} as const;

export function MessageLog({ messages }: { messages: DealMessage[] }) {
  if (messages.length === 0) {
    return <p className="text-sm text-muted">No messages yet. Log what you send, what the seller replies, or a private note.</p>;
  }
  return (
    <ol className="space-y-2.5">
      {messages.map((m) => {
        const d = DIRECTIONS[m.direction] ?? DIRECTIONS.note;
        const Icon = d.icon;
        return (
          <li key={m.id} className={cn("rounded-xl px-3 py-2", d.bubble, d.align)}>
            <div className="mb-1 flex items-center gap-1.5 text-xs text-muted">
              <Icon className="size-3.5" aria-hidden />
              <span className="font-medium text-fg">{d.label}</span>
              {m.aiGenerated ? (
                <span className="inline-flex items-center gap-0.5" title="Drafted with AI">
                  <Sparkles className="size-3" aria-hidden />
                  AI
                </span>
              ) : null}
              <TimeAgo date={m.createdAt} className="ml-auto" />
            </div>
            <p className="text-sm break-words whitespace-pre-wrap">{m.body}</p>
          </li>
        );
      })}
    </ol>
  );
}
