import type { Metadata } from "next";

import { JsonLd } from "@/components/JsonLd";
import { getDictionary, isLng } from "@/lib/i18n/locales";
import { getOgImage } from "@/lib/og";
import { RESUME_INTO_APP_SCRIPT } from "@/lib/appResume";
import {
  absoluteUrl,
  alternates,
  graph,
  localizedPath,
  SITE_NAME,
  siteNodes,
} from "@/lib/seo";
import HomePage from "@/views/HomePage/HomePage";

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
  return {
    alternates: alternates(lang),
    openGraph: {
      type: "website",
      locale: lang,
      siteName: SITE_NAME,
      title,
      description,
      url: absoluteUrl(localizedPath(lang)),
      images: [
        {
          url: getOgImage("home", lang),
          width: 1200,
          height: 630,
          alt: title,
        },
      ],
    },
  };
}

export default async function Page({
  params,
}: {
  params: Promise<{ lang: string }>;
}) {
  const { lang } = await params;
  const dictionary = isLng(lang) ? getDictionary(lang) : null;

  // The landing page doubles as the app's front door: a browser that already
  // holds a workspace is sent back into the editor before this page paints.
  // /home shows the same page without that check, for everyone.
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: RESUME_INTO_APP_SCRIPT }} />
      {isLng(lang) && dictionary ? (
        <JsonLd
          data={graph(...siteNodes(lang, dictionary["metadata.description"]))}
        />
      ) : null}
      <HomePage />
    </>
  );
}
