// What a "word" is, and where one ends — the shared vocabulary behind every
// word-wise operation: double-click / double-tap word selection, word-wise
// cursor movement (Ctrl/Alt+Arrow) and word-wise deletion (Ctrl/Alt+Backspace).
//
// The walks below take a plain string rather than a block, so a feature holding
// text the flat model cannot address — a table cell's own field, say — asks the
// same question the engine's own prose asks and gets the same answer. Kept
// separate from `cjk.ts` because Chinese and Japanese are handled specially
// (each ideograph or kana is its own word, see `isOwnWordChar`); this defines
// what counts as an ordinary word character.
//
// The character class includes:
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
//
// One character joins a word only from inside it: an apostrophe (' or ’)
// with a letter on both sides, or a digit on both sides, so "L'été",
// "aujourd'hui", "İstanbul'da" and "don't" are each one word. That is the
// Unicode word rule (UAX #29, WB6/WB7 and WB11/WB12), and what macOS text
// views, Chrome and `Intl.Segmenter` all do on double-click. A quote mark at a
// word's edge ('hello', rock 'n' roll) stays outside it. Use
// `isWordCharAt` wherever the neighbours are known.
import { isCJKCharacter } from "./cjk";

const WORD_CHAR = /[\p{L}\p{N}\p{M}_\u200c\u200d]/u;
const LETTER = /\p{L}/u;
const DIGIT = /\p{N}/u;
// Marks and joiners ride on the letter before them (UAX #29 WB4), so "é"
// typed as e + U+0301 still counts as a letter before an apostrophe.
const ATTACHED = /[\p{M}\u200c\u200d]/u;
// Hangul syllables (U+AC00 to U+D7AF).
const HANGUL_SYLLABLE = /[\uac00-\ud7af]/;

// A unit that is a word by itself: one Chinese or Japanese character. Null for
// every other character.
function ownWordAt(
  text: string,
  index: number,
): { start: number; end: number } | null {
  const char = text[index];
  if (char === undefined) return null;
  if (isOwnWordChar(char)) return { start: index, end: index + 1 };
  return null;
}

// Chinese and Japanese write without spaces, so each ideograph or kana is its
// own word here. Korean is the exception inside `isCJKCharacter`: it puts
// spaces between words, so "안녕하세요" is one word, as on every platform.
function isOwnWordChar(char: string): boolean {
  return isCJKCharacter(char) && !HANGUL_SYLLABLE.test(char);
}

/**
 * Whether a single character counts as part of a word for word-wise actions,
 * judged alone. An apostrophe needs its neighbours: see {@link isWordCharAt}.
 */
export function isWordChar(char: string): boolean {
  return WORD_CHAR.test(char);
}

/**
 * Whether `text[index]` is part of a word, with its neighbours in view: every
 * {@link isWordChar} character, and an apostrophe inside a word ("L'été").
 */
export function isWordCharAt(text: string, index: number): boolean {
  const char = text[index];
  if (char === undefined) return false;
  if (WORD_CHAR.test(char)) return true;
  const isApostrophe = char === "'" || char === "\u2019";
  if (!isApostrophe) return false;
  let b = index - 1;
  while (b >= 0 && ATTACHED.test(text[b])) b--;
  const before = text[b];
  const after = text[index + 1];
  if (before === undefined || after === undefined) return false;
  if (isOwnWordChar(before) || isOwnWordChar(after)) return false;
  return (
    (LETTER.test(before) && LETTER.test(after)) ||
    (DIGIT.test(before) && DIGIT.test(after))
  );
}

// Helper function to find word boundaries - distinguishes between word characters and non-word characters
// Uses Unicode property escapes to support all languages
// A CJK character is a word by itself: one step crosses it whole
export function findWordBoundary(
  text: string,
  index: number,
  direction: "left" | "right",
): number {
  if (direction === "left") {
    // Move left to find start of previous word
    let i = index;

    if (i === 0) return 0;

    // A CJK character before the caret is one step
    const own = ownWordAt(text, i - 1);
    if (own) return own.start;

    // Skip current character type for non-CJK
    const startIsWordChar = isWordCharAt(text, i - 1);
    if (startIsWordChar) {
      while (i > 0 && isWordCharAt(text, i - 1) && !ownWordAt(text, i - 1)) {
        i--;
      }
    } else {
      while (i > 0 && !isWordCharAt(text, i - 1)) {
        i--;
      }
    }

    return i;
  } else {
    // Move right to find end of next word
    let i = index;

    if (i === text.length) return text.length;

    // A CJK character after the caret is one step
    const own = ownWordAt(text, i);
    if (own) return own.end;

    // Skip current character type for non-CJK
    const startIsWordChar = isWordCharAt(text, i);
    if (startIsWordChar) {
      while (i < text.length && isWordCharAt(text, i) && !ownWordAt(text, i)) {
        i++;
      }
    } else {
      while (i < text.length && !isWordCharAt(text, i)) {
        i++;
      }
    }

    return i;
  }
}

// Find word boundaries for selection. Word characters are defined by
// `isWordChar` (letters, numbers, combining marks, joiners, underscore) so
// vocalized Arabic and joined Persian/Indic words stay whole.
// A CJK character is a word by itself.
export function findWordStart(text: string, index: number): number {
  let i = index;

  // On a CJK character: that one unit is the word
  const own = ownWordAt(text, i);
  if (own) return own.start;

  // Move left while we're in word characters (see isWordChar)
  // Stop at a CJK character
  while (i > 0 && isWordCharAt(text, i - 1) && !ownWordAt(text, i - 1)) {
    i--;
  }
  return i;
}

export function findWordEnd(text: string, index: number): number {
  let i = index;

  // On a CJK character: that one unit is the word
  const own = ownWordAt(text, i);
  if (own) return own.end;

  // Move right while we're in word characters (see isWordChar)
  // Stop at a CJK character
  while (i < text.length && isWordCharAt(text, i) && !ownWordAt(text, i)) {
    i++;
  }
  return i;
}

// Where a word-wise DELETE reaches, which is not where a word-wise MOVE stops.
// A move lands on the far side of the whitespace it crossed; a delete takes the
// run it is standing in — the word, or the spaces and punctuation before it —
// and stops there, so ⌥⌫ eats "one " and not "one two ". Same split every
// native text field makes.
export function findWordDeleteBoundaryLeft(
  text: string,
  index: number,
): number {
  let i = index;

  if (i === 0) return 0;

  // A CJK character goes in one press
  const own = ownWordAt(text, i - 1);
  if (own) return own.start;

  // Check what type of character we're starting from (Unicode-aware)
  const startsOnWord = isWordCharAt(text, i - 1);

  if (startsOnWord) {
    // Delete word characters (see isWordChar: letters, numbers, marks, joiners, underscore)
    while (i > 0 && isWordCharAt(text, i - 1) && !ownWordAt(text, i - 1)) {
      i--;
    }
  } else {
    // Delete non-word characters (spaces, punctuation, special characters together)
    while (i > 0 && !isWordCharAt(text, i - 1)) {
      i--;
    }
  }

  return i;
}

/** {@link findWordDeleteBoundaryLeft}'s mirror, for a forward word delete. */
export function findWordDeleteBoundaryRight(
  text: string,
  index: number,
): number {
  let i = index;

  if (i === text.length) return text.length;

  // A CJK character goes in one press
  const own = ownWordAt(text, i);
  if (own) return own.end;

  // Check what type of character we're starting from (Unicode-aware)
  const startsOnWord = isWordCharAt(text, i);

  if (startsOnWord) {
    // Delete word characters (see isWordChar: letters, numbers, marks, joiners, underscore)
    while (i < text.length && isWordCharAt(text, i) && !ownWordAt(text, i)) {
      i++;
    }
  } else {
    // Delete non-word characters (spaces, punctuation, special characters together)
    while (i < text.length && !isWordCharAt(text, i)) {
      i++;
    }
  }

  return i;
}
