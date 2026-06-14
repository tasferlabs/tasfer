import DocsArticle from "@/views/DocsPage/DocsArticle";
import { FLAT } from "@/views/DocsPage/docsNav";

/** Only the routes enumerated in the docs nav are emitted (static export). */
export const dynamicParams = false;

export function generateStaticParams() {
  return FLAT.map((p) => {
    const [section, slug] = p.route.split("/");
    return { section, slug };
  });
}

export default async function DocsArticlePage({
  params,
}: {
  params: Promise<{ section: string; slug: string }>;
}) {
  const { section, slug } = await params;
  return <DocsArticle section={section} slug={slug} />;
}
