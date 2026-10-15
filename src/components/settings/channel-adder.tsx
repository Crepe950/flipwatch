"use client";

import { useState } from "react";
import { CircleCheck, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Select } from "@/components/ui/field";
import { CHANNEL_TYPES, getChannelType } from "@/lib/notify/channel-types";
import { ChannelFields, ChannelFormActions, FormMessage, SmtpWarning, useChannelForm } from "./channel-form";
import { WebPushControls, type WebPushInfo } from "./web-push-controls";

/** "Add channel" disclosure with a form generated from CHANNEL_TYPES. */
export function ChannelAdder({ webPush, smtpConfigured, startOpen }: { webPush: WebPushInfo; smtpConfigured: boolean; startOpen: boolean }) {
  // Open by default when there are no channels yet.
  const form = useChannelForm(startOpen);
  const [type, setType] = useState(CHANNEL_TYPES[0]?.type ?? "ntfy");
  const info = getChannelType(type);

  if (!form.open) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="secondary" onClick={form.show}>
          <Plus className="size-4" />
          Add channel
        </Button>
        {form.justSaved ? (
          <span role="status" className="inline-flex items-center gap-1 text-sm text-accent">
            <CircleCheck className="size-4" />
            Channel added. Send a test to make sure it arrives.
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <form onSubmit={form.submit} noValidate className="space-y-4 rounded-xl border border-border bg-bg/60 p-4">
      <h3 className="text-sm font-semibold">Add a notification channel</h3>
      <FormMessage state={form.state} />
      <Field label="Type" htmlFor="new-channel-type" error={form.state.errors?.type}>
        <Select
          id="new-channel-type"
          name="type"
          value={type}
          onChange={(e) => {
            setType(e.target.value as typeof type);
            // The last submission's errors were about the other type's fields.
            form.reset();
          }}
        >
          {CHANNEL_TYPES.map((t) => (
            <option key={t.type} value={t.type}>
              {t.label}
            </option>
          ))}
        </Select>
      </Field>
      {info ? (
        <ChannelFields
          key={type}
          info={info}
          errors={form.state.errors ?? {}}
          idPrefix="new-channel"
          extra={type === "webpush" ? <WebPushControls {...webPush} /> : type === "email" && !smtpConfigured ? <SmtpWarning /> : null}
        />
      ) : null}
      <ChannelFormActions pending={form.pending} onCancel={form.hide} submitLabel="Add channel" />
    </form>
  );
}
