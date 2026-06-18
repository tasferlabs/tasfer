/**
 * Host-side font wiring.
 *
 * The editor ships NO fonts of its own. It renders text onto a <canvas>, which
 * means it has to *measure* glyphs before it can lay them out — so it needs the
 * faces to be loaded and it needs to be told which CSS font-stacks to measure
 * against. That is the host's job:
 *
 *   1. export a font registry (family keys → CSS font-stacks) and pass it to the
 *      editor once as `theme.fonts` at mount (see main.ts)
 *   2. load the actual faces (here we just use system fonts, so there's nothing
 *      to download — but we still wait for document.fonts.ready)
 *   3. notifyFontsLoaded()  — flush the editor's metrics cache and repaint
 *
 * Typography is half of "restyling fully": each theme in themes.ts selects one
 * of the families below via `theme.fontFamily`, and switching it at runtime is a
 * plain `editor.setTheme({ fontFamily })` — the registry never changes, only the
 * *selected* family does. Three visually distinct system typefaces (humanist
 * sans, transitional serif, monospace) are enough to make the swap obvious with
 * zero network dependency; swap a stack for a real web font (e.g. @fontsource or
 * a <link>) and the only extra step is awaiting that face in loadFonts().
 */
import type { FontStyles } from "@cypherkit/editor";
import { notifyFontsLoaded } from "@cypherkit/editor";

// Our font registry. The keys ("sans"/"serif"/"mono") are arbitrary — they are
// exactly the values a theme passes as `theme.fontFamily`. Pass this whole
// object as `theme.fonts` at mount; it's per-instance, so two editors on a page
// can register entirely different fonts without clobbering each other.
export const FONT_STYLES: FontStyles = {
  families: {
    sans: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    serif:
      'Iowan Old Style, "Palatino Linotype", Palatino, Georgia, "Times New Roman", serif',
    mono: 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
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
