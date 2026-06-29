/**
 * Pure helpers for the hidden contenteditable **input surface** — the offscreen
 * element the OS keyboard types into. To make native predictive text /
 * autocorrect work, the surface holds the word currently being typed (a leading
 * {@link SURFACE_SENTINEL} plus the word) rather than being wiped after every
 * keystroke, and the editor reconciles that surface against the document.
 *
 * These functions are deliberately DOM-free and side-effect-free so they can be
 * unit-tested in isolation; the wiring lives in `entries/editor.ts`.
 */

/**
 * The single character that always leads the input surface. It gives the OS
 * keyboard a real character before the caret (so Android keeps emitting
 * `deleteContentBackward` on backspace) and, being a regular space, is a true
 * WORD BOUNDARY — so the keyboard treats the typed buffer as a fresh word and
 * offers predictions/autocorrect for it. A non-breaking space would NOT work:
 * WebKit (iOS) treats NBSP as part of the word, so its predictive-text engine
 * never sees a real word. `white-space: pre` on the surface keeps this space
 * from collapsing, and the editor re-seeds it if it is ever trimmed.
 */
export const SURFACE_SENTINEL = " ";

/**
 * Whether `ch` separates words. Whitespace (including NBSP and other Unicode
 * spaces) ends the current word; everything else extends it. Used to find the
 * word under the caret that the surface should mirror.
 */
export function isWordBoundaryChar(ch: string | undefined): boolean {
  if (!ch) return true;
  // \s covers space, tab, newline, NBSP, and other Unicode spaces.
  return /\s/.test(ch);
}

/**
 * The start offset of the word ending at `caret` within `text`: the index just
 * after the last boundary character before the caret (0 when the caret is in the
 * first word). The word itself is `text.slice(start, caret)`.
 */
export function currentWordStart(text: string, caret: number): number {
  let start = Math.max(0, Math.min(caret, text.length));
  while (start > 0 && !isWordBoundaryChar(text[start - 1])) start--;
  return start;
}

/** A minimal `[deleteStart, deleteEnd) → insert` edit derived from two strings. */
export interface SurfaceDelta {
  /** Start offset (in `prev`) of the replaced span. */
  deleteStart: number;
  /** End offset (in `prev`, exclusive) of the replaced span. */
  deleteEnd: number;
  /** Text inserted in place of `prev[deleteStart, deleteEnd)`. */
  insert: string;
}

/** True when the delta changes nothing (empty deletion and empty insertion). */
export function isEmptyDelta(d: SurfaceDelta): boolean {
  return d.deleteStart === d.deleteEnd && d.insert.length === 0;
}

// Back up an index off the low half of a surrogate pair so a delta never splits
// an astral character (emoji): if `text[i]` is a low surrogate and `text[i-1]`
// is a high surrogate, the boundary at `i` sits mid-character.
function snapToCodePointBoundary(text: string, i: number): number {
  if (i <= 0 || i >= text.length) return i;
  const lead = text.charCodeAt(i - 1);
  const trail = text.charCodeAt(i);
  const isPair =
    lead >= 0xd800 && lead <= 0xdbff && trail >= 0xdc00 && trail <= 0xdfff;
  return isPair ? i - 1 : i;
}

/**
 * Compute the minimal single-span edit turning `prev` into `next` by stripping
 * the common prefix and the common suffix. The result `{ deleteStart, deleteEnd,
 * insert }` means: replace `prev[deleteStart, deleteEnd)` with `insert`.
 *
 * This models how a contenteditable's text changes on a keystroke, an autocorrect
 * swap, or a predictive-text replacement — a single contiguous region changes —
 * so the caller can translate it to one CRDT replace at the matching document
 * offsets. Boundaries are snapped so an astral character is never split.
 */
export function computeSurfaceDelta(prev: string, next: string): SurfaceDelta {
  const maxPrefix = Math.min(prev.length, next.length);
  let p = 0;
  while (p < maxPrefix && prev[p] === next[p]) p++;

  // Common suffix, not overlapping the matched prefix on either string.
  let s = 0;
  const maxSuffix = Math.min(prev.length - p, next.length - p);
  while (
    s < maxSuffix &&
    prev[prev.length - 1 - s] === next[next.length - 1 - s]
  ) {
    s++;
  }

  let deleteStart = p;
  let deleteEnd = prev.length - s;

  // Don't split a surrogate pair at either boundary; widen the replaced span.
  deleteStart = snapToCodePointBoundary(prev, deleteStart);
  deleteEnd = Math.max(deleteStart, snapToCodePointBoundary(prev, deleteEnd));

  const insert = next.slice(
    deleteStart,
    next.length - (prev.length - deleteEnd),
  );

  return { deleteStart, deleteEnd, insert };
}
