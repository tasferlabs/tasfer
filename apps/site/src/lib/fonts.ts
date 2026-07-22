"use client";

/**
 * Arabic webfont loading for the site.
 *
 * Simplified from apps/web/src/fonts.ts: the editor font-registry plumbing is
 * gone (no canvas editor here), leaving only the dynamic @fontsource imports so
 * the Arabic faces are fetched lazily — only when the language is Arabic. The
 * base UI faces (Poppins / Libre Baskerville / Space Grotesk) are imported
 * eagerly in the root layout.
 *
 * Three Arabic faces, by role:
 *   Noto Sans Arabic     — UI text, backs the Poppins stack
 *   IBM Plex Sans Arabic — home page display, backs --font-editorial there
 */

let arabicFontsLoaded = false;
let arabicFontLoadingPromise: Promise<void> | null = null;

export async function loadArabicFonts(): Promise<void> {
  if (arabicFontsLoaded) return;
  if (arabicFontLoadingPromise) return arabicFontLoadingPromise;

  arabicFontLoadingPromise = (async () => {
    await Promise.all([
      import("@fontsource/noto-sans-arabic/400.css"),
      import("@fontsource/noto-sans-arabic/500.css"),
      import("@fontsource/noto-sans-arabic/600.css"),
      import("@fontsource/noto-sans-arabic/700.css"),
      import("@fontsource/ibm-plex-sans-arabic/400.css"),
      import("@fontsource/ibm-plex-sans-arabic/600.css"),
    ]);
    arabicFontsLoaded = true;
  })();

  return arabicFontLoadingPromise;
}
