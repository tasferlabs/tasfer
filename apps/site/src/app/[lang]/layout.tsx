import type { Metadata } from "next";
import { notFound } from "next/navigation";

import "@/styles/globals.css";
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

import { getDictionary, isLng, SUPPORTED_LNGS } from "@/lib/i18n/locales";
import { Providers } from "@/providers/Providers";

const SITE_ORIGIN = "https://www.tasfer.app";
const themeScript = `(function(){try{var t=localStorage.getItem('theme')||'system';var d=t==='dark'||(t==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);var r=document.documentElement;if(d){r.classList.add('dark');}r.style.colorScheme=d?'dark':'light';}catch(e){}})();`;

export const dynamicParams = false;

export function generateStaticParams() {
  return SUPPORTED_LNGS.map((lang) => ({ lang }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ lang: string }>;
}): Promise<Metadata> {
  const { lang } = await params;
  if (!isLng(lang)) return {};
  const dictionary = getDictionary(lang);
  const title = dictionary["metadata.title"];
  const description = dictionary["metadata.description"];
  const ogImage = "/og.png";

  return {
    metadataBase: new URL(SITE_ORIGIN),
    title: { default: title, template: "%s — Tasfer" },
    description,
    applicationName: "Tasfer",
    icons: { icon: "/logo.png" },
    robots: { index: true, follow: true },
    openGraph: {
      type: "website",
      locale: "en",
      siteName: "Tasfer",
      title,
      description,
      images: [{ url: ogImage, width: 1200, height: 630, alt: title }],
    },
    twitter: { card: "summary_large_image", title, description, images: [ogImage] },
  };
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ lang: string }>;
}) {
  const { lang } = await params;
  if (!isLng(lang)) notFound();

  // suppressHydrationWarning: the inline theme script sets `.dark` and
  // color-scheme on <html> before hydration, so its attributes legitimately
  // differ from the server render.
  return (
    <html lang={lang} dir="ltr" suppressHydrationWarning>
      <body>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <Providers lng={lang}>{children}</Providers>
      </body>
    </html>
  );
}
