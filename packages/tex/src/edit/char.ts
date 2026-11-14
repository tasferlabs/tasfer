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
 * Returns `true` when the character `ch`, typed into a formula, would show up
 * and the caret can stop at it. It is also `true` for LaTeX structure
 * characters: `\`, `{`, `}`, `^`, `_`, `&` and whitespace.
 *
 * Returns `false` when the math fonts have no glyph for it, such as an emoji.
 * That character would draw nothing and the user could not see or delete it. A
 * host can use this to drop the character instead of inserting it.
 *
 * @group Rendering
 */
// Mirrors the layout path for one literal char atom (symbolFor, then a metric
// lookup) so it stays in sync with what renders.
export function canRenderMathChar(ch: string): boolean {
  if (STRUCTURAL.has(ch)) return true;
  const info = symbolFor(ch);
  return getCharacterMetrics(info.char, resolveFontVariant(info)) !== null;
}
