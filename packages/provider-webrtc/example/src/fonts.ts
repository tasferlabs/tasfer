/**
 * Host-side font wiring (identical to the editor's collab example).
 *
 * The editor renders to <canvas>, so it must *measure* glyphs before laying
 * them out — the host loads the faces and tells the editor which CSS font
 * stacks to measure. We use system fonts here, so there is nothing to download.
 */
import type { FontStyles } from "@cypherkit/editor";
import { notifyFontsLoaded } from "@cypherkit/editor";

export const FONT_STYLES: FontStyles = {
  families: {
    sans: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    serif: 'Georgia, "Times New Roman", Times, serif',
  },
  defaultFamily: "sans",
};

export async function loadFonts(): Promise<void> {
  if (document.fonts?.ready) await document.fonts.ready;
  notifyFontsLoaded();
}
