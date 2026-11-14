/**
 * Font face naming and loading. Each KaTeX WOFF2 face is registered under its
 * own CSS family (one face per family, normal weight/style) — the italic /
 * bold shapes are baked into the font files, so we never rely on the browser's
 * synthetic style matching. `ctx.font` then only needs the family name.
 */
import type { FontVariant } from "../data/fontMetrics";

const FAMILY_PREFIX = "TasferTeX_";

/** CSS font-family name for a face variant. */
export function fontFamily(variant: FontVariant): string {
  return FAMILY_PREFIX + variant;
}

/**
 * Every font face the engine can draw with. {@link loadFonts} loads all of
 * them unless you pass a shorter `variants` list.
 */
export const ALL_VARIANTS: FontVariant[] = [
  "Main-Regular",
  "Main-Bold",
  "Main-Italic",
  "Main-BoldItalic",
  "Math-Italic",
  "Math-BoldItalic",
  "AMS-Regular",
  "Size1-Regular",
  "Size2-Regular",
  "Size3-Regular",
  "Size4-Regular",
  "Caligraphic-Regular",
  "Fraktur-Regular",
  "SansSerif-Regular",
  "Script-Regular",
  "Typewriter-Regular",
];

/**
 * Options for {@link loadFonts}: where the font files are served from and
 * which faces to load. You must give either `baseUrl` or `urlFor`.
 */
export interface LoadFontsOptions {
  /**
   * Base URL the `KaTeX_<Variant>.woff2` files are served from. Used to build
   * each face URL as `<baseUrl>/KaTeX_<Variant>.woff2`. Ignored when `urlFor`
   * is provided.
   */
  baseUrl?: string;
  /**
   * Resolve the URL for a given face variant. Takes precedence over `baseUrl`.
   * Lets a bundler-based host (e.g. Vite) supply the hashed asset URL it
   * emitted for each `.woff2`, so the faces can be imported straight from the
   * package instead of being copied to a public directory.
   */
  urlFor?: (variant: FontVariant) => string;
  /** Which faces to load (defaults to all). */
  variants?: FontVariant[];
  /** FontFace registry to add to (defaults to `document.fonts`). */
  fontSet?: FontFaceSet;
}

/**
 * Load the math fonts and add them to the page, so {@link paintMath} and
 * {@link toSVG} can draw with them. Resolves when every requested face is
 * ready. Formulas painted before that will not use the math fonts, so redraw
 * when it resolves. Rejects if you give neither `baseUrl` nor `urlFor`, or if a
 * face fails to load.
 */
export async function loadFonts(opts: LoadFontsOptions): Promise<void> {
  const set = opts.fontSet ?? document.fonts;
  const variants = opts.variants ?? ALL_VARIANTS;
  if (!opts.urlFor && opts.baseUrl == null) {
    throw new Error("loadFonts requires either `urlFor` or `baseUrl`");
  }
  const base = opts.baseUrl?.replace(/\/$/, "");
  const urlFor =
    opts.urlFor ?? ((variant) => `${base}/KaTeX_${variant}.woff2`);
  await Promise.all(
    variants.map(async (variant) => {
      const face = new FontFace(
        fontFamily(variant),
        `url("${urlFor(variant)}") format("woff2")`,
      );
      await face.load();
      set.add(face);
    }),
  );
}
