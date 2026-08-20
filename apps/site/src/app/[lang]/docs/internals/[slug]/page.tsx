import type { Metadata } from "next";

import InternalsArticle from "@/views/InternalsPage/InternalsArticle";
import { INTERNAL_NOTE_SLUGS } from "@/views/InternalsPage/internalNoteSlugs";
import { NOTE_BY_SLUG } from "@/views/InternalsPage/internalsNav";

export const dynamicParams = false;

export function generateStaticParams() {
  return INTERNAL_NOTE_SLUGS.map((slug) => ({ slug }));
}

/**
 * These notes are `noindex` (see the layout), but a shared link still deserves
 * a real title and card, so the frontmatter carries into the page metadata.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const note = NOTE_BY_SLUG[slug];
  if (!note) return {};

  return {
    title: note.title,
    description: note.summary || undefined,
    openGraph: {
      type: "article",
      title: note.title,
      description: note.summary || undefined,
      publishedTime: note.date,
      authors: note.authors,
    },
    twitter: { card: "summary_large_image", title: note.title, description: note.summary || undefined },
  };
}

export default async function Page({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return <InternalsArticle slug={slug} />;
}
