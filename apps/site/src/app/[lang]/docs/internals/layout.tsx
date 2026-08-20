import type { Metadata } from "next";

import { InternalsEnglishProvider } from "@/views/InternalsPage/InternalsEnglishProvider";

/**
 * The internal notes are an unlinked build log: nothing in the docs nav, the
 * pager or the search reaches them, and they stay out of the sitemap. `noindex`
 * makes that intent explicit to crawlers that find them another way. `follow`
 * still lets the links inside a note carry weight to the pages that are public.
 */
export const metadata: Metadata = { robots: { index: false, follow: true } };

export default function InternalsLayout({ children }: { children: React.ReactNode }) {
  return <InternalsEnglishProvider>{children}</InternalsEnglishProvider>;
}
