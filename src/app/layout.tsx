import type { Metadata, Viewport } from "next";
import { AppNav } from "@/components/app-nav";
import "./globals.css";

// Every page reads live data from the database.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { default: "FlipWatch", template: "%s · FlipWatch" },
  description: "Real-time marketplace deal alerts for flippers.",
  applicationName: "FlipWatch",
  appleWebApp: { capable: true, title: "FlipWatch", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f7f7f5" },
    { media: "(prefers-color-scheme: dark)", color: "#0e0f12" },
  ],
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body className="min-h-dvh">
        <AppNav />
        {/* overflow-x: clip keeps a stray wide element from making the whole page scroll sideways
            (unlike hidden, it doesn't create a scroll container, so sticky elements keep working). */}
        <main className="mx-auto w-full max-w-6xl overflow-x-clip px-4 pt-5 pb-24 md:pl-60 md:pr-6 md:pb-10 lg:pl-64">{children}</main>
      </body>
    </html>
  );
}
