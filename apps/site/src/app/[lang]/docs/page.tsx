import type { Metadata } from "next";

import { JsonLd } from "@/components/JsonLd";
import { getDictionary, isLng } from "@/lib/i18n/locales";
import { getOgImage } from "@/lib/og";
import {
  absoluteUrl,
  alternates,
  breadcrumbNode,
  graph,
  localizedPath,
  siteNodes,
  SITE_NAME,
  SITE_ORIGIN,
} from "@/lib/seo";
import DocsPage from "@/views/DocsPage/DocsPage";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ lang: string }>;
}): Promise<Metadata> {
  const { lang } = await params;
  if (!isLng(lang)) return {};
  const dictionary = getDictionary(lang);
  const title = dictionary["docs.metadata.title"];
  const description = dictionary["docs.metadata.description"];
  const image = getOgImage("docs", lang);

  return {
    title,
    description,
    alternates: alternates(lang, "docs"),
    openGraph: {
      type: "website",
      locale: lang,
      siteName: SITE_NAME,
      title,
      description,
      url: absoluteUrl(localizedPath(lang, "docs")),
      images: [{ url: image, width: 1200, height: 630, alt: title }],
    },
    twitter: { card: "summary_large_image", title, description, images: [image] },
  };
}

export default async function Page({
  params,
}: {
  params: Promise<{ lang: string }>;
}) {
  const { lang } = await params;
  if (!isLng(lang)) return <DocsPage />;
  const dictionary = getDictionary(lang);

  return (
    <>
      <JsonLd
        data={graph(
          ...siteNodes(lang, dictionary["metadata.description"]),
          {
            "@type": "CollectionPage",
            "@id": `${absoluteUrl(localizedPath(lang, "docs"))}#page`,
            name: dictionary["docs.metadata.title"],
            description: dictionary["docs.metadata.description"],
            url: absoluteUrl(localizedPath(lang, "docs")),
            inLanguage: lang,
            isPartOf: { "@id": `${SITE_ORIGIN}/#website` },
            about: { "@id": `${SITE_ORIGIN}/#app` },
          },
          breadcrumbNode(
            [
              { name: SITE_NAME, path: "" },
              { name: dictionary["docs.metadata.title"], path: "docs" },
            ],
            lang,
          ),
        )}
      />
      <DocsPage />
    </>
  );
}
