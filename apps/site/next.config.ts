import type { NextConfig } from "next";
import createMDX from "@next/mdx";

/**
 * Cypher site (marketing home + docs + privacy).
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

// The docs articles (src/views/DocsPage/pages/**/*.mdx) are MDX imported as
// components; routes themselves stay .tsx, so pageExtensions is untouched.
const withMDX = createMDX({});

export default withMDX(nextConfig);
