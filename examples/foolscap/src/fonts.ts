import { notifyFontsLoaded } from "@tasfer/editor";

/**
 * Font loading is the host's job — the engine ships no faces and assumes they
 * are already loaded. `index.html` pulls the faces from Google Fonts; here we
 * wait until the browser has actually parsed the weights the canvas editor
 * measures against, then call `notifyFontsLoaded()` so the engine flushes its
 * (shared, pure) metric cache and re-measures with the real glyphs.
 */
const FACES = [
  '400 1rem "Spectral"',
  '500 1rem "Spectral"',
  '600 1rem "Spectral"',
  '700 1rem "Spectral"',
  'italic 400 1rem "Spectral"',
  '400 1rem "Plus Jakarta Sans"',
  '600 1rem "Plus Jakarta Sans"',
  '400 1rem "JetBrains Mono"',
];

export function loadEditorFonts(): void {
  if (typeof document === "undefined" || !document.fonts?.load) return;
  Promise.all(FACES.map((face) => document.fonts.load(face).catch(() => undefined)))
    .then(() => document.fonts.ready)
    .then(() => notifyFontsLoaded())
    .catch(() => undefined);
}
