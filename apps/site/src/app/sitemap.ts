import type { MetadataRoute } from "next";

import { SUPPORTED_LNGS, DEFAULT_LNG } from "@/lib/i18n/locales";
import { absoluteUrl, localizedPath } from "@/lib/seo";
import { FLAT } from "@/views/DocsPage/docsNav";

export const dynamic = "force-static";

/**
 * Locale-less routes worth indexing, most important first.
 *
 * Deliberately absent:
 *   - `/home` — the same page as `/`, and it declares `/` as its canonical.
 *   - `/docs/internals` and its notes — an unlinked build-log archive that
 *     ships `noindex`; listing it here would contradict that.
 *   - the unprefixed `/docs/...` stubs — redirect shells, already `noindex`.
 *
 * No `lastModified`: nothing here tracks per-page edit dates, and a timestamp
 * that moves on every deploy is a signal search engines learn to ignore.
 */
const ROUTES: { path: string; priority: number }[] = [
  { path: "", priority: 1 },
  { path: "download", priority: 0.9 },
  { path: "docs", priority: 0.8 },
  ...FLAT.map((page) => ({ path: `docs/${page.route}`, priority: 0.7 })),
  { path: "privacy", priority: 0.4 },
];

export default function sitemap(): MetadataRoute.Sitemap {
  return ROUTES.flatMap(({ path, priority }) => {
    const languages: Record<string, string> = {};
    for (const locale of SUPPORTED_LNGS) {
      languages[locale] = absoluteUrl(localizedPath(locale, path));
    }
    languages["x-default"] = absoluteUrl(localizedPath(DEFAULT_LNG, path));

    return SUPPORTED_LNGS.map((locale) => ({
      url: absoluteUrl(localizedPath(locale, path)),
      priority,
      alternates: { languages },
    }));
  });
}
