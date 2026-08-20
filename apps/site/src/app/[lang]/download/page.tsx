import type { Metadata } from "next";
import DownloadPage from "@/views/DownloadPage/DownloadPage";
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
} from "@/lib/seo";
import { JsonLd } from "@/components/JsonLd";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ lang: string }>;
}): Promise<Metadata> {
  const { lang } = await params;
  if (!isLng(lang)) return {};
  const dictionary = getDictionary(lang);
  const title = dictionary["download.metadata.title"];
  const description = dictionary["download.metadata.description"];
  const image = getOgImage("download", lang);

  return {
    title,
    description,
    alternates: alternates(lang, "download"),
    openGraph: {
      type: "website",
      locale: lang,
      siteName: SITE_NAME,
      title,
      description,
      url: absoluteUrl(localizedPath(lang, "download")),
      images: [
        {
          url: image,
          width: 1200,
          height: 630,
          alt: title,
        },
      ],
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
  if (!isLng(lang)) return <DownloadPage />;
  const dictionary = getDictionary(lang);

  return (
    <>
      <JsonLd
        data={graph(
          ...siteNodes(lang, dictionary["metadata.description"]),
          breadcrumbNode(
            [
              { name: SITE_NAME, path: "" },
              { name: dictionary["download.metadata.title"], path: "download" },
            ],
            lang,
          ),
        )}
      />
      <DownloadPage />
    </>
  );
}
