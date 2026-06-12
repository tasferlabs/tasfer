/**
 * Base URL of the marketing/docs site (apps/site).
 *
 * Empty string = same origin: /home, /docs and /privacy are served by the site
 * app behind the same reverse proxy as this editor SPA. Set `VITE_SITE_URL` to a
 * full origin (e.g. https://cypher.md) when the site is deployed on a separate
 * host/subdomain.
 */
export const SITE_URL =
  (import.meta.env as Record<string, string | undefined>).VITE_SITE_URL ?? "";
