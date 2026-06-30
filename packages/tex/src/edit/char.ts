/**
 * Edit-time classification of a single typed character: can the math engine
 * actually render it?
 *
 * Why this exists: a literal character with no font metric (an Arabic letter, a
 * CJK ideograph, an emoji, …) is not rejected by the parser — `symbolFor`
 * synthesizes an ordinary `textord` atom for it, and {@link glyphBox} then falls
 * back to a ZERO-width, zero-height glyph that paints nothing. Worse, a
 * zero-width glyph emits no caret stop, so the character is invisible AND
 * un-landable: it sits in the source as "latent" content the user can neither
 * see nor delete. A host can call this before committing a typed character to
 * drop it instead of letting it rot in the document.
 */
import { getCharacterMetrics, resolveFontVariant } from "../data/fontMetrics";
import { symbolFor } from "../parse/parser";

// Characters the lexer treats structurally rather than as literal glyphs — they
// drive grouping (`{` `}`), scripts (`^` `_`), alignment (`&`), commands (`\`),
// and spacing. They shape the formula even when they have no glyph of their own,
// so they are always "renderable" regardless of the metric table.
const STRUCTURAL = new Set([
  "\\",
  "{",
  "}",
  "^",
  "_",
  "&",
  " ",
  "\t",
  "\n",
  "\r",
]);

/**
 * Whether the single character `ch`, typed as math content, produces a visible,
 * caret-landable glyph (or is a structural character). Mirrors the layout path
 * for one literal char atom — `symbolFor` to resolve the glyph and font, then a
 * metric lookup — so it stays in sync with what actually renders. Returns false
 * for characters that would lay out as the empty zero-width fallback glyph.
 */
export function canRenderMathChar(ch: string): boolean {
  if (STRUCTURAL.has(ch)) return true;
  const info = symbolFor(ch);
  return getCharacterMetrics(info.char, resolveFontVariant(info)) !== null;
}
