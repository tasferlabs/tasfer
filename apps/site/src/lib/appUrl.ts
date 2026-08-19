// Outside Vercel's microfrontend router, the editor SPA (apps/web) is served at
// its own origin. NEXT_PUBLIC_APP_URL overrides that origin; tasfer.app is the
// production default and localhost:4000 is the local development fallback.
export const APP_URL =
  process.env.NEXT_PUBLIC_APP_URL ??
  (process.env.NODE_ENV === "development"
    ? "http://localhost:4000"
    : "https://tasfer.app");

// Keep Vercel navigations on the current deployment origin so previews route
// to the corresponding editor preview through the microfrontend path mapping.
// The flag must be a NEXT_PUBLIC_ value: bare `process.env.VERCEL` survives
// into the client bundle as a runtime lookup that is always undefined there, so
// the browser would resolve every "open tasfer" link to the site origin — which
// serves the marketing 404, not the app. next.config.ts derives it from VERCEL.
// Legacy links to the unprefixed /page are covered by a redirect in vercel.json:
// the SPA's router basename is /app, so that path can't be proxied here.
export const APP_OPEN_URL = process.env.NEXT_PUBLIC_ON_VERCEL
  ? "/app/page"
  : `${APP_URL}/page`;
