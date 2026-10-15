/**
 * Marketplace data is untrusted: only let http(s) links through to href/src attributes
 * (blocks javascript:, vbscript:, file: …). Images may additionally be inline raster/SVG data URIs,
 * which cannot run script inside an <img>.
 */

export function safeHttpUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const candidate = url.trim().startsWith("//") ? `https:${url.trim()}` : url.trim();
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

const DATA_IMAGE = /^data:image\/(png|jpe?g|gif|webp|avif|svg\+xml)[;,]/i;

export function safeImageUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (DATA_IMAGE.test(url)) return url;
  return safeHttpUrl(url);
}
