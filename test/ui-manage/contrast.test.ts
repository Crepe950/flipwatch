/**
 * WCAG AA contrast of the design tokens and marketplace badges: small text needs 4.5:1 against every
 * background it sits on, in light and dark mode.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../..");
const css = fs.readFileSync(path.join(ROOT, "src/app/globals.css"), "utf8");
const badges = fs.readFileSync(path.join(ROOT, "src/components/ui/marketplace-badge.tsx"), "utf8");

type Rgb = [number, number, number];

function hex(value: string): Rgb {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value.trim());
  if (!m) throw new Error(`not a #rrggbb colour: ${value}`);
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}

function luminance([r, g, b]: Rgb): number {
  const f = (c: number) => {
    const x = c / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const over = (top: Rgb, alpha: number, bottom: Rgb): Rgb => top.map((c, i) => Math.round(c * alpha + bottom[i] * (1 - alpha))) as Rgb;

function tokens(block: string): Record<string, Rgb> {
  return Object.fromEntries([...block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})/gi)].map(([, name, value]) => [name, hex(value)]));
}

const light = tokens(/^:root\s*\{([^}]*)\}/m.exec(css)![1]);
const dark = tokens(/@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{([^}]*)\}/.exec(css)![1]);
const surfaces = ["surface", "bg", "surface-2"] as const;

describe.each([
  ["light", light],
  ["dark", dark],
])("%s mode tokens", (_mode, t) => {
  it.each(["text", "muted", "accent", "warn", "danger", "info"])("%s text is readable on every surface and its soft tint", (name) => {
    const backgrounds = [...surfaces, `${name}-soft`].filter((bg) => t[bg]);
    for (const bg of backgrounds) expect(contrast(t[name], t[bg]), `${name} on ${bg}`).toBeGreaterThanOrEqual(4.5);
  });

  it("button text is readable on the accent", () => {
    expect(contrast(t["accent-contrast"], t.accent)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("marketplace badges", () => {
  const styles = [...badges.matchAll(/(\w+): \{ label: "[^"]+", className: "bg-\[(#\w{6})\]\/12 text-\[(#\w{6})\] dark:text-\[(#\w{6})\]" \}/g)];

  it("are all covered", () => {
    expect(styles.map((s) => s[1]).sort()).toEqual(["craigslist", "ebay", "facebook", "kijiji", "offerup"]);
  });

  it.each(styles.map((s) => [s[1], s[2], s[3], s[4]]))("%s text is readable on its tint", (_id, tint, lightText, darkText) => {
    for (const [mode, t, text] of [
      ["light", light, lightText],
      ["dark", dark, darkText],
    ] as const) {
      for (const bg of surfaces) {
        expect(contrast(hex(text), over(hex(tint), 0.12, t[bg])), `${mode} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
