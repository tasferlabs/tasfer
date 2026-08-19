import { APP_URL } from "@/lib/appUrl";

// Where the editor SPA's routes hang off: a path on this origin under Vercel's
// microfrontend routing, its own origin otherwise. The SPA's router basename is
// /app there, so its route paths append directly.
const APP_BASE = process.env.NEXT_PUBLIC_ON_VERCEL ? "/app" : APP_URL;

/**
 * "Does this browser already have a workspace?" — written by the app
 * (`apps/web/src/lib/workspaceMarker.ts`) on the origin it shares with this
 * site, alongside the route it was last on. The key names are spelled out in
 * both apps; change them together.
 *
 * The result is a JS *function expression*: callers invoke it and get `true`
 * once the navigation into the app has been started, so the unprefixed root
 * can fall through to its locale redirect on `false`. It runs as a blocking
 * inline script — before paint, so a returning visitor never sees the landing
 * page flash by. Crawlers and first-time visitors have no flag and simply stay.
 *
 * Nothing happens off this origin (a self-hosted app on another domain, or the
 * dev server on another port): the flag is unreadable, so the site keeps
 * showing the home page. /home is the home page unconditionally, either way.
 */
export const RESUME_INTO_APP_FN = `function(){try{
if(localStorage.getItem('tasfer.hasWorkspace')!=='1')return false;
var r=localStorage.getItem('lastRoute')||'';
if(!/^\\/[A-Za-z0-9\\/_-]*$/.test(r))r='/page';
location.replace(${JSON.stringify(APP_BASE)}+r);
return true;
}catch(e){return false;}}`.replace(/\n/g, "");

/** Blocking inline script for pages that show the home page at their own URL. */
export const RESUME_INTO_APP_SCRIPT = `(${RESUME_INTO_APP_FN})();`;
