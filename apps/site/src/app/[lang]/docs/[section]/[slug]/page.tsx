import type { Metadata } from "next";

import { JsonLd } from "@/components/JsonLd";
import { getDictionary, isLng, type Lng } from "@/lib/i18n/locales";
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
import DocsArticle from "@/views/DocsPage/DocsArticle";
import { FLAT, PAGE, type PageMeta } from "@/views/DocsPage/docsNav";

export const dynamicParams = false;

export function generateStaticParams() {
  return FLAT.map((page) => {
    const [section, slug] = page.route.split("/");
    return { section, slug };
  });
}

/** Title, description and canonical URL for one article, in one locale. */
function articleSeo(lang: Lng, meta: PageMeta) {
  const dictionary = getDictionary(lang);
  return {
    title: dictionary[meta.titleKey],
    description: dictionary[meta.descKey],
    path: `docs/${meta.route}`,
    url: absoluteUrl(localizedPath(lang, `docs/${meta.route}`)),
  };
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ lang: string; section: string; slug: string }>;
}): Promise<Metadata> {
  const { lang, section, slug } = await params;
  if (!isLng(lang)) return {};
  const meta = PAGE[`${section}/${slug}`];
  if (!meta) return {};

  const { title, description, path, url } = articleSeo(lang, meta);
  // Articles have no art of their own, so they share the documentation card —
  // still better than the landing one, which promises the product page.
  const image = getOgImage("docs", lang);

  return {
    title,
    description,
    alternates: alternates(lang, path),
    openGraph: {
      type: "article",
      locale: lang,
      siteName: SITE_NAME,
      title,
      description,
      url,
      images: [{ url: image, width: 1200, height: 630, alt: title }],
    },
    twitter: { card: "summary_large_image", title, description, images: [image] },
  };
}

export default async function DocsArticlePage({
  params,
}: {
  params: Promise<{ lang: string; section: string; slug: string }>;
}) {
  const { lang, section, slug } = await params;
  const meta = PAGE[`${section}/${slug}`];

  // The article shell renders its own in-page 404 for an unknown route, and an
  // unknown locale never reaches here (`dynamicParams` is off on the layout).
  const structuredData =
    isLng(lang) && meta ? articleGraph(lang, meta) : null;

  return (
    <>
      {structuredData ? <JsonLd data={structuredData} /> : null}
      <DocsArticle section={section} slug={slug} />
    </>
  );
}

function articleGraph(lang: Lng, meta: PageMeta) {
  const { title, description, path, url } = articleSeo(lang, meta);
  const dictionary = getDictionary(lang);

  return graph(
    ...siteNodes(lang, dictionary["metadata.description"]),
    {
      "@type": "TechArticle",
      "@id": `${url}#article`,
      headline: title,
      description,
      url,
      inLanguage: lang,
      isPartOf: { "@id": `${SITE_ORIGIN}/#website` },
      about: { "@id": `${SITE_ORIGIN}/#app` },
      publisher: { "@id": `${SITE_ORIGIN}/#organization` },
    },
    breadcrumbNode(
      [
        { name: SITE_NAME, path: "" },
        { name: dictionary["docs.metadata.title"], path: "docs" },
        { name: title, path },
      ],
      lang,
    ),
  );
}
