"use client";

import { useOptimistic, useState, useTransition } from "react";
import { CircleAlert, CircleCheck, LoaderCircle, Pencil, Send, Trash2 } from "lucide-react";
import { deleteChannelAction, setChannelEnabledAction, testChannelAction } from "@/app/settings/actions";
import type { ChannelView } from "@/app/settings/channel-config";
import { ConfirmButton } from "@/components/searches/confirm-button";
import { Switch } from "@/components/searches/switch";
import { ActionError } from "@/components/ui/action-error";
import { describeActionError, type ActionFailure } from "@/components/ui/action-failure";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TimeAgo } from "@/components/ui/time-ago";
import { getChannelType } from "@/lib/notify/channel-types";
import { ChannelFields, ChannelFormActions, FormMessage, SmtpWarning, useChannelForm } from "./channel-form";
import { ChannelIcon } from "./channel-icon";
import { WebPushControls, type WebPushInfo } from "./web-push-controls";

type TestResult = { ok: boolean; error?: string; signInHref?: string };

function TestButton({ id }: { id: number }) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<TestResult | null>(null);
  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setResult(null);
            try {
              setResult(await testChannelAction(id));
            } catch (err) {
              const failure = await describeActionError(err, "Couldn't send the test");
              setResult({ ok: false, error: failure.message, signInHref: failure.signInHref });
            }
          })
        }
      >
        {pending ? <LoaderCircle className="size-4 animate-spin" /> : <Send className="size-4" />}
        {pending ? "Sending…" : "Send test"}
      </Button>
      {result ? (
        <span
          role="status"
          className={result.ok ? "inline-flex items-center gap-1 text-sm text-accent" : "inline-flex min-w-0 items-start gap-1 text-sm text-danger"}
        >
          {result.ok ? <CircleCheck className="size-4 shrink-0" /> : <CircleAlert className="mt-0.5 size-4 shrink-0" />}
          <span className="break-words">
            {result.ok ? "Test sent" : result.error}
            {result.signInHref ? (
              <>
                {" "}
                <a href={result.signInHref} className="font-semibold underline underline-offset-2">
                  Sign in
                </a>
              </>
            ) : null}
          </span>
        </span>
      ) : null}
    </>
  );
}

export function ChannelRow({ channel, webPush, smtpConfigured }: { channel: ChannelView; webPush: WebPushInfo; smtpConfigured: boolean }) {
  const [enabled, setEnabled] = useOptimistic(channel.enabled);
  const [, startToggle] = useTransition();
  const [error, setError] = useState<ActionFailure | null>(null);
  const form = useChannelForm();
  const info = getChannelType(channel.type);

  return (
    <li className="py-4 first:pt-1 last:pb-1">
      <div className="flex items-start gap-3">
        <ChannelIcon type={channel.type} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate font-medium">{channel.name}</span>
            <Badge>{channel.typeLabel}</Badge>
            {!enabled ? <Badge tone="amber">Off</Badge> : null}
          </div>
          <p className="mt-0.5 flex flex-wrap gap-x-2 text-sm text-muted">
            {channel.summary ? <span className="truncate">{channel.summary}</span> : null}
            <span>
              {channel.lastSuccessAt ? (
                <>
                  Last delivered <TimeAgo date={channel.lastSuccessAt} />
                </>
              ) : (
                "No deliveries yet"
              )}
            </span>
          </p>
          {channel.lastError ? (
            <p className="mt-1 line-clamp-2 text-sm break-words text-danger" title={channel.lastError}>
              Last error: {channel.lastError}
            </p>
          ) : null}
        </div>
        <Switch
          checked={enabled}
          label={enabled ? `Turn off ${channel.name}` : `Turn on ${channel.name}`}
          onCheckedChange={(next) => {
            setError(null);
            startToggle(async () => {
              setEnabled(next);
              try {
                await setChannelEnabledAction(channel.id, next);
              } catch (err) {
                // The switch snaps back when the transition ends.
                setError(await describeActionError(err, next ? `Couldn't turn on ${channel.name}` : `Couldn't turn off ${channel.name}`));
              }
            });
          }}
        />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 pl-12">
        <TestButton id={channel.id} />
        {info ? (
          <Button variant="ghost" size="sm" onClick={form.open ? form.hide : form.show} aria-expanded={form.open}>
            <Pencil className="size-4" />
            Edit
          </Button>
        ) : null}
        <ConfirmButton
          title={`Delete “${channel.name}”?`}
          description="Searches that only notify this channel will fall back to all enabled channels."
          onConfirm={async () => {
            setError(null);
            try {
              await deleteChannelAction(channel.id);
            } catch (err) {
              setError(await describeActionError(err, "Couldn't delete the channel"));
            }
          }}
          className="text-danger hover:text-danger"
          ariaLabel={`Delete ${channel.name}`}
        >
          <Trash2 className="size-4" />
          <span className="hidden sm:inline">Delete</span>
        </ConfirmButton>
      </div>
      <ActionError error={error} className="mt-2 pl-12 text-sm text-danger" />

      {channel.type === "webpush" ? (
        <div className="mt-3 pl-12">
          <WebPushControls {...webPush} />
        </div>
      ) : channel.type === "email" && !smtpConfigured ? (
        <div className="mt-3 pl-12">
          <SmtpWarning />
        </div>
      ) : null}

      {form.open && info ? (
        <form onSubmit={form.submit} noValidate className="mt-4 space-y-4 rounded-xl border border-border bg-bg/60 p-4 sm:ml-12">
          <input type="hidden" name="channelId" value={channel.id} />
          <input type="hidden" name="type" value={channel.type} />
          <FormMessage state={form.state} />
          <ChannelFields info={info} channel={channel} errors={form.state.errors ?? {}} idPrefix={`channel-${channel.id}`} />
          <ChannelFormActions pending={form.pending} onCancel={form.hide} submitLabel="Save changes" />
        </form>
      ) : null}
    </li>
  );
}
