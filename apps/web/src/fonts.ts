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
// Space Grotesk — display face reserved for the "Cypher" wordmark
import "@fontsource/space-grotesk/400.css";
import "@fontsource/space-grotesk/500.css";
import "@fontsource/space-grotesk/600.css";
import "@fontsource/space-grotesk/700.css";

import { notifyFontsChanged, notifyFontsLoaded } from "@cypherkit/editor/fonts";
import { setFontStyles } from "@cypherkit/editor/styles";

// The app's font families (key → CSS font-stack). These keys are what
// PageSettingsContext selects between via setCurrentFontFamily().
const POPPINS_STACK =
  'Poppins, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const LIBRE_BASKERVILLE_STACK =
  'Libre Baskerville, Georgia, "Times New Roman", Times, serif';

// Same stacks with the Arabic faces prepended — used once the Arabic fonts are
// loaded so Arabic text renders (and is measured) with the right glyphs.
const POPPINS_STACK_ARABIC = `"Noto Sans Arabic", ${POPPINS_STACK}`;
const LIBRE_BASKERVILLE_STACK_ARABIC = `Amiri, ${LIBRE_BASKERVILLE_STACK}`;

/**
 * Register the app's font families with the editor up front, before any editor
 * mounts. The editor ships no fonts of its own — this is what tells it which
 * stacks to render/measure with. Re-applied with Arabic-aware stacks once the
 * Arabic faces load (see loadArabicFonts).
 */
function registerFontStyles(arabic: boolean): void {
  setFontStyles({
    families: {
      poppins: arabic ? POPPINS_STACK_ARABIC : POPPINS_STACK,
      "libre-baskerville": arabic
        ? LIBRE_BASKERVILLE_STACK_ARABIC
        : LIBRE_BASKERVILLE_STACK,
    },
    defaultFamily: "poppins",
  });
}

registerFontStyles(false);

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

  fontLoadingPromise = Promise.all(
    FONT_CONFIGS.map(({ family, weight }) => loadSingleFont(family, weight)),
  ).then(() => {
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
    // Swap in the Arabic-aware font stacks and tell the editor to re-measure.
    registerFontStyles(true);
    notifyFontsChanged();
  })();

  return arabicFontLoadingPromise;
}
