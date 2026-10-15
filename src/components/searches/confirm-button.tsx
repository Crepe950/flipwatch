"use client";

import { useRef, useTransition, type ReactNode } from "react";
import { LoaderCircle } from "lucide-react";
import { Button, type ButtonSize, type ButtonVariant } from "@/components/ui/button";

/**
 * A button that asks for confirmation in a native modal <dialog> before running `onConfirm`.
 * The dialog stays open (with a spinner) until the action settles.
 */
export function ConfirmButton({
  children,
  title,
  description,
  confirmLabel = "Delete",
  onConfirm,
  variant = "ghost",
  size = "sm",
  className,
  ariaLabel,
}: {
  children: ReactNode;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  onConfirm: () => Promise<unknown> | void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  ariaLabel?: string;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [pending, startTransition] = useTransition();

  const confirm = () => {
    startTransition(async () => {
      try {
        await onConfirm();
      } finally {
        dialogRef.current?.close();
      }
    });
  };

  return (
    <>
      <Button variant={variant} size={size} className={className} aria-label={ariaLabel} onClick={() => dialogRef.current?.showModal()}>
        {children}
      </Button>
      <dialog
        ref={dialogRef}
        className="m-auto w-[calc(100%-2rem)] max-w-sm rounded-xl border border-border bg-surface p-0 text-fg shadow-xl backdrop:bg-black/50"
        onCancel={(e) => {
          if (pending) e.preventDefault();
        }}
      >
        <div className="p-5">
          <h2 className="text-base font-semibold">{title}</h2>
          {description ? <div className="mt-1.5 text-sm text-muted">{description}</div> : null}
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          {/* Focus Cancel first so a stray Enter never confirms a destructive action. */}
          <Button variant="secondary" disabled={pending} onClick={() => dialogRef.current?.close()} autoFocus>
            Cancel
          </Button>
          <Button variant="danger" disabled={pending} onClick={confirm}>
            {pending ? <LoaderCircle className="size-4 animate-spin" /> : null}
            {confirmLabel}
          </Button>
        </div>
      </dialog>
    </>
  );
}
