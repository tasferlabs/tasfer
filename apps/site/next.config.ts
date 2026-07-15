import type { NextConfig } from "next";
import createMDX from "@next/mdx";
import remarkGfm from "remark-gfm";
import remarkFrontmatter from "remark-frontmatter";
import remarkMdxFrontmatter from "remark-mdx-frontmatter";

/**
 * Tasfer site (marketing home + docs + privacy).
 *
 * Static export to match the existing static-hosting model (served behind the
 * same Traefik/CDN as the editor SPA). All pages are pre-rendered to plain
 * HTML; client components hydrate for interactivity (theme, search, scroll-spy).
 */
const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  // This app has its own lockfile; pin the tracing root so Next doesn't pick the
  // repo-root lockfile (the monorepo has no root package).
  outputFileTracingRoot: import.meta.dirname,
  // next/image optimization needs a server; the static export uses plain <img>.
  images: { unoptimized: true },
  // No ESLint setup in this app yet — don't block the production build on it.
  eslint: { ignoreDuringBuilds: true },
  // NEXT_PUBLIC_APP_URL (editor app base, default "" = same origin) is exposed
  // automatically via the NEXT_PUBLIC_ prefix.
};

/**
 * Remark plugin: carry a fenced code block's meta string (the part after the
 * language, e.g. ```ts file="main.ts") through to the rendered <code> as a
 * data-meta attribute. MDX/mdast-util-to-hast drops the meta otherwise, and
 * the docs `pre` component (CodeFence) needs it to rebuild the snippet header.
 * Setting it as hProperties at the mdast stage is the reliable path — node.meta
 * is always present here, before hast conversion can lose it.
 */
function remarkCodeMeta() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (tree: any) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const visit = (node: any) => {
      if (node?.type === "code" && node.meta) {
        node.data = node.data || {};
        node.data.hProperties = { ...node.data.hProperties, "data-meta": node.meta };
      }
      for (const child of node?.children ?? []) visit(child);
    };
    visit(tree);
  };
}

// The docs articles (src/views/DocsPage/pages/**/*.mdx) are MDX imported as
// components; routes themselves stay .tsx, so pageExtensions is untouched.
// Code samples are fenced blocks (markdown keeps their indentation intact —
// JSX attribute expressions don't) rendered through the mdx-components map.
// remarkFrontmatter parses the leading `---` YAML; remarkMdxFrontmatter then
// re-exports it as a named `frontmatter` export each .mdx module exposes
// (consumed by internalsNav.tsx). Order matters: parse before re-export.
const withMDX = createMDX({
  options: {
    remarkPlugins: [remarkGfm, remarkFrontmatter, remarkMdxFrontmatter, remarkCodeMeta],
  },
});

export default withMDX(nextConfig);
