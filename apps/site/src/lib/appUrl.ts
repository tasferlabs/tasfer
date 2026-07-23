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
export const APP_OPEN_URL = !!process.env.VERCEL
  ? "/app/page"
  : `${APP_URL}/page`;
