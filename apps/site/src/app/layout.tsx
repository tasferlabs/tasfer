import type { Metadata } from "next";

import "@/styles/globals.css";

// Base UI faces (the Arabic faces load lazily via @/lib/fonts when lng === "ar").
import "@fontsource/poppins/400.css";
import "@fontsource/poppins/500.css";
import "@fontsource/poppins/600.css";
import "@fontsource/poppins/700.css";
import "@fontsource/libre-baskerville/400.css";
import "@fontsource/libre-baskerville/700.css";
import "@fontsource/space-grotesk/400.css";
import "@fontsource/space-grotesk/500.css";
import "@fontsource/space-grotesk/600.css";
import "@fontsource/space-grotesk/700.css";

import { Providers } from "@/providers/Providers";

// Canonical origin of the marketing/docs site. The editor app owns the apex
// (https://cypher.md); this site is served from www. metadataBase lets every
// route express canonical/OpenGraph URLs as site-relative paths that Next
// resolves to absolute URLs at build time.
const SITE_ORIGIN = "https://www.cypher.md";

// Positioning: for people who don't want their private writing sitting on a
// company's servers. Promise (one benefit, not a feature list): your notes stay
// yours — on your device, readable only by you. The copy leads with that
// benefit and lets the facts (encrypted, no cloud, no account) prove it. It
// deliberately avoids "canvas-based" and other build-detail jargon nobody
// searches for or cares about.
const TITLE = "Tasfer — private markdown notes that stay on your device";
const DESCRIPTION =
  "A markdown editor that keeps your writing yours — every note stays on your device, end-to-end encrypted, syncing directly between your devices. No cloud. No account. No company reading your words.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_ORIGIN),
  title: {
    default: TITLE,
    template: "%s — Tasfer",
  },
  description: DESCRIPTION,
  applicationName: "Tasfer",
  icons: { icon: "/logo.png" },
  robots: { index: true, follow: true },
  openGraph: {
    type: "website",
    siteName: "Tasfer",
    title: TITLE,
    description: DESCRIPTION,
    url: "/home",
    images: [
      {
        url: "/og.png",
        width: 1200,
        height: 630,
        alt: "Tasfer — your thoughts stay yours. Private, end-to-end encrypted markdown.",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
    images: ["/og.png"],
  },
};

/**
 * Pre-hydration theme script: sets the `.dark` class and color-scheme from the
 * stored/preferred theme before first paint, so the marketing pages don't flash
 * the wrong theme. ThemeProvider then reads the same value and stays consistent.
 */
const themeScript = `(function(){try{var t=localStorage.getItem('theme')||'system';var d=t==='dark'||(t==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);var r=document.documentElement;if(d){r.classList.add('dark');}r.style.colorScheme=d?'dark':'light';}catch(e){}})();`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" dir="ltr" suppressHydrationWarning>
      <body suppressHydrationWarning>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
