import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendMail = vi.fn();
const createTransport = vi.fn(() => ({ sendMail, close: vi.fn() }));
vi.mock("nodemailer", () => ({ default: { createTransport } }));

const { buildEmailMessage, parseRecipients, resetEmailTransport, sendEmail } = await import("../channels/email");
const { ChannelNotConfiguredError } = await import("../errors");
const { HOSTILE_TITLE, makeAlert, makeCtx, makeDigestAlert } = await import("./fixtures");

beforeEach(() => {
  resetEmailTransport();
  sendMail.mockReset();
  createTransport.mockClear();
});
afterEach(() => vi.unstubAllEnvs());

describe("email", () => {
  it("builds escaped HTML and plain-text versions", () => {
    const msg = buildEmailMessage(makeAlert(), { to: "me@example.com" }, "FlipWatch <alerts@example.com>");
    expect(msg).toMatchObject({ from: "FlipWatch <alerts@example.com>", to: ["me@example.com"], subject: `$120 · ${HOSTILE_TITLE}` });
    expect(msg.html).toContain("$120 · &lt;b&gt;x&lt;/b&gt; &amp; *y* @everyone");
    expect(msg.html).not.toContain("<b>x</b>");
    expect(msg.html).toContain('<img src="https://images.craigslist.org/00a0a_abc_600x450.jpg"');
    expect(msg.html).toContain('href="https://flipwatch.example.com/listings/42"');
    expect(msg.text).toContain("Deal score: 86/100");
    expect(msg.text).toContain("Listing: https://vancouver.craigslist.org/van/vgm/d/ps5/7712345678.html");
  });

  it("escapes attribute-breaking URLs and lists digest items", () => {
    const msg = buildEmailMessage(makeDigestAlert(2), { to: "me@example.com" });
    expect(msg.html).toContain("PS5 #1 &lt;b&gt;x&lt;/b&gt;");
    const hostile = buildEmailMessage(makeAlert({ imageUrl: 'https://x.test/a.jpg" onerror="alert(1)' }), { to: "me@example.com" });
    expect(hostile.html).toContain('src="https://x.test/a.jpg&quot; onerror=&quot;alert(1)"');
  });

  it("parses and validates recipients", () => {
    expect(parseRecipients("a@x.com, b@y.org")).toEqual(["a@x.com", "b@y.org"]);
    expect(() => parseRecipients("not-an-email")).toThrow(ChannelNotConfiguredError);
    expect(() => buildEmailMessage(makeAlert(), {})).toThrow(/recipient/);
  });

  it("requires SMTP_URL", async () => {
    vi.stubEnv("SMTP_URL", "");
    await expect(sendEmail(makeAlert(), { to: "me@example.com" }, makeCtx())).rejects.toThrow(/SMTP_URL/);
  });

  it("sends through a cached transporter with timeouts", async () => {
    vi.stubEnv("SMTP_URL", "smtps://user:pass@smtp.example.com:465");
    sendMail.mockResolvedValue({ accepted: ["me@example.com"], rejected: [] });
    await sendEmail(makeAlert(), { to: "me@example.com" }, makeCtx());
    await sendEmail(makeAlert(), { to: "me@example.com" }, makeCtx());
    expect(createTransport).toHaveBeenCalledTimes(1);
    expect(createTransport).toHaveBeenCalledWith(expect.objectContaining({ url: "smtps://user:pass@smtp.example.com:465", socketTimeout: 10_000 }));
    expect(sendMail).toHaveBeenCalledTimes(2);
    expect(sendMail.mock.calls[0][0]).toMatchObject({ to: ["me@example.com"] });
  });

  it("fails when no recipient was accepted", async () => {
    vi.stubEnv("SMTP_URL", "smtp://localhost:25");
    sendMail.mockResolvedValue({ accepted: [], rejected: ["me@example.com"] });
    await expect(sendEmail(makeAlert(), { to: "me@example.com" }, makeCtx())).rejects.toThrow(/no recipients/);
  });
});
