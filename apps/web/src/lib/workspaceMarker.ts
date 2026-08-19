/**
 * A yes/no hint for the marketing site: does this browser already hold a
 * workspace? The site is served from the same origin as the app (it routes
 * `/app/*` here), so its landing page can read this key and send a returning
 * visitor straight back into the editor instead of showing the pitch.
 *
 * Nothing in the app reads it, and it carries no content — only the flag.
 * The reader is `apps/site/src/lib/appResume.ts`; the key is spelled out in
 * both places, so change them together.
 */

const KEY = "tasfer.hasWorkspace";

export function setHasWorkspace(has: boolean): void {
  try {
    if (has) window.localStorage.setItem(KEY, "1");
    else window.localStorage.removeItem(KEY);
  } catch {
    // Storage unavailable — the site simply keeps showing the home page.
  }
}
