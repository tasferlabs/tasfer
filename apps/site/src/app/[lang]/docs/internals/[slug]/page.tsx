import InternalsArticle from "@/views/InternalsPage/InternalsArticle";
import { INTERNAL_NOTE_SLUGS } from "@/views/InternalsPage/internalNoteSlugs";

export const dynamicParams = false;

export function generateStaticParams() {
  return INTERNAL_NOTE_SLUGS.map((slug) => ({ slug }));
}

export default async function Page({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return <InternalsArticle slug={slug} />;
}
