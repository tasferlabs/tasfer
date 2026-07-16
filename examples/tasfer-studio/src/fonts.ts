import { notifyFontsLoaded } from "@tasfer/editor";

/**
 * The host owns font loading. `index.html` pulls the faces from Google Fonts;
 * here we wait until the browser has parsed the weights the canvas editor
 * measures against (the body sans + the code monospace), then notify the engine
 * so it flushes its metric cache and re-measures with the real glyphs.
 */
const FACES = [
  '400 1rem "Plus Jakarta Sans"',
  '600 1rem "Plus Jakarta Sans"',
  '700 1rem "Plus Jakarta Sans"',
  '400 1rem "JetBrains Mono"',
  '500 1rem "JetBrains Mono"',
];

export function loadEditorFonts(): void {
  if (typeof document === "undefined" || !document.fonts?.load) return;
  Promise.all(FACES.map((face) => document.fonts.load(face).catch(() => undefined)))
    .then(() => document.fonts.ready)
    .then(() => notifyFontsLoaded())
    .catch(() => undefined);
}
