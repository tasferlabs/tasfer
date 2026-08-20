import type { Metadata } from "next";

import { DEFAULT_LNG, SUPPORTED_LNGS, type Lng } from "./i18n/locales";

/** Canonical production origin. Every absolute URL the site emits derives from it. */
export const SITE_ORIGIN = "https://www.tasfer.app";

export const SITE_NAME = "Tasfer";

export const REPO_URL = "https://github.com/tasferlabs/tasfer";

/**
 * `trailingSlash` is on, so every page is served at a slashed URL. Canonicals,
 * hreflang targets and sitemap entries have to use that exact form — the
 * unslashed variant is a redirect, and pointing search engines at a redirect
 * splits the signal between two URLs.
 */
export function absoluteUrl(path: string): string {
  const clean = path.replace(/^\/+|\/+$/g, "");
  return clean ? `${SITE_ORIGIN}/${clean}/` : `${SITE_ORIGIN}/`;
}

/** `/download` → `/en/download/`. `path` is the locale-less route. */
export function localizedPath(lang: string, path = ""): string {
  const clean = path.replace(/^\/+|\/+$/g, "");
  return clean ? `/${lang}/${clean}/` : `/${lang}/`;
}

/**
 * Canonical + hreflang set for one locale-less route.
 *
 * The self-referencing hreflang is deliberate: Google requires every URL in an
 * alternates cluster to list the whole cluster, itself included. `x-default`
 * points at the default locale, which is where the unprefixed URLs land too.
 */
export function alternates(lang: Lng, path = ""): Metadata["alternates"] {
  const languages: Record<string, string> = {};
  for (const locale of SUPPORTED_LNGS) {
    languages[locale] = absoluteUrl(localizedPath(locale, path));
  }
  languages["x-default"] = absoluteUrl(localizedPath(DEFAULT_LNG, path));

  return { canonical: absoluteUrl(localizedPath(lang, path)), languages };
}

/* ── JSON-LD ────────────────────────────────────────────────────────────── */

/**
 * Structured data is emitted as plain objects and serialized by <JsonLd>.
 * Kept untyped-but-shaped rather than pulling in schema-dts: the graph here is
 * small and the vocabulary is stable.
 */
export type JsonLdNode = Record<string, unknown>;

export function organizationNode(): JsonLdNode {
  return {
    "@type": "Organization",
    "@id": `${SITE_ORIGIN}/#organization`,
    name: "Tasfer Labs",
    url: absoluteUrl(""),
    logo: `${SITE_ORIGIN}/logo.png`,
    sameAs: [REPO_URL],
  };
}

export function websiteNode(lang: Lng, name: string, description: string): JsonLdNode {
  return {
    "@type": "WebSite",
    "@id": `${SITE_ORIGIN}/#website`,
    name,
    description,
    url: absoluteUrl(localizedPath(lang)),
    inLanguage: lang,
    publisher: { "@id": `${SITE_ORIGIN}/#organization` },
  };
}

/**
 * The product itself. `offers` at price 0 is what marks a free application in
 * Google's software result — omitting it leaves the listing without the price
 * line rather than implying "free".
 */
export function softwareApplicationNode(
  lang: Lng,
  name: string,
  description: string,
): JsonLdNode {
  return {
    "@type": "SoftwareApplication",
    "@id": `${SITE_ORIGIN}/#app`,
    name,
    description,
    url: absoluteUrl(localizedPath(lang)),
    applicationCategory: "ProductivityApplication",
    operatingSystem: "macOS, iOS, Android, Web",
    inLanguage: lang,
    downloadUrl: absoluteUrl(localizedPath(lang, "download")),
    softwareHelp: absoluteUrl(localizedPath(lang, "docs")),
    license: "https://www.gnu.org/licenses/agpl-3.0.html",
    isAccessibleForFree: true,
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    publisher: { "@id": `${SITE_ORIGIN}/#organization` },
  };
}

/**
 * The nodes every page's graph repeats: the publisher, the site, and the
 * product the site is about. Each page ships a standalone graph, so a node
 * referenced by `@id` — as `isPartOf`, `about` and `publisher` do — has to be
 * defined in that same graph rather than assumed from another page.
 */
export function siteNodes(lang: Lng, description: string): JsonLdNode[] {
  return [
    organizationNode(),
    websiteNode(lang, SITE_NAME, description),
    softwareApplicationNode(lang, SITE_NAME, description),
  ];
}

export function breadcrumbNode(
  items: { name: string; path: string }[],
  lang: Lng,
): JsonLdNode {
  return {
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      item: absoluteUrl(localizedPath(lang, item.path)),
    })),
  };
}

/** Wraps nodes into the single `@graph` document a page emits. */
export function graph(...nodes: JsonLdNode[]): JsonLdNode {
  return { "@context": "https://schema.org", "@graph": nodes };
}
