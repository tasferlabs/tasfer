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

export const metadata: Metadata = {
  title: "Cypher — local-first, end-to-end encrypted markdown",
  description:
    "A canvas-based markdown editor that is fully peer-to-peer and local-first. Your files stay on your disk, your keys never leave it, and sync is direct between peers.",
  icons: { icon: "/logo.png" },
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
