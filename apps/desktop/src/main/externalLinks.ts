/**
 * Navigation policy for the main process.
 *
 * The renderer *is* the app: anything that navigates the window away from it, or
 * asks for a child window, is a url we did not choose — in practice a link out of
 * a document. Electron's defaults would honour both (a new BrowserWindow with our
 * preload and `sandbox: false` behind it), so both are refused here and handed to
 * the OS browser instead, where the page is just another tab.
 *
 * The allowlist mirrors `normalizeLinkUrl` in `packages/editor` — kept as a small
 * copy because the main process doesn't bundle the renderer's modules. Renderer
 * confirmation runs before this; this is the backstop for anything that reaches
 * the window without going through it.
 */

import { shell, type WebContents } from "electron";

const SAFE_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);

/** Hand a url to the OS browser, or drop it if its scheme isn't allowed. */
export function openExternally(rawUrl: string): void {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return;
  }
  if (!SAFE_PROTOCOLS.has(url.protocol)) return;
  void shell.openExternal(url.href);
}

/**
 * Apply the policy to a `webContents`: no child windows, no top-level navigation
 * off the app's own origin. `isAppUrl` decides what "our own" means — the dev
 * server in development, the packaged `file://` bundle otherwise.
 *
 * In-app routing is unaffected: React Router navigates with the history API,
 * which never fires `will-navigate`.
 */
export function applyNavigationPolicy(
  contents: WebContents,
  isAppUrl: (url: string) => boolean,
): void {
  contents.setWindowOpenHandler(({ url }) => {
    // The renderer opens a blank window it fills itself (the print/PDF fallback
    // in ExportDialog). It carries no foreign url, and the window it gets is
    // covered by this same policy once created.
    if (url === "about:blank") return { action: "allow" };
    openExternally(url);
    return { action: "deny" };
  });

  contents.on("will-navigate", (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    openExternally(url);
  });

  // Same rule one level down: an iframe must not navigate to a foreign origin
  // and inherit the window it sits in.
  contents.on("will-frame-navigate", (event) => {
    if (isAppUrl(event.url)) return;
    event.preventDefault();
  });
}
