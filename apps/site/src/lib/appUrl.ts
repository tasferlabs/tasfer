// The editor SPA (apps/web) is a separate app served at its own origin
// (https://tasfer.app, the apex), while this marketing site is served from a
// different origin (www.tasfer.app). Opening Tasfer must therefore be an
// absolute full-page navigation to the app origin — a same-origin "/page" or a
// next/link client route would resolve against the marketing site, which does
// not serve the editor, and 404. NEXT_PUBLIC_APP_URL overrides the base;
// https://tasfer.app is the prod default, localhost:4000 is the dev fallback.
export const APP_URL =
  process.env.NEXT_PUBLIC_APP_URL ??
  (process.env.NODE_ENV === "development" ? "http://localhost:4000" : "https://tasfer.app");

export const APP_OPEN_URL = `${APP_URL}/page`;
