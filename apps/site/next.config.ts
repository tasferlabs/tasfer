import type { NextConfig } from "next";
import createMDX from "@next/mdx";
import { withMicrofrontends } from "@vercel/microfrontends/next/config";
import { fileURLToPath } from "node:url";

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
  // TypeScript 7 has no JS compiler API; invoke the native tsc CLI instead.
  experimental: { useTypeScriptCli: true },
  // The repo curates its own AGENTS.md/CLAUDE.md at the root; don't let
  // `next dev` generate per-app ones.
  agentRules: false,
  // NEXT_PUBLIC_APP_URL (editor app base, default "" = same origin) is exposed
  // automatically via the NEXT_PUBLIC_ prefix.
};

// The docs articles (src/views/DocsPage/pages/**/*.mdx) are MDX imported as
// components; routes themselves stay .tsx, so pageExtensions is untouched.
// Code samples are fenced blocks (markdown keeps their indentation intact —
// JSX attribute expressions don't) rendered through the mdx-components map.
// remarkFrontmatter parses the leading `---` YAML; remarkMdxFrontmatter then
// re-exports it as a named `frontmatter` export each .mdx module exposes
// (consumed by internalsNav.tsx). Order matters: parse before re-export.
// Plugins are path/name strings (not imported functions): Turbopack requires
// MDX loader options to be serializable. remarkCodeMeta (meta string → data-meta
// attribute for CodeFence) lives in scripts/remark-code-meta.mjs.
const withMDX = createMDX({
  options: {
    remarkPlugins: [
      "remark-gfm",
      "remark-frontmatter",
      "remark-mdx-frontmatter",
      fileURLToPath(new URL("./scripts/remark-code-meta.mjs", import.meta.url)),
    ],
  },
});

export default withMicrofrontends(withMDX(nextConfig));
