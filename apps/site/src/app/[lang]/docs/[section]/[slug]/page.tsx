import DocsArticle from "@/views/DocsPage/DocsArticle";
import { FLAT } from "@/views/DocsPage/docsNav";

export const dynamicParams = false;

export function generateStaticParams() {
  return FLAT.map((page) => {
    const [section, slug] = page.route.split("/");
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
