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
 * Load the WOFF2 faces via the `FontFace` API and add them to the document's
 * font set. Resolves once every requested face is ready, so a caller can paint
 * crisp glyphs immediately afterward (before that, `paintMath` simply draws
 * nothing for not-yet-loaded faces — drive a redraw on completion).
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
