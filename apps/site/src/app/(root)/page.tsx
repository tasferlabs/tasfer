import type { Metadata } from "next";

import RootRedirect from "@/app/RootRedirect";
import { getDictionary, DEFAULT_LNG } from "@/lib/i18n/locales";
import { absoluteUrl, localizedPath } from "@/lib/seo";

/**
 * The apex is the site's most-linked URL, and it is a redirect shell — so it
 * needs its own head. Without a canonical, search engines index the bare
 * bouncer; with one, every link to `/` consolidates into the localized landing
 * page. Title and description are there for the crawlers and previews that
 * read the apex before the redirect runs.
 *
 * `(root)` sits outside `[lang]`, so there is no `metadataBase` above it to
 * resolve a relative URL against — these are absolute on purpose.
 */
export async function generateMetadata(): Promise<Metadata> {
  const dictionary = getDictionary(DEFAULT_LNG);
  return {
    title: dictionary["metadata.title"],
    description: dictionary["metadata.description"],
    alternates: { canonical: absoluteUrl(localizedPath(DEFAULT_LNG)) },
  };
}

export default function Page() {
  return <RootRedirect pathname="/" resumeIntoApp />;
}
