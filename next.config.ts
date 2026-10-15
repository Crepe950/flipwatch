import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";

/**
 * Next.js injects inline bootstrap scripts, so script-src needs 'unsafe-inline' without per-request
 * nonces; dev also needs 'unsafe-eval' for React's debugging. Listing photos come from arbitrary
 * marketplace CDNs, hence img-src *. Everything else stays same-origin.
 */
const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src * data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/**
 * Behind a reverse proxy (e.g. `tailscale serve`) the Host header the app sees can differ from the
 * browser's Origin, and Next.js then rejects Server Actions as cross-site. Allow exactly the public host
 * from APP_URL — nothing broader.
 */
function appUrlHost(): string[] {
  try {
    return process.env.APP_URL ? [new URL(process.env.APP_URL).host] : [];
  } catch {
    return [];
  }
}

const nextConfig: NextConfig = {
  // Native/WASM database drivers must not be bundled.
  serverExternalPackages: ["@electric-sql/pglite", "postgres"],
  experimental: {
    serverActions: { allowedOrigins: appUrlHost() },
  },
  images: {
    // Listing photos come from many marketplace CDNs; we render them with <img>, not next/image.
    unoptimized: true,
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: contentSecurityPolicy },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          // Not "no-referrer": with it, browsers send `Origin: null` on same-origin form POSTs, which
          // Next.js rejects as a cross-site Server Action (e.g. the login form before hydration).
          // "same-origin" still sends nothing to marketplaces and other sites.
          { key: "Referrer-Policy", value: "same-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
