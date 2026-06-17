/**
 * Math rendering adapter — backed by `@cypherkit/tex`, the canvas-native LaTeX
 * engine. Replaces the former MathJax pipeline (SVG → bitmap → drawImage): the
 * engine lays out a formula synchronously from a metric data table and paints it
 * straight onto the canvas with `fillText`/`fillRect`, so there is no async
 * render, no per-color bitmap cache, and no 3.5 MB bundle.
 *
 * The block/inline nodes paint directly via `layoutMath` + `paintMath` (see
 * `MathNode`/`MathMark`); this module exposes only the small surface the rest of
 * the editor needs: inline dimensions (for line layout), an SVG string (for the
 * React edit overlay and HTML export), and a validity check.
 */
import { isValidLatex, layoutMath, toSVG } from "@cypherkit/tex";

export { isValidLatex };

export interface InlineMathDims {
  width: number;
  height: number;
  /** Distance the formula hangs below the text baseline, in CSS pixels. */
  depthBelowBaseline: number;
}

/**
 * Inline math dimensions in CSS pixels for a font size. Synchronous and exact
 * (metrics are a data table, not an async measurement). Returns null for empty
 * input.
 */
export function getInlineMathDims(
  latex: string,
  fontSize: number,
): InlineMathDims | null {
  if (!latex) return null;
  const l = layoutMath(latex, { fontSize, displayMode: false });
  return {
    width: l.width,
    height: l.height + l.depth,
    depthBelowBaseline: l.depth,
  };
}

/**
 * Render LaTeX to an SVG string (used by the React edit overlay's live preview
 * and by HTML export). `color` defaults to `currentColor` so the SVG inherits
 * the surrounding text color. The `<text>` elements reference the engine's font
 * families, which the host loads via `@cypherkit/tex`'s `loadFonts`.
 */
export function renderToSVG(
  latex: string,
  displayMode: boolean,
  fontSize = displayMode ? 22 : 18,
  color = "currentColor",
): string {
  const l = layoutMath(latex, { fontSize, displayMode });
  return toSVG(l, { color });
}
