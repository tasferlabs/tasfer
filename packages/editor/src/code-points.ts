// Code-point-aware stepping over document text.
//
// Text offsets are UTF-16 indices, so a character outside the BMP — every
// emoji, plus historic scripts and many CJK extensions — occupies TWO of them
// as a surrogate pair. Stepping by one index lands between the halves: the
// caret sits inside a character, and a delete leaves a lone surrogate behind,
// which is not text any font can draw and no longer round-trips through
// serialization. These helpers move a whole character at a time instead.
//
// Combining marks (Arabic harakāt, Hebrew niqqud) are deliberately NOT merged
// into the base letter here: they are separate characters, and deleting them
// one at a time is how vocalized text is corrected.

/** Whether `ch` is the leading half of a surrogate pair. */
export function isHighSurrogate(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return code >= 0xd800 && code <= 0xdbff;
}

/** Whether `ch` is the trailing half of a surrogate pair. */
export function isLowSurrogate(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return code >= 0xdc00 && code <= 0xdfff;
}

/** Whether `index` falls between the two halves of a surrogate pair in `text`. */
export function isMidSurrogatePair(text: string, index: number): boolean {
  if (index <= 0 || index >= text.length) return false;
  return isHighSurrogate(text[index - 1]) && isLowSurrogate(text[index]);
}

/**
 * The start offset of the character ending at `index` — one step backwards,
 * over a whole surrogate pair when there is one. Used by backward delete and
 * leftward caret motion.
 */
export function prevCodePointStart(text: string, index: number): number {
  const at = Math.max(0, Math.min(index, text.length));
  if (at === 0) return 0;
  return isMidSurrogatePair(text, at - 1) ? at - 2 : at - 1;
}

/**
 * The end offset of the character starting at `index` — one step forwards,
 * over a whole surrogate pair when there is one. Used by forward delete and
 * rightward caret motion.
 */
export function nextCodePointEnd(text: string, index: number): number {
  const at = Math.max(0, Math.min(index, text.length));
  if (at >= text.length) return text.length;
  return isMidSurrogatePair(text, at + 1) ? at + 2 : at + 1;
}

/**
 * Whether a keydown's `key` is a character to type rather than a named key.
 *
 * Named keys ("Enter", "ArrowLeft", "Dead") are multi-character ASCII words, so
 * the test is "exactly one character" — counted in CODE POINTS, not UTF-16
 * units. A `key.length === 1` check reads an emoji (a surrogate pair, and what
 * the macOS/Windows emoji pickers and the mobile keyboards deliver) as a named
 * key and silently drops it.
 */
export function isTextInputKey(key: string): boolean {
  const first = key.codePointAt(0);
  if (first === undefined) return false;
  return String.fromCodePoint(first).length === key.length;
}
