// Character classification for word-wise operations: double-click / double-tap
// word selection, word-wise cursor movement (Ctrl/Alt+Arrow), and word-wise
// deletion (Ctrl/Alt+Backspace). Kept separate from `cjk.ts` because CJK is
// handled specially (each ideograph is its own word); this defines what counts
// as an ordinary word character.
//
// The class includes:
//   \p{L}  letters in every script
//   \p{N}  numbers
//   \p{M}  combining marks — Arabic harakāt, Hebrew niqqud, Indic matras and
//          viramas, Thai vowel signs, etc. A mark attaches to a base letter and
//          is an integral part of the word; excluding it splits vocalized text
//          mid-token (e.g. a double-click on "مَرحَبًا" would select only a
//          fragment between two diacritics).
//   _      underscore, so identifiers stay a single word
//   ZWNJ (U+200C) and ZWJ (U+200D) — zero-width joiners used inside Persian,
//          Arabic and Indic words to control letter joining without introducing
//          a word break.
const WORD_CHAR = /[\p{L}\p{N}\p{M}_\u200c\u200d]/u;

/** Whether a single character counts as part of a word for word-wise actions. */
export function isWordChar(char: string): boolean {
  return WORD_CHAR.test(char);
}
