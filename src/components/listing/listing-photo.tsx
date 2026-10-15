"use client";

import type { SyntheticEvent } from "react";
import { ImageOff } from "lucide-react";
import { cn } from "@/lib/cn";
import { safeImageUrl } from "./safe-url";

function hide(img: HTMLImageElement) {
  img.hidden = true;
}

/**
 * Hides images that already failed before React hydrated (their error event was missed).
 * decode() rejects for broken images; naturalWidth alone misreports some valid SVGs as 0.
 */
function hideIfBroken(img: HTMLImageElement | null) {
  if (img && img.complete && img.getAttribute("src")) img.decode().catch(() => hide(img));
}

/**
 * A listing photo with a placeholder underneath: missing, unsafe or broken URLs simply reveal the
 * placeholder, so the layout never jumps and no broken-image icon shows.
 */
export function ListingPhoto({
  src,
  alt = "",
  className,
  iconClassName,
  loading = "lazy",
  fit = "cover",
}: {
  src: string | null | undefined;
  alt?: string;
  className?: string;
  iconClassName?: string;
  loading?: "lazy" | "eager";
  /** "contain" shows the whole photo (detail gallery); "cover" fills the frame (thumbnails). */
  fit?: "cover" | "contain";
}) {
  const safe = safeImageUrl(src);
  return (
    <div className={cn("relative overflow-hidden bg-surface-2", className)}>
      <div aria-hidden className="absolute inset-0 grid place-items-center text-muted/60">
        <ImageOff className={iconClassName ?? "size-6"} />
      </div>
      {safe ? (
        // eslint-disable-next-line @next/next/no-img-element -- marketplace CDNs; next/image optimisation is disabled
        <img
          ref={hideIfBroken}
          src={safe}
          alt={alt}
          loading={loading}
          decoding="async"
          referrerPolicy="no-referrer"
          className={cn("absolute inset-0 size-full", fit === "contain" ? "object-contain" : "object-cover")}
          onError={(e: SyntheticEvent<HTMLImageElement>) => hide(e.currentTarget)}
        />
      ) : null}
    </div>
  );
}
