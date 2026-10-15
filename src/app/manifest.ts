import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "FlipWatch",
    short_name: "FlipWatch",
    description: "Real-time marketplace deal alerts for flippers.",
    start_url: "/",
    display: "standalone",
    // Splash-screen colour: the app's own light background rather than a dark flash.
    background_color: "#f7f7f5",
    theme_color: "#0f9d58",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
