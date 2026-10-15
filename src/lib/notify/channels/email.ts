import nodemailer from "nodemailer";
import { config as env } from "../../config";
import { ChannelNotConfiguredError, NotifyError, requireConfig } from "../errors";
import { escapeHtml, truncate } from "../escape";
import type { Alert, ChannelSender } from "../types";

const SMTP_TIMEOUT_MS = 10_000;
const EMAIL_PATTERN = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

export interface EmailMessage {
  from: string;
  to: string[];
  subject: string;
  text: string;
  html: string;
}

type Transporter = ReturnType<typeof nodemailer.createTransport>;
let cached: { url: string; transporter: Transporter } | null = null;

/** Transporter for the current SMTP_URL, cached across sends and recreated when the URL changes. */
export function getTransporter(): Transporter {
  const url = env.smtpUrl;
  if (!url) throw new ChannelNotConfiguredError("Email needs SMTP_URL (e.g. smtps://user:pass@smtp.example.com:465)");
  if (cached?.url !== url) {
    cached?.transporter.close();
    cached = {
      url,
      transporter: nodemailer.createTransport({
        url,
        connectionTimeout: SMTP_TIMEOUT_MS,
        greetingTimeout: SMTP_TIMEOUT_MS,
        socketTimeout: SMTP_TIMEOUT_MS,
      }),
    };
  }
  return cached.transporter;
}

/** Test hook: forget the cached transporter. */
export function resetEmailTransport(): void {
  cached?.transporter.close();
  cached = null;
}

export function parseRecipients(value: string): string[] {
  const recipients = value
    .split(/[,;\s]+/)
    .map((r) => r.trim())
    .filter(Boolean);
  if (!recipients.length) throw new ChannelNotConfiguredError("Missing recipient address");
  const invalid = recipients.find((r) => !EMAIL_PATTERN.test(r));
  if (invalid) throw new ChannelNotConfiguredError(`"${truncate(invalid, 60)}" is not a valid email address`);
  return recipients;
}

const C = {
  bg: "#f7f7f5",
  surface: "#ffffff",
  border: "#e4e4df",
  text: "#16181d",
  muted: "#62656e",
  accent: "#0f9d58",
  accentText: "#ffffff",
} as const;

function htmlButton(href: string, label: string, primary: boolean): string {
  const style = primary
    ? `background:${C.accent};color:${C.accentText};border:1px solid ${C.accent}`
    : `background:${C.surface};color:${C.text};border:1px solid ${C.border}`;
  return `<a href="${escapeHtml(href)}" style="display:inline-block;${style};padding:10px 16px;border-radius:8px;font-size:14px;font-weight:600;text-decoration:none;margin:0 8px 8px 0">${escapeHtml(label)}</a>`;
}

function htmlBody(alert: Alert): string {
  const parts: string[] = [];
  if (alert.imageUrl) {
    parts.push(
      `<a href="${escapeHtml(alert.url)}"><img src="${escapeHtml(alert.imageUrl)}" alt="" width="520" style="display:block;width:100%;max-width:520px;height:auto;border-radius:8px;margin:0 0 16px;border:0"></a>`,
    );
  }
  parts.push(
    `<h1 style="margin:0 0 6px;font-size:18px;line-height:1.35;font-weight:700"><a href="${escapeHtml(alert.url)}" style="color:${C.text};text-decoration:none">${escapeHtml(alert.title)}</a></h1>`,
  );
  if (alert.context) parts.push(`<p style="margin:0 0 16px;color:${C.muted};font-size:13px">${escapeHtml(alert.context)}</p>`);
  if (alert.fields.length) {
    const rows = alert.fields
      .map(
        (f) =>
          `<tr><td style="padding:6px 12px 6px 0;color:${C.muted};font-size:13px;white-space:nowrap;vertical-align:top">${escapeHtml(f.label)}</td><td style="padding:6px 0;font-size:14px">${escapeHtml(f.value)}</td></tr>`,
      )
      .join("");
    parts.push(`<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 16px">${rows}</table>`);
  }
  if (alert.items.length) {
    const items = alert.items
      .map(
        (i) =>
          `<li style="margin:0 0 6px"><a href="${escapeHtml(i.url ?? i.appUrl)}" style="color:${C.text}">${escapeHtml(i.title)}</a> · <a href="${escapeHtml(i.appUrl)}" style="color:${C.muted};font-size:13px">FlipWatch</a></li>`,
      )
      .join("");
    parts.push(`<ul style="margin:0 0 16px;padding-left:18px;font-size:14px">${items}</ul>`);
  }
  const buttons =
    alert.kind === "digest" || alert.url === alert.appUrl
      ? htmlButton(alert.appUrl, "Open in FlipWatch", true)
      : htmlButton(alert.url, "View listing", true) + htmlButton(alert.appUrl, "Open in FlipWatch", false);
  parts.push(`<div>${buttons}</div>`);
  if (alert.test) parts.push(`<p style="margin:8px 0 0;color:${C.muted};font-size:13px">This is a test alert from FlipWatch — your email channel works.</p>`);

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(alert.title)}</title></head><body style="margin:0;padding:24px 12px;background:${C.bg};color:${C.text};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:${C.surface};border:1px solid ${C.border};border-radius:12px"><tr><td style="padding:20px">${parts.join("")}</td></tr></table><p style="text-align:center;color:${C.muted};font-size:12px;margin:12px 0 0">Sent by FlipWatch</p></body></html>`;
}

function textBody(alert: Alert): string {
  const body = alert.kind === "digest" ? alert.items.map((i) => `- ${i.title}\n  ${i.url ?? i.appUrl}`) : alert.lines;
  const links = alert.kind !== "digest" && alert.url !== alert.appUrl ? [`Listing: ${alert.url}`] : [];
  return [alert.title, "", ...body, "", ...links, `Open in FlipWatch: ${alert.appUrl}`].join("\n");
}

export function buildEmailMessage(alert: Alert, channelConfig: Record<string, string>, from: string = env.emailFrom): EmailMessage {
  const to = parseRecipients(requireConfig(channelConfig, "to", "recipient address"));
  return {
    from,
    to,
    subject: truncate(alert.test ? `[Test] ${alert.title}` : alert.title, 200),
    text: textBody(alert),
    html: htmlBody(alert),
  };
}

export const sendEmail: ChannelSender = async (alert, channelConfig) => {
  const message = buildEmailMessage(alert, channelConfig);
  const info = await getTransporter().sendMail(message);
  const accepted = Array.isArray(info.accepted) ? info.accepted.length : 0;
  if (accepted === 0) throw new NotifyError("SMTP server accepted no recipients");
};
