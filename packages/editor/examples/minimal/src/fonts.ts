/**
 * Host-side font wiring.
 *
 * The editor ships NO fonts of its own. It renders text onto a <canvas>, which
 * means it has to *measure* glyphs before it can lay them out — so it needs the
 * faces to be loaded and it needs to be told which CSS font-stacks to measure
 * against. That is the host's job:
 *
 *   1. export a font registry (family keys → CSS font-stacks) and pass it to the
 *      editor as `theme.fonts` at mount (see main.ts)
 *   2. load the actual faces (here we just use system fonts, so there's nothing
 *      to download — but we still wait for document.fonts.ready)
 *   3. notifyFontsLoaded()  — flush the editor's metrics cache and repaint
 *
 * Swap the stacks below for a real web font (e.g. via @fontsource or a <link>)
 * and the only extra step is awaiting that face in loadFonts().
 */
import type { FontStyles } from "@cypherkit/editor";
import { notifyFontsLoaded } from "@cypherkit/editor";

// Our font registry. The keys ("sans"/"serif") are arbitrary — they're what
// you'd pass as `theme.fontFamily` (e.g. via `editor.setTheme({ fontFamily })`)
// to switch fonts at runtime. Pass this whole object as `theme.fonts` at mount.
export const FONT_STYLES: FontStyles = {
  families: {
    sans: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    serif: 'Georgia, "Times New Roman", Times, serif',
  },
  defaultFamily: "sans",
};

export async function loadFonts(): Promise<void> {
  // System fonts need no network load, but real web fonts would be awaited here,
  // e.g. `await new FontFace("Inter", "url(/inter.woff2)").load()` then add it to
  // document.fonts. We still wait for the browser's font pipeline to settle.
  if (document.fonts?.ready) {
    await document.fonts.ready;
  }
  // Tell the editor its metrics cache is stale — it re-measures and repaints.
  notifyFontsLoaded();
}
