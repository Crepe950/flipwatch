"use client";

import { useState, useTransition } from "react";
import { CircleCheck, LoaderCircle, Trash2 } from "lucide-react";
import { removeFacebookAccountAction, updateFacebookAccountsAction } from "@/app/setup/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import type { PublicFacebookAccount, PublicRuntimeSettings } from "@/lib/runtime-settings";

function connectedAgo(iso: string | null): string {
  if (!iso) return "";
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  return days <= 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
}

interface Draft {
  name: string;
  share: string;
}

const draftsFor = (accounts: PublicFacebookAccount[]) =>
  Object.fromEntries(accounts.map((a) => [a.id, { name: a.name ?? "", share: a.share === null ? "" : String(a.share) }])) as Record<string, Draft>;

/**
 * The connected accounts: rename them, set how searches are split between them, or remove one.
 * Remount (via `key`) when the account list changes so the drafts start from the saved values.
 */
export function FacebookAccounts({
  accounts,
  disabled,
  onSaved,
}: {
  accounts: PublicFacebookAccount[];
  disabled: boolean;
  onSaved: (settings: PublicRuntimeSettings) => void;
}) {
  const [drafts, setDrafts] = useState(() => draftsFor(accounts));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, start] = useTransition();
  const multiple = accounts.length > 1;

  const dirty = accounts.some((a) => {
    const d = drafts[a.id];
    return d && (d.name.trim() !== (a.name ?? "") || d.share.trim() !== (a.share === null ? "" : String(a.share)));
  });

  // Preview of the split as typed: blank shares get the average of the others, like the server does.
  const typed = accounts.map((a) => Number.parseInt(drafts[a.id]?.share ?? "", 10));
  const valid = typed.filter((n) => Number.isFinite(n) && n > 0);
  const fallback = valid.length ? valid.reduce((x, y) => x + y, 0) / valid.length : 1;
  const filled = typed.map((n) => (Number.isFinite(n) && n > 0 ? n : fallback));
  const total = filled.reduce((x, y) => x + y, 0) || 1;

  function edit(id: string, patch: Partial<Draft>) {
    setSaved(false);
    setDrafts((d) => ({ ...d, [id]: { ...d[id], ...patch } }));
  }

  function save() {
    setError(null);
    start(async () => {
      const result = await updateFacebookAccountsAction(
        accounts.map((a) => ({ id: a.id, name: drafts[a.id]?.name ?? "", share: drafts[a.id]?.share.trim() ?? "" })),
      );
      if (!result.ok || !result.settings) return setError(result.error ?? "Couldn't save.");
      setSaved(true);
      onSaved(result.settings);
    });
  }

  function remove(account: PublicFacebookAccount) {
    if (!window.confirm(`Remove ${account.label}? FlipWatch forgets its session; you can connect it again later.`)) return;
    setError(null);
    start(async () => {
      const result = await removeFacebookAccountAction(account.id);
      if (!result.ok || !result.settings) return setError(result.error ?? "Couldn't remove it.");
      onSaved(result.settings);
    });
  }

  return (
    <div className="space-y-2">
      <ul className="divide-y divide-border rounded-xl border border-border">
        {accounts.map((a, i) => (
          <li key={a.id} className="flex flex-wrap items-end gap-3 p-3">
            <div className="min-w-40 flex-1 space-y-1">
              <label htmlFor={`fb-name-${a.id}`} className="text-xs text-muted">
                Name
              </label>
              <Input
                id={`fb-name-${a.id}`}
                value={drafts[a.id]?.name ?? ""}
                placeholder={`Account ${i + 1}`}
                maxLength={60}
                onChange={(e) => edit(a.id, { name: e.target.value })}
              />
              <p className="text-xs text-muted">
                {a.userIdHint ? `Facebook ID ending ${a.userIdHint}` : "Facebook account"}
                {a.connectedAt ? ` · connected ${connectedAgo(a.connectedAt)}` : ""}
              </p>
            </div>
            {multiple ? (
              <div className="w-28 space-y-1">
                <label htmlFor={`fb-share-${a.id}`} className="text-xs text-muted">
                  Share
                </label>
                <Input
                  id={`fb-share-${a.id}`}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={100}
                  placeholder="equal"
                  value={drafts[a.id]?.share ?? ""}
                  onChange={(e) => edit(a.id, { share: e.target.value })}
                />
                <p className="text-xs text-muted">{Math.round((filled[i] / total) * 100)}% of searches</p>
              </div>
            ) : null}
            <Button type="button" variant="ghost" size="sm" onClick={() => remove(a)} disabled={disabled || pending} aria-label={`Remove ${a.label}`}>
              <Trash2 className="size-4" /> Remove
            </Button>
          </li>
        ))}
      </ul>
      {multiple ? (
        <p className="text-xs text-muted">
          Each Facebook search runs on one account, picked so the split above holds over the hour. The hourly request limit is
          shared between the accounts by the same split, and if Facebook rate-limits one, the others carry on.
        </p>
      ) : null}
      {dirty || saved ? (
        <div className="flex items-center gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={save} disabled={!dirty || disabled || pending}>
            {pending ? <LoaderCircle className="size-4 animate-spin" /> : null}
            Save names{multiple ? " & split" : ""}
          </Button>
          {saved && !dirty ? (
            <span className="flex items-center gap-1 text-xs text-accent">
              <CircleCheck className="size-3.5" /> Saved
            </span>
          ) : null}
        </div>
      ) : null}
      {error ? <p role="alert" className="text-danger">{error}</p> : null}
    </div>
  );
}
