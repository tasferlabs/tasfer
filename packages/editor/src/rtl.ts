/**
 * RTL (Right-to-Left) text handling utilities
 * Provides functions to detect and handle RTL languages like Arabic, Hebrew, Persian, etc.
 */

import type { MarkRegistry } from "./rendering/marks/Mark";
import type { CharRun, MarkSpan } from "./serlization/loadPage";
import { iterateVisibleChars } from "./sync/char-runs";

/**
 * The block content the direction heuristic reads: its visible characters
 * (`charRuns`) and the mark spans over them (`formats`). A structural shape so
 * `rtl.ts` stays decoupled from concrete block types; every textual block
 * satisfies it.
 */
export interface DirectionalContent {
  charRuns?: CharRun[];
  formats?: MarkSpan[];
}

/**
 * Unicode ranges for RTL scripts
 * Based on Unicode standard for strong RTL characters
 */
const RTL_RANGES = [
  [0x0590, 0x05ff], // Hebrew
  [0x0600, 0x06ff], // Arabic
  [0x0700, 0x074f], // Syriac
  [0x0750, 0x077f], // Arabic Supplement
  [0x0780, 0x07bf], // Thaana
  [0x07c0, 0x07ff], // NKo
  [0x0800, 0x083f], // Samaritan
  [0x0840, 0x085f], // Mandaic
  [0x08a0, 0x08ff], // Arabic Extended-A
  [0xfb1d, 0xfb4f], // Hebrew presentation forms
  [0xfb50, 0xfdff], // Arabic presentation forms A
  [0xfe70, 0xfeff], // Arabic presentation forms B
];

/**
 * Check if a character is an RTL character
 */
export function isRTLChar(char: string): boolean {
  if (!char || char.length === 0) return false;
  const code = char.charCodeAt(0);

  for (const [start, end] of RTL_RANGES) {
    if (code >= start && code <= end) {
      return true;
    }
  }

  return false;
}

/**
 * Detect the dominant text direction of a string
 * Returns 'rtl' if the text is predominantly RTL, 'ltr' otherwise
 */
/**
 * Get the default text direction based on the current app language.
 */
export function getDefaultDirection(): "rtl" | "ltr" {
  if (document.dir == "rtl") {
    return "rtl";
  } else {
    return "ltr";
  }
}

export function getTextDirection(text: string): "rtl" | "ltr" {
  if (!text || text.length === 0) return getDefaultDirection();

  let rtlCount = 0;
  let ltrCount = 0;

  for (const char of text) {
    if (isRTLChar(char)) {
      rtlCount++;
    } else if (/[a-zA-Z]/.test(char)) {
      // Count Latin letters as LTR
      ltrCount++;
    }
  }

  // If more than 30% of directional characters are RTL, treat as RTL
  const totalDirectional = rtlCount + ltrCount;
  if (totalDirectional === 0) return getDefaultDirection();

  return rtlCount / totalDirectional > 0.3 ? "rtl" : "ltr";
}
const EMPTY_STRING_SET: ReadonlySet<string> = new Set();

/**
 * Character IDs whose glyphs are drawn by a REPLACEMENT mark (inline math) and
 * so must not influence the block's text direction. A replacement mark paints
 * its own rendering instead of the run's source characters — an inline math
 * chip's visible chars ARE its LaTeX (`\text{عربي}` carries Arabic letters) —
 * so counting that source would let a formula flip a Latin paragraph to RTL even
 * though the reader never sees those characters. This stays mark-agnostic: it
 * asks the registry which mark types are replacements rather than naming math.
 */
function replacementCoveredCharIds(
  content: DirectionalContent,
  marks: MarkRegistry | undefined,
): ReadonlySet<string> {
  const { charRuns, formats } = content;
  if (!charRuns || !formats || formats.length === 0 || !marks)
    return EMPTY_STRING_SET;

  const spans = formats.filter((f) => marks.get(f.format.type)?.replacement);
  if (spans.length === 0) return EMPTY_STRING_SET;

  // A span covers [startCharId, endCharId] inclusive. Walk the visible chars in
  // document order, opening at each start and closing after each end, so a char
  // is covered whenever at least one replacement span is open (depth > 0).
  const starts = new Map<string, number>();
  const ends = new Map<string, number>();
  for (const span of spans) {
    starts.set(span.startCharId, (starts.get(span.startCharId) ?? 0) + 1);
    ends.set(span.endCharId, (ends.get(span.endCharId) ?? 0) + 1);
  }

  const covered = new Set<string>();
  let depth = 0;
  for (const { id } of iterateVisibleChars(charRuns)) {
    depth += starts.get(id) ?? 0;
    if (depth > 0) covered.add(id);
    depth -= ends.get(id) ?? 0;
  }
  return covered;
}

/** Count the block's strongly-directional characters, ignoring any that a
 *  replacement mark (inline math) draws over — those are not text to the reader. */
function countDirectionalChars(
  content: DirectionalContent,
  marks: MarkRegistry | undefined,
): { rtl: number; ltr: number } {
  const charRuns = content.charRuns;
  if (!charRuns) return { rtl: 0, ltr: 0 };

  const covered = replacementCoveredCharIds(content, marks);
  let rtl = 0;
  let ltr = 0;
  for (const { id, char } of iterateVisibleChars(charRuns)) {
    if (covered.has(id)) continue;
    if (isRTLChar(char)) {
      rtl++;
    } else if (/[a-zA-Z]/.test(char)) {
      ltr++;
    }
  }
  return { rtl, ltr };
}

/**
 * A block's base text direction, the canonical block-level counterpart to
 * {@link getTextDirection}. Source characters that a replacement mark renders
 * over (inline math) are excluded so a formula never flips the paragraph's
 * direction — RTL inside a math chip does not count toward the block direction.
 * Falls back to the UI default when the block has no directional text.
 */
export function getBlockDirection(
  content: DirectionalContent,
  marks?: MarkRegistry,
): "rtl" | "ltr" {
  const { rtl, ltr } = countDirectionalChars(content, marks);
  const total = rtl + ltr;
  if (total === 0) return getDefaultDirection();
  return rtl / total > 0.3 ? "rtl" : "ltr";
}

/**
 * Whether a block is predominantly RTL. Like {@link getBlockDirection} but
 * returns `false` (not the UI default) for a block with no directional text,
 * matching the callers that only care about an explicit RTL lean.
 */
export function isBlockRTL(
  content: DirectionalContent,
  marks?: MarkRegistry,
): boolean {
  const { rtl, ltr } = countDirectionalChars(content, marks);
  const total = rtl + ltr;
  if (total === 0) return false;
  return rtl / total > 0.3;
}
