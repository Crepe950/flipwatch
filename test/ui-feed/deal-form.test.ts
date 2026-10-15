import { createElement, type ComponentProps, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { moneyInputError } from "@/components/pipeline/deal-input";
import { Field, Input, Select, Textarea } from "@/components/ui/field";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const { updateDealAction } = await import("@/app/pipeline/actions");

describe("deal amount validation", () => {
  it("says why an amount was rejected", () => {
    expect(moneyInputError("-5")).toBe("Amounts can't be negative");
    expect(moneyInputError("$-5.50")).toBe("Amounts can't be negative");
    expect(moneyInputError("99999999")).toBe("Enter an amount up to $1,000,000");
    expect(moneyInputError("1,000,000.01")).toBe("Enter an amount up to $1,000,000");
    expect(moneyInputError("1.2.3")).toBe("Enter an amount like 250 or 249.99");
    expect(moneyInputError("abc")).toBe("Enter an amount like 250 or 249.99");
  });

  it("the deal form gets a distinct message per problem", async () => {
    const form = new FormData();
    form.set("dealId", "1");
    form.set("offer", "1,250.50");
    form.set("fees", "-5");
    form.set("otherCosts", "99999999");
    form.set("sale", "1.2.3");
    await expect(updateDealAction(form)).resolves.toEqual({
      ok: false,
      error: "Check the highlighted fields",
      fieldErrors: {
        fees: "Amounts can't be negative",
        otherCosts: "Enter an amount up to $1,000,000",
        sale: "Enter an amount like 250 or 249.99",
      },
    });
  });
});

describe("Field", () => {
  const attrs = (html: string, tag: string) => new RegExp(`<${tag}[^>]*>`).exec(html)?.[0] ?? "";
  const field = (props: Omit<ComponentProps<typeof Field>, "children">, child: ReactNode) =>
    renderToStaticMarkup(createElement(Field, props as ComponentProps<typeof Field>, child));

  it("links the control to its error and marks it invalid (red border)", () => {
    const controls = [
      ["input", createElement(Input, { id: "offer" })],
      ["textarea", createElement(Textarea, { id: "offer" })],
      ["select", createElement(Select, { id: "offer" })],
    ] as const;
    for (const [tag, control] of controls) {
      const html = field({ label: "Offer", htmlFor: "offer", error: "Amounts can't be negative" }, control);
      expect(attrs(html, tag)).toContain('aria-describedby="offer-error"');
      expect(attrs(html, tag)).toContain('aria-invalid="true"');
      expect(attrs(html, tag)).toContain("aria-invalid:border-danger");
      expect(html).toContain('<p id="offer-error" class="text-xs text-danger">Amounts can&#x27;t be negative</p>');
    }
  });

  it("links hints too, keeps the control's own description and reaches nested controls", () => {
    const html = field(
      { label: "Fees", htmlFor: "fees", hint: "Platform / payment fees" },
      createElement("div", null, createElement(Input, { id: "fees", "aria-describedby": "currency" })),
    );
    expect(attrs(html, "input")).toContain('aria-describedby="currency fees-hint"');
    expect(attrs(html, "input")).not.toContain("aria-invalid=");
    expect(html).toContain('id="fees-hint"');
  });

  it("leaves controls outside a Field alone", () => {
    expect(attrs(renderToStaticMarkup(createElement(Input, { id: "x" })), "input")).not.toContain("aria-describedby");
  });
});
