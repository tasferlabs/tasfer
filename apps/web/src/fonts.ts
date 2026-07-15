/**
 * Font loading for the web app.
 *
 * The `@cypherkit/editor` package assumes its font faces are already loaded —
 * loading them, and notifying the editor when they're ready, is the host's
 * responsibility. This module imports the font CSS, drives the FontFace API,
 * and tells the editor to flush its metrics cache once fonts are available.
 */

// Poppins (multiple weights) — default sans-serif body face
import "@fontsource/poppins/400.css";
import "@fontsource/poppins/500.css";
import "@fontsource/poppins/600.css";
import "@fontsource/poppins/700.css";
// Libre Baskerville (multiple weights) — serif body face
import "@fontsource/libre-baskerville/400.css";
import "@fontsource/libre-baskerville/700.css";
// Space Grotesk — display face for large headlines and monograms
import "@fontsource/space-grotesk/400.css";
import "@fontsource/space-grotesk/500.css";
import "@fontsource/space-grotesk/600.css";
import "@fontsource/space-grotesk/700.css";

import type { FontStyles } from "@cypherkit/editor";
import { notifyFontsChanged, notifyFontsLoaded } from "@cypherkit/editor";
import { loadFonts as loadTexFonts } from "@cypherkit/tex";

// KaTeX math faces, imported straight from the @cypherkit/tex package source so
// Vite bundles+hashes them — no hand-copied duplicate under `public/fonts/tex`.
// Keyed by the emitted asset URL under their `KaTeX_<Variant>.woff2` basename.
const texFontModules = import.meta.glob<string>(
  "../../../packages/tex/src/fonts/*.woff2",
  { query: "?url", import: "default", eager: true },
);
const texFontUrls: Record<string, string> = {};
for (const [path, url] of Object.entries(texFontModules)) {
  const file = path.slice(path.lastIndexOf("/") + 1); // KaTeX_<Variant>.woff2
  texFontUrls[file] = url;
}

/**
 * Vite-hashed URL for a math font variant (e.g. `"Math-Italic"`), or undefined
 * if unknown. Exposed so the export path can inline these WOFF2 faces as
 * data-URL `@font-face`s — rendered math references the `CypherTeX_<Variant>`
 * families, which aren't loaded in the isolated print/PDF context.
 */
export function getTexFontUrl(variant: string): string | undefined {
  return texFontUrls[`KaTeX_${variant}.woff2`];
}

// The app's font families (key → CSS font-stack). These keys are what
// PageSettingsContext selects between (via `fontStyleToFamily`).
const POPPINS_STACK =
  'Poppins, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const LIBRE_BASKERVILLE_STACK =
  'Libre Baskerville, Georgia, "Times New Roman", Times, serif';

// Same stacks with the Arabic faces prepended — used once the Arabic fonts are
// loaded so Arabic text renders (and is measured) with the right glyphs.
const POPPINS_STACK_ARABIC = `"Noto Sans Arabic", ${POPPINS_STACK}`;
const LIBRE_BASKERVILLE_STACK_ARABIC = `Amiri, ${LIBRE_BASKERVILLE_STACK}`;

function buildRegistry(arabic: boolean): FontStyles {
  return {
    families: {
      poppins: arabic ? POPPINS_STACK_ARABIC : POPPINS_STACK,
      "libre-baskerville": arabic
        ? LIBRE_BASKERVILLE_STACK_ARABIC
        : LIBRE_BASKERVILLE_STACK,
    },
    defaultFamily: "poppins",
  };
}

// The app's editor font registry — one host-app config shared by every editor
// instance. The headless editor is no longer told about fonts via a global;
// instead each mounted editor receives this as `theme.fonts` and re-themes via
// `setTheme` when it changes (e.g. Arabic stacks swap in). A single app-level
// value here is fine — it is the host's config, not the engine's per-instance
// state.
let appFontRegistry: FontStyles = buildRegistry(false);
const fontRegistryListeners = new Set<() => void>();

/** The current editor font registry to pass as `theme.fonts` at mount. */
export function getAppFontRegistry(): FontStyles {
  return appFontRegistry;
}

/** Subscribe to registry changes (e.g. Arabic stacks loaded). Returns unsubscribe. */
export function onAppFontRegistryChange(cb: () => void): () => void {
  fontRegistryListeners.add(cb);
  return () => {
    fontRegistryListeners.delete(cb);
  };
}

function setAppFontRegistry(arabic: boolean): void {
  appFontRegistry = buildRegistry(arabic);
  for (const cb of [...fontRegistryListeners]) cb();
}

// Base font faces the editor measures against.
const FONT_CONFIGS = [
  { family: "Poppins", weight: "400" },
  { family: "Poppins", weight: "500" },
  { family: "Poppins", weight: "600" },
  { family: "Poppins", weight: "700" },
  { family: "Libre Baskerville", weight: "400" },
  { family: "Libre Baskerville", weight: "700" },
];

const ARABIC_FONT_CONFIGS = [
  { family: "Noto Sans Arabic", weight: "400" },
  { family: "Noto Sans Arabic", weight: "500" },
  { family: "Noto Sans Arabic", weight: "600" },
  { family: "Noto Sans Arabic", weight: "700" },
  { family: "Amiri", weight: "400" },
  { family: "Amiri", weight: "700" },
];

// Loading state (so each set of fonts is loaded at most once).
let fontsLoaded = false;
let fontLoadingPromise: Promise<void> | null = null;
let arabicFontsLoaded = false;
let arabicFontLoadingPromise: Promise<void> | null = null;

/**
 * Check if a specific font is loaded
 */
function isFontLoaded(family: string, weight: string): boolean {
  if (!document.fonts || !document.fonts.check) {
    // Fallback for browsers without FontFace API
    return true;
  }

  try {
    return document.fonts.check(`${weight} 1rem ${family}`);
  } catch (error) {
    console.warn(`Error checking font ${family} ${weight}:`, error);
    return true; // Assume loaded to prevent blocking
  }
}

/**
 * Load a single font with timeout
 */
function loadSingleFont(family: string, weight: string): Promise<void> {
  return new Promise((resolve) => {
    // Check if already loaded
    if (isFontLoaded(family, weight)) {
      resolve();
      return;
    }

    if (document.fonts && document.fonts.load) {
      // Use FontFace API
      document.fonts
        .load(`${weight} 1rem ${family}`)
        .then(() => {
          resolve();
        })
        .catch((error) => {
          console.warn(`Error loading font ${family} ${weight}:`, error);
          resolve(); // Resolve anyway to prevent blocking
        });
    } else {
      // Fallback: create invisible text element and wait for font to load
      const testElement = document.createElement("div");
      testElement.style.cssText = `
        position: absolute;
        left: -9999px;
        top: -9999px;
        font-family: ${family};
        font-weight: ${weight};
        font-size: 16px;
        visibility: hidden;
      `;
      testElement.textContent = "Test";
      document.body.appendChild(testElement);

      // Poll for font loading
      const checkInterval = setInterval(() => {
        if (isFontLoaded(family, weight)) {
          clearInterval(checkInterval);
          document.body.removeChild(testElement);
          resolve();
        }
      }, 100);
    }
  });
}

/**
 * Load all base fonts, then tell the editor they're ready so it can flush its
 * metrics cache and re-measure. Metrics are computed lazily on first use.
 */
export async function loadFonts(): Promise<void> {
  if (fontsLoaded) {
    return;
  }

  if (fontLoadingPromise) {
    return fontLoadingPromise;
  }

  fontLoadingPromise = Promise.all([
    ...FONT_CONFIGS.map(({ family, weight }) => loadSingleFont(family, weight)),
    // Math fonts for @cypherkit/tex (bundled from the package via Vite). On
    // completion the editor repaints, filling in math glyphs (their layout
    // dimensions are already exact from metric data before the faces load).
    loadTexFonts({
      urlFor: (variant) => texFontUrls[`KaTeX_${variant}.woff2`],
    }).catch(() => {}),
  ]).then(() => {
    fontsLoaded = true;
    notifyFontsLoaded();
  });

  return fontLoadingPromise;
}

/**
 * Dynamically load Arabic fonts (Noto Sans Arabic + Amiri).
 * Called when the language is set to Arabic. CSS is loaded via dynamic import
 * so the font files are only fetched when needed. Once loaded, the editor is
 * notified so it switches to the Arabic-aware font stacks.
 */
export async function loadArabicFonts(): Promise<void> {
  if (arabicFontsLoaded) return;
  if (arabicFontLoadingPromise) return arabicFontLoadingPromise;

  arabicFontLoadingPromise = (async () => {
    // Dynamically import the CSS files so they're only fetched for Arabic
    await Promise.all([
      import("@fontsource/noto-sans-arabic/400.css"),
      import("@fontsource/noto-sans-arabic/500.css"),
      import("@fontsource/noto-sans-arabic/600.css"),
      import("@fontsource/noto-sans-arabic/700.css"),
      import("@fontsource/amiri/400.css"),
      import("@fontsource/amiri/700.css"),
    ]);

    // Wait for the browser to actually load the font faces
    await Promise.all(
      ARABIC_FONT_CONFIGS.map(({ family, weight }) =>
        loadSingleFont(family, weight),
      ),
    );

    arabicFontsLoaded = true;
    // Swap in the Arabic-aware font stacks (mounted editors re-theme via their
    // registry subscription) and flush the editor's metrics cache to re-measure.
    setAppFontRegistry(true);
    notifyFontsChanged();
  })();

  return arabicFontLoadingPromise;
}
