"use client";

import type { ComponentProps, ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Submit button that disables itself and swaps its icon for a spinner while the parent <form> action runs. */
export function SubmitButton({
  children,
  icon,
  pendingLabel,
  disabled,
  ...props
}: ComponentProps<typeof Button> & { icon?: ReactNode; pendingLabel?: ReactNode }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending || disabled} aria-busy={pending || undefined} {...props}>
      {pending ? <LoaderCircle className="size-4 animate-spin" /> : icon}
      {pending && pendingLabel ? pendingLabel : children}
    </Button>
  );
}
