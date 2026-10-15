"use client";

import { useRef, useState } from "react";
import { ChevronLeft, ChevronRight, ImageOff } from "lucide-react";
import { cn } from "@/lib/cn";
import { ListingPhoto } from "./listing-photo";
import { safeImageUrl } from "./safe-url";

const MAX_PHOTOS = 24;

/** Swipeable (scroll-snap) photo gallery with a counter, arrows on larger screens and thumbnails. */
export function PhotoGallery({ images, title }: { images: string[]; title: string }) {
  const photos = images
    .map((u) => safeImageUrl(u))
    .filter((u): u is string => u !== null)
    .slice(0, MAX_PHOTOS);
  const scroller = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);

  if (photos.length === 0) {
    return (
      <div className="grid aspect-[4/3] w-full place-items-center rounded-xl border border-border bg-surface-2 text-muted sm:aspect-[16/9]">
        <div className="flex flex-col items-center gap-2 text-sm">
          <ImageOff className="size-8" aria-hidden />
          No photos
        </div>
      </div>
    );
  }

  function go(to: number) {
    const el = scroller.current;
    if (!el) return;
    const clamped = Math.max(0, Math.min(photos.length - 1, to));
    el.scrollTo({ left: clamped * el.clientWidth, behavior: "smooth" });
  }

  return (
    <div className="space-y-2">
      <div className="group relative overflow-hidden rounded-xl border border-border bg-surface-2">
        <div
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget;
            setIndex(Math.round(el.scrollLeft / Math.max(1, el.clientWidth)));
          }}
          className="flex snap-x snap-mandatory overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          aria-roledescription="carousel"
          aria-label={`Photos (${photos.length})`}
        >
          {photos.map((src, i) => (
            <ListingPhoto
              key={`${i}-${src}`}
              src={src}
              alt={`${title} — photo ${i + 1} of ${photos.length}`}
              loading={i === 0 ? "eager" : "lazy"}
              fit="contain"
              className="aspect-[4/3] w-full shrink-0 snap-center sm:aspect-[16/9]"
            />
          ))}
        </div>
        {photos.length > 1 ? (
          <>
            <span className="absolute right-2 bottom-2 rounded-md bg-surface/85 px-1.5 py-0.5 text-xs font-medium text-fg tabular-nums shadow-sm backdrop-blur">
              {index + 1} / {photos.length}
            </span>
            <button
              type="button"
              onClick={() => go(index - 1)}
              disabled={index === 0}
              aria-label="Previous photo"
              className="absolute top-1/2 left-2 hidden size-9 -translate-y-1/2 place-items-center rounded-full bg-surface/85 text-fg shadow-sm backdrop-blur transition-opacity hover:bg-surface disabled:opacity-0 sm:grid"
            >
              <ChevronLeft className="size-5" aria-hidden />
            </button>
            <button
              type="button"
              onClick={() => go(index + 1)}
              disabled={index === photos.length - 1}
              aria-label="Next photo"
              className="absolute top-1/2 right-2 hidden size-9 -translate-y-1/2 place-items-center rounded-full bg-surface/85 text-fg shadow-sm backdrop-blur transition-opacity hover:bg-surface disabled:opacity-0 sm:grid"
            >
              <ChevronRight className="size-5" aria-hidden />
            </button>
          </>
        ) : null}
      </div>
      {photos.length > 1 ? (
        <div className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none]">
          {photos.map((src, i) => (
            <button
              key={`${i}-${src}`}
              type="button"
              onClick={() => go(i)}
              aria-label={`Show photo ${i + 1}`}
              aria-current={i === index ? "true" : undefined}
              className={cn(
                "shrink-0 overflow-hidden rounded-lg border-2 transition-opacity",
                i === index ? "border-accent" : "border-transparent opacity-70 hover:opacity-100",
              )}
            >
              <ListingPhoto src={src} className="size-14" iconClassName="size-4" />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
