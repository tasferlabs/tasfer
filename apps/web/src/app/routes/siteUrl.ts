/**
 * Base URL of the marketing/docs site (apps/site).
 *
 * This editor SPA owns the apex origin (https://tasfer.app); the marketing/docs
 * site is deployed on a separate origin (https://www.tasfer.app). Its /home,
 * /docs and /privacy routes must therefore be reached by absolute URL — a
 * same-origin path would resolve against this app, which does not serve them.
 * Override with `VITE_SITE_URL` (e.g. an empty string when both apps share an
 * origin behind one reverse proxy, or a different host in other deployments).
 */
export const SITE_URL =
  (import.meta.env as Record<string, string | undefined>).VITE_SITE_URL ??
  (import.meta.env.DEV ? "http://localhost:4100" : "https://www.tasfer.app");
