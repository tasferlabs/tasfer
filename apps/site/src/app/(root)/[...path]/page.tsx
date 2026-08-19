import type { Metadata } from "next";

import RootRedirect from "@/app/RootRedirect";
import { FLAT } from "@/views/DocsPage/docsNav";
import { INTERNAL_NOTE_SLUGS } from "@/views/InternalsPage/internalNoteSlugs";

/**
 * Unprefixed mirrors of every localized page (`/home/` → `/en/home/`), so links
 * and bookmarks that predate the `[lang]` segment still land somewhere. Each one
 * is a generated stub whose only job is to bounce to the localized URL.
 *
 * Static export means the set has to be spelled out: a path missing here 404s
 * instead of redirecting, so new `[lang]` routes belong in this list too.
 */
const PAGES = [
  "home",
  "privacy",
  "download",
  "docs",
  "docs/internals",
  ...FLAT.map((page) => `docs/${page.route}`),
  ...INTERNAL_NOTE_SLUGS.map((slug) => `docs/internals/${slug}`),
];

export const dynamicParams = false;

// A stub duplicating a real page is not itself worth indexing; `follow` keeps
// crawlers walking through to the localized URL.
export const metadata: Metadata = { robots: { index: false, follow: true } };

export function generateStaticParams() {
  return PAGES.map((page) => ({ path: page.split("/") }));
}

export default async function LegacyPathPage({
  params,
}: {
  params: Promise<{ path: string[] }>;
}) {
  const { path } = await params;
  return <RootRedirect pathname={`/${path.join("/")}/`} />;
}
