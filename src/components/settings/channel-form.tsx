"use client";

import { startTransition, useActionState, useState, type FormEvent, type ReactNode } from "react";
import { ExternalLink, LoaderCircle, TriangleAlert } from "lucide-react";
import { saveChannelAction, type ChannelFormState } from "@/app/settings/actions";
import { isSecretField, type ChannelView } from "@/app/settings/channel-config";
import { ActionError } from "@/components/ui/action-error";
import { catchActionFailure } from "@/components/ui/action-failure";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input } from "@/components/ui/field";
import type { ChannelField, ChannelTypeInfo } from "@/lib/notify/channel-types";

const INITIAL: ChannelFormState = {};
const saveChannel = catchActionFailure(saveChannelAction, "Couldn't save the channel", (failure): ChannelFormState => ({ failure }));

/**
 * Action state + open/closed state for a channel form. The form closes itself after a successful
 * save; errors only show for submissions made since it was opened. Submitting via dispatch (not
 * <form action>) keeps React from resetting what the user typed when validation fails.
 */
export function useChannelForm(initiallyOpen = false) {
  const [state, dispatch, pending] = useActionState(saveChannel, INITIAL);
  const [openedWith, setOpenedWith] = useState<ChannelFormState | null>(initiallyOpen ? INITIAL : null);
  const fresh = openedWith !== null && state !== openedWith;
  return {
    pending,
    open: openedWith !== null && !(fresh && state.ok),
    justSaved: fresh && Boolean(state.ok),
    state: fresh ? state : INITIAL,
    show: () => setOpenedWith(state),
    hide: () => setOpenedWith(null),
    /** Forget the last submission's errors, e.g. when the form's fields change. */
    reset: () => setOpenedWith(state),
    submit: (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const formData = new FormData(e.currentTarget);
      startTransition(() => dispatch(formData));
    },
  };
}

function inputType(field: ChannelField): string {
  if (field.type === "password") return "password";
  if (field.type === "email") return "email";
  if (field.type === "url") return "url";
  return "text";
}

function SecretHint({ field, masked }: { field: ChannelField; masked?: string }) {
  if (!masked) return field.help ?? null;
  return (
    <>
      Saved as <span className="font-mono">{masked}</span>. Leave blank to keep it.{field.help ? ` ${field.help}` : ""}
    </>
  );
}

/** Name + type-specific fields for a channel. Secrets are never prefilled; blank keeps the saved value. */
export function ChannelFields({
  info,
  channel,
  errors,
  idPrefix,
  extra,
}: {
  info: ChannelTypeInfo;
  channel?: ChannelView;
  errors: Record<string, string>;
  idPrefix: string;
  extra?: ReactNode;
}) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">
        {info.description}{" "}
        {info.docsUrl ? (
          <a
            href={info.docsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-0.5 font-medium text-accent hover:underline"
          >
            Setup guide
            <ExternalLink className="size-3" />
          </a>
        ) : null}
      </p>
      <Field label="Name" htmlFor={`${idPrefix}-name`} error={errors.name}>
        <Input id={`${idPrefix}-name`} name="name" defaultValue={channel?.name ?? ""} maxLength={60} placeholder={info.label} />
      </Field>
      {info.fields.map((field) => {
        const id = `${idPrefix}-${field.key}`;
        const secret = isSecretField(field);
        const masked = channel?.secrets[field.key];
        return (
          <div key={field.key} className="space-y-2">
            <Field
              label={
                <>
                  {field.label}
                  {field.required ? null : <span className="font-normal text-muted"> (optional)</span>}
                </>
              }
              htmlFor={id}
              error={errors[`config.${field.key}`]}
              hint={secret ? <SecretHint field={field} masked={masked} /> : field.help}
            >
              <Input
                id={id}
                name={`field.${field.key}`}
                type={inputType(field)}
                defaultValue={secret ? "" : (channel?.values[field.key] ?? "")}
                placeholder={masked ?? field.placeholder}
                autoComplete={field.type === "password" ? "new-password" : "off"}
                spellCheck={false}
                maxLength={2000}
              />
            </Field>
            {masked && !field.required ? (
              <Checkbox name="clear" value={field.key} label={`Remove the saved ${field.label.toLowerCase()}`} className="text-muted" />
            ) : null}
          </div>
        );
      })}
      {extra}
    </div>
  );
}

/** Shown for email channels when the server has no SMTP_URL: every delivery would fail. */
export function SmtpWarning() {
  return (
    <p className="flex items-start gap-1.5 text-xs text-warn">
      <TriangleAlert className="mt-px size-3.5 shrink-0" />
      <span>
        Email alerts need an SMTP server: set <code className="rounded bg-surface-2 px-1">SMTP_URL</code> (e.g.{" "}
        <code className="rounded bg-surface-2 px-1">smtps://user:pass@smtp.example.com:465</code>) and restart. Until then every
        email alert fails.
      </span>
    </p>
  );
}

export function ChannelFormActions({ pending, onCancel, submitLabel }: { pending: boolean; onCancel: () => void; submitLabel: string }) {
  return (
    <div className="flex justify-end gap-2">
      <Button variant="ghost" onClick={onCancel} disabled={pending}>
        Cancel
      </Button>
      <Button type="submit" disabled={pending}>
        {pending ? <LoaderCircle className="size-4 animate-spin" /> : null}
        {pending ? "Saving…" : submitLabel}
      </Button>
    </div>
  );
}

export function FormMessage({ state }: { state: ChannelFormState }) {
  if (state.failure) return <ActionError error={state.failure} className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger" />;
  if (!state.message) return null;
  return (
    <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
      {state.message}
    </p>
  );
}
