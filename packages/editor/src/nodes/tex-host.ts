/**
 * Host-wired entry to `@cypherkit/tex`'s layout.
 *
 * The math engine is font-agnostic: on its own it can only lay out characters
 * its bundled KaTeX faces have metrics for, so anything else inside a `\text{…}`
 * run (CJK, emoji, …) would collapse to an invisible zero-width glyph. This
 * module supplies the ONE piece the engine can't have — a way to measure and
 * name a host font for those characters — so every math layout in the editor
 * (paint AND the caret/hit-test geometry that must agree with it) resolves them
 * the same way. Call {@link layoutMathHost} instead of `layoutMath` directly.
 */
import { measureTexFallbackEm } from "../fonts";
import {
  layoutMath,
  type LayoutOptions,
  type MathLayout,
  type TextFallback,
} from "@cypherkit/tex";

/**
 * The single CSS font `\text{…}` characters the math fonts can't render fall
 * back to. A generic family so the browser picks the platform's CJK/emoji face;
 * measurement and paint both use this exact string, so their geometry agrees.
 */
export const TEX_TEXT_FALLBACK_FONT = "sans-serif";

const TEXT_FALLBACK: TextFallback = {
  fontFamily: TEX_TEXT_FALLBACK_FONT,
  measure: (text) => measureTexFallbackEm(text, TEX_TEXT_FALLBACK_FONT),
};

/**
 * `layoutMath` with the host text-fallback wired in. Behaves identically to the
 * bare engine for pure-math and Latin-text formulas; additionally typesets
 * `\text{…}` characters the math fonts lack (CJK, …) via the host font.
 */
export function layoutMathHost(
  latex: string,
  opts: LayoutOptions = {},
): MathLayout {
  return layoutMath(latex, { ...opts, textFallback: TEXT_FALLBACK });
}
