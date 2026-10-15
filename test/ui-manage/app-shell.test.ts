import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import RootLoading from "@/app/loading";
import manifest from "@/app/manifest";

const ROOT = path.resolve(import.meta.dirname, "../..");
const file = (p: string) => path.join(ROOT, p);

/** Width, height and colour type from a PNG's IHDR chunk. */
function png(p: string) {
  const buf = fs.readFileSync(file(p));
  expect(buf.subarray(1, 4).toString("ascii")).toBe("PNG");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), colorType: buf[25] };
}

describe("app icons", () => {
  it("links the icon and an apple-touch-icon through Next's file conventions", () => {
    expect(fs.existsSync(file("src/app/icon.svg"))).toBe(true);
    // A public/icon.svg would clash with the /icon.svg route of app/icon.svg.
    expect(fs.existsSync(file("public/icon.svg"))).toBe(false);
    expect(png("src/app/apple-icon.png")).toMatchObject({ width: 180, height: 180 });
  });

  it("gives the manifest installable PNG icons and a neutral splash colour", () => {
    const m = manifest();
    const icons = m.icons ?? [];
    for (const size of ["192x192", "512x512"]) {
      const icon = icons.find((i) => i.sizes === size && i.type === "image/png" && i.purpose === "any");
      expect(icon, size).toBeDefined();
      const [w, h] = size.split("x").map(Number);
      expect(png(`public${icon!.src}`)).toMatchObject({ width: w, height: h });
    }
    const maskable = icons.find((i) => i.purpose === "maskable");
    expect(maskable && png(`public${maskable.src}`)).toMatchObject({ width: 512, height: 512 });
    expect(m.background_color).toBe("#f7f7f5");
  });

  it("uses a monochrome PNG badge for push notifications", () => {
    const sw = fs.readFileSync(file("public/sw.js"), "utf8");
    const badge = /badge:\s*"([^"]+)"/.exec(sw)?.[1];
    expect(badge).toMatch(/\.png$/);
    // Colour type 6 = RGBA: Android draws the badge from its alpha channel.
    expect(png(`public${badge}`)).toEqual({ width: 96, height: 96, colorType: 6 });
  });
});

describe("loading skeletons", () => {
  it("keeps the feed skeleton to the feed and gives other sections their own", () => {
    expect(fs.existsSync(file("src/app/(feed)/page.tsx"))).toBe(true);
    expect(fs.existsSync(file("src/app/(feed)/loading.tsx"))).toBe(true);
    for (const section of ["searches", "settings", "pipeline", "listings/[id]"]) {
      expect(fs.existsSync(file(`src/app/${section}/loading.tsx`)), section).toBe(true);
    }
    // The root fallback (sign-in, not-found…) is generic: no deal-card placeholders.
    const html = renderToStaticMarkup(createElement(RootLoading));
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain("size-24");
  });
});
