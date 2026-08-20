import type { MetadataRoute } from "next";

import { SITE_ORIGIN } from "@/lib/seo";

export const dynamic = "force-static";

/**
 * The marketing site owns the apex, so this robots.txt also speaks for the
 * editor microfrontend mounted at /app.
 *
 * `/app/` is disallowed on purpose: it is a client-rendered workspace whose
 * URLs address a visitor's own documents. There is nothing there to index, and
 * crawling it only spends crawl budget that belongs to the docs. `/monitoring`
 * is the error-reporting tunnel.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/app/", "/page/", "/monitoring"],
      },
    ],
    sitemap: `${SITE_ORIGIN}/sitemap.xml`,
    host: SITE_ORIGIN,
  };
}
