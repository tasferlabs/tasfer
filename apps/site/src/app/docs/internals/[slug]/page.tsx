import InternalsArticle from "@/views/InternalsPage/InternalsArticle";
import { NOTES } from "@/views/InternalsPage/internalsNav";

/**
 * A single internal build-log note, routed at /docs/internals/:slug. The static
 * `internals` segment takes priority over the dynamic `docs/[section]/[slug]`
 * route, so these slugs resolve here. Only the notes in `internalsNav` are
 * emitted (static export); unknown slugs 404.
 */
export const dynamicParams = false;

export function generateStaticParams() {
  return NOTES.map((n) => ({ slug: n.slug }));
}

export default async function Page({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return <InternalsArticle slug={slug} />;
}
