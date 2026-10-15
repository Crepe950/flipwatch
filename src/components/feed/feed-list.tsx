"use client";

import Link from "next/link";
import {
  startTransition,
  useEffect,
  useEffectEvent,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { ArrowUp, CheckCheck, Loader2, LogIn, Volume2, VolumeX, WifiOff, X } from "lucide-react";
import { describeActionError, signInHref } from "@/components/ui/action-failure";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import type { FeedApiResponse, FeedItem } from "@/lib/queries/feed";
import {
  addToPipelineAction,
  markAllSeenAction,
  markMatchSeenAction,
  setMatchDismissedAction,
  type ActionResult,
} from "./actions";
import { getSoundServerSnapshot, getSoundSnapshot, playChime, subscribeSound, unlockAudio, writeSoundEnabled } from "./alert-sound";
import {
  eventKey,
  feedReducer,
  nextConnection,
  ONLINE,
  pendingLabel,
  POLL_PAGE_SIZE,
  pollSince,
  readNewEvents,
  unknownEvents,
  type Connection,
} from "./feed-state";
import { MatchCard } from "./match-card";

const POLL_MS = 10_000;
/** Within this many px of the top, new deals are shown immediately instead of behind the pill. */
const AUTO_REVEAL_PX = 120;
const NOTICE_MS = 5_000;
const TITLE_BADGE = /^\(\d+\+?\)\s+/;

interface Notice {
  id: number;
  message: string;
  tone: "info" | "error";
  action?: { label: string; onClick: () => void } | { label: string; href: string };
}

/** A non-2xx answer from /api/feed. */
class FeedHttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

async function readFeed(url: string): Promise<FeedApiResponse> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new FeedHttpError(res.status);
  return (await res.json()) as FeedApiResponse;
}

const isUnauthorized = (error: unknown) => error instanceof FeedHttpError && error.status === 401;

export function FeedList({
  initialItems,
  initialCursor,
  initialUnseen,
  queryString,
  includeDismissed,
  generatedAt,
  emptyState,
}: {
  initialItems: FeedItem[];
  initialCursor: string | null;
  initialUnseen: number;
  /** Canonical filter query string; the component is keyed on it so filters reset its state. */
  queryString: string;
  includeDismissed: boolean;
  generatedAt: string;
  emptyState: ReactNode;
}) {
  const [state, dispatch] = useReducer(feedReducer, { items: initialItems, pending: [] });
  const [cursor, setCursor] = useState(initialCursor);
  const [unseen, setUnseen] = useState(initialUnseen);
  const [loadingMore, setLoadingMore] = useState(false);
  const [busy, setBusy] = useState<ReadonlySet<number>>(new Set());
  const [notice, setNotice] = useState<Notice | null>(null);
  const [connection, setConnection] = useState<Connection>(ONLINE);
  const soundOn = useSyncExternalStore(subscribeSound, getSoundSnapshot, getSoundServerSnapshot);
  const polling = useRef(false);
  const noticeSeq = useRef(0);
  /** Events dismissed here whose server update may not have landed before the next poll. */
  const dismissedEvents = useRef(new Set<string>());
  /** A poll hit the page limit; asked the user to refresh once. */
  const overflowNotified = useRef(false);
  const feedHref = queryString ? `/?${queryString}` : "/";

  function notify(message: string, tone: Notice["tone"] = "info", action?: Notice["action"]) {
    noticeSeq.current += 1;
    setNotice({ id: noticeSeq.current, message, tone, action });
  }

  function apiUrl(extra: Record<string, string>): string {
    const params = new URLSearchParams(queryString);
    for (const [k, v] of Object.entries(extra)) params.set(k, v);
    return `/api/feed?${params.toString()}`;
  }

  // --- Live updates ---------------------------------------------------------------------------

  const poll = useEffectEvent(async () => {
    if (document.hidden || polling.current) return;
    polling.current = true;
    try {
      const since = pollSince(state, Date.parse(generatedAt));
      const result = await readNewEvents((cursor) =>
        readFeed(apiUrl({ since, limit: String(POLL_PAGE_SIZE), ...(cursor ? { cursor } : {}) })),
      );
      setConnection((c) => nextConnection(c, "ok"));
      setUnseen(result.unseenCount);
      if (result.truncated && !overflowNotified.current) {
        overflowNotified.current = true;
        notify("Lots of new deals arrived at once — refresh to see them all.", "info", {
          label: "Refresh",
          onClick: () => window.location.reload(),
        });
      }
      const fresh = unknownEvents(state, result.items).filter((i) => !dismissedEvents.current.has(eventKey(i)));
      if (fresh.length === 0) return;
      if (soundOn && fresh.some((i) => !i.silent && !i.seen)) playChime();
      dispatch({ type: "received", fresh, reveal: window.scrollY < AUTO_REVEAL_PX });
    } catch (error) {
      // Signed out, offline or the server is restarting: keep polling, the banner says why.
      setConnection((c) => nextConnection(c, isUnauthorized(error) ? "unauthorized" : "failed"));
    } finally {
      polling.current = false;
    }
  });

  useEffect(() => {
    const timer = window.setInterval(() => void poll(), POLL_MS);
    const onVisibility = () => {
      if (document.visibilityState === "visible") void poll();
    };
    const onOnline = () => void poll();
    const onOffline = () => setConnection((c) => nextConnection(c, "offline"));
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  // Unseen badge in the tab title. Next rewrites <title> from metadata on every server render
  // (e.g. after an action revalidates), so re-apply the badge whenever the head changes.
  useEffect(() => {
    const apply = () => {
      const base = document.title.replace(TITLE_BADGE, "");
      const next = unseen > 0 ? `(${unseen > 99 ? "99+" : unseen}) ${base}` : base;
      if (document.title !== next) document.title = next;
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.head, { subtree: true, childList: true, characterData: true });
    return () => observer.disconnect();
  }, [unseen]);

  useEffect(() => {
    return () => {
      document.title = document.title.replace(TITLE_BADGE, "");
    };
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice((n) => (n?.id === notice.id ? null : n)), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  function showPending() {
    dispatch({ type: "reveal" });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // --- Pagination -----------------------------------------------------------------------------

  async function loadMore() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const data = await readFeed(apiUrl({ cursor }));
      dispatch({ type: "appended", items: data.items });
      setCursor(data.nextCursor);
      setUnseen(data.unseenCount);
    } catch (error) {
      if (isUnauthorized(error)) {
        setConnection((c) => nextConnection(c, "unauthorized"));
        notify("Couldn't load more deals: your session expired.", "error", { label: "Sign in", href: signInHref(feedHref) });
      } else {
        notify("Couldn't load more deals. Check your connection and try again.", "error");
      }
    } finally {
      setLoadingMore(false);
    }
  }

  // --- Card actions (optimistic) --------------------------------------------------------------

  const countsAsUnseen = (item: FeedItem) => !item.seen && !item.silent && !item.dismissed;

  /**
   * Run a card action. When it fails, whether the server said no or the request never got an
   * answer (offline, session expired), `rollback` undoes the optimistic change and a notice says why.
   */
  function runAction<R extends ActionResult>(
    call: () => Promise<R>,
    fallback: string,
    { rollback, done, settled }: { rollback?: () => void; done?: (result: Extract<R, { ok: true }>) => void; settled?: () => void },
  ) {
    startTransition(async () => {
      try {
        const res = await call();
        if (res.ok) {
          done?.(res as Extract<R, { ok: true }>);
        } else {
          rollback?.();
          notify(res.error, "error");
        }
      } catch (error) {
        rollback?.();
        const failure = await describeActionError(error, fallback);
        if (failure.signInHref) setConnection((c) => nextConnection(c, "unauthorized"));
        notify(failure.message, "error", failure.signInHref ? { label: "Sign in", href: signInHref(feedHref) } : undefined);
      } finally {
        settled?.();
      }
    });
  }

  function markSeen(item: FeedItem) {
    if (item.seen) return;
    dispatch({ type: "patched", matchIds: [item.matchId], patch: { seen: true } });
    if (countsAsUnseen(item)) setUnseen((n) => Math.max(0, n - 1));
    runAction(() => markMatchSeenAction(item.matchId), "Couldn't mark the deal as seen", {
      rollback: () => {
        dispatch({ type: "patched", matchIds: [item.matchId], patch: { seen: false } });
        if (countsAsUnseen(item)) setUnseen((n) => n + 1);
      },
    });
  }

  function markAllSeen() {
    // Exactly what the server marks: the unseen alerts that pass this feed's filters.
    const ids = [...state.items, ...state.pending].filter(countsAsUnseen).map((i) => i.matchId);
    const previousUnseen = unseen;
    dispatch({ type: "patched", matchIds: ids, patch: { seen: true } });
    setUnseen(0);
    runAction(() => markAllSeenAction(queryString), "Couldn't mark the deals as seen", {
      rollback: () => {
        dispatch({ type: "patched", matchIds: ids, patch: { seen: false } });
        setUnseen(previousUnseen);
      },
    });
  }

  function restore(item: FeedItem, index: number) {
    dismissedEvents.current.delete(eventKey(item));
    const restored = { ...item, dismissed: false };
    const unseenAgain = !item.seen && !item.silent;
    if (includeDismissed) dispatch({ type: "patched", matchIds: [item.matchId], patch: { dismissed: false } });
    else dispatch({ type: "restored", item: restored, index });
    if (unseenAgain) setUnseen((n) => n + 1);
    runAction(() => setMatchDismissedAction(item.matchId, false), "Couldn't restore the deal", {
      rollback: () => {
        dismissedEvents.current.add(eventKey(item));
        if (includeDismissed) dispatch({ type: "patched", matchIds: [item.matchId], patch: { dismissed: true } });
        else dispatch({ type: "removed", matchId: item.matchId });
        if (unseenAgain) setUnseen((n) => Math.max(0, n - 1));
      },
    });
  }

  function dismiss(item: FeedItem) {
    const index = state.items.findIndex((i) => i.matchId === item.matchId);
    dismissedEvents.current.add(eventKey(item));
    if (includeDismissed) dispatch({ type: "patched", matchIds: [item.matchId], patch: { dismissed: true } });
    else dispatch({ type: "removed", matchId: item.matchId });
    if (countsAsUnseen(item)) setUnseen((n) => Math.max(0, n - 1));
    notify("Deal dismissed", "info", { label: "Undo", onClick: () => restore(item, index) });
    runAction(() => setMatchDismissedAction(item.matchId, true), "Couldn't dismiss the deal", {
      rollback: () => {
        dismissedEvents.current.delete(eventKey(item));
        if (includeDismissed) dispatch({ type: "patched", matchIds: [item.matchId], patch: { dismissed: false } });
        else dispatch({ type: "restored", item, index });
        if (countsAsUnseen(item)) setUnseen((n) => n + 1);
      },
    });
  }

  function addToPipeline(item: FeedItem) {
    setBusy((s) => new Set(s).add(item.matchId));
    runAction(() => addToPipelineAction(item.listingId), "Couldn't add the deal to your pipeline", {
      done: (res) => {
        dispatch({ type: "patchedListing", listingId: item.listingId, patch: { dealId: res.dealId, dealStage: res.stage } });
        notify(res.created ? "Added to your pipeline as a lead" : "Already in your pipeline", "info", {
          label: "View",
          href: `/pipeline/${res.dealId}`,
        });
      },
      settled: () =>
        setBusy((s) => {
          const next = new Set(s);
          next.delete(item.matchId);
          return next;
        }),
    });
  }

  function toggleSound() {
    if (!soundOn) {
      unlockAudio();
      playChime();
    }
    writeSoundEnabled(!soundOn);
  }

  const handlers = { onDismiss: dismiss, onRestore: (i: FeedItem) => restore(i, 0), onSeen: markSeen, onAddToPipeline: addToPipeline };
  const pendingCount = state.pending.length;
  const pendingText = pendingLabel(state.pending);
  const empty = state.items.length === 0 && pendingCount === 0;

  return (
    <section aria-label="Deal feed" className="relative">
      <div className="mb-3 flex items-center gap-2">
        <p className="text-sm text-muted" aria-live="polite">
          {unseen > 0 ? (
            <>
              <span className="font-semibold text-fg">{unseen}</span> unseen
            </>
          ) : (
            "All caught up"
          )}
        </p>
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={toggleSound}
            aria-pressed={soundOn}
            title={soundOn ? "Sound on for new deals" : "Sound off"}
          >
            {soundOn ? <Volume2 className="size-4" aria-hidden /> : <VolumeX className="size-4" aria-hidden />}
            <span className="max-sm:sr-only">Sound</span>
          </Button>
          <Button variant="ghost" size="sm" onClick={markAllSeen} disabled={unseen === 0 && !state.items.some(countsAsUnseen)}>
            <CheckCheck className="size-4" aria-hidden />
            <span className="max-sm:sr-only">Mark all seen</span>
          </Button>
        </div>
      </div>

      {connection.status === "expired" ? (
        <div
          role="alert"
          className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger"
        >
          <LogIn className="size-4 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">Session expired — sign in again to keep the feed live.</span>
          <a href={signInHref(feedHref)} className="font-semibold underline underline-offset-2">
            Sign in
          </a>
        </div>
      ) : connection.status === "offline" ? (
        <div role="status" className="mb-3 flex items-center gap-2 rounded-xl border border-warn/30 bg-warn-soft px-3 py-2 text-sm text-warn">
          <WifiOff className="size-4 shrink-0" aria-hidden />
          <span>Offline — retrying…</span>
        </div>
      ) : null}

      {pendingCount > 0 ? (
        <div className="sticky top-3 z-20 flex h-0 justify-center">
          <button
            type="button"
            onClick={showPending}
            className="flex h-9 items-center gap-1.5 rounded-full bg-accent px-4 text-sm font-semibold text-accent-contrast shadow-lg transition-transform hover:scale-[1.03] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <ArrowUp className="size-4" aria-hidden />
            {pendingText}
          </button>
        </div>
      ) : null}
      <p className="sr-only" aria-live="polite">
        {pendingCount > 0 ? `${pendingText} available` : ""}
      </p>

      {empty ? (
        emptyState
      ) : (
        <ul className="grid gap-3 xl:grid-cols-2">
          {state.items.map((item) => (
            <li key={item.matchId} className="min-w-0">
              <MatchCard item={item} busy={busy.has(item.matchId)} {...handlers} />
            </li>
          ))}
        </ul>
      )}

      {cursor && !empty ? (
        <div className="mt-5 flex justify-center">
          <Button variant="secondary" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            {loadingMore ? "Loading…" : "Load more"}
          </Button>
        </div>
      ) : !empty && state.items.length > 0 ? (
        <p className="mt-6 text-center text-xs text-muted">That&apos;s every match for these filters.</p>
      ) : null}

      {notice ? (
        <div className="pointer-events-none fixed inset-x-0 bottom-20 z-40 flex justify-center px-4 md:bottom-6 md:pl-56">
          <div
            role={notice.tone === "error" ? "alert" : "status"}
            className={cn(
              "pointer-events-auto flex max-w-md items-center gap-3 rounded-xl border px-4 py-2.5 text-sm shadow-lg",
              notice.tone === "error" ? "border-danger/30 bg-danger-soft text-danger" : "border-border bg-surface text-fg",
            )}
          >
            <span className="min-w-0 flex-1">{notice.message}</span>
            {notice.action && "href" in notice.action ? (
              <Link href={notice.action.href} className="font-semibold text-accent hover:underline">
                {notice.action.label}
              </Link>
            ) : notice.action ? (
              <button
                type="button"
                className="font-semibold text-accent hover:underline"
                onClick={() => {
                  setNotice(null);
                  (notice.action as { onClick: () => void }).onClick();
                }}
              >
                {notice.action.label}
              </button>
            ) : null}
            <button type="button" onClick={() => setNotice(null)} className="text-muted hover:text-fg" aria-label="Close">
              <X className="size-4" aria-hidden />
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
