// What a "word" is, and where one ends — the shared vocabulary behind every
// word-wise operation: double-click / double-tap word selection, word-wise
// cursor movement (Ctrl/Alt+Arrow) and word-wise deletion (Ctrl/Alt+Backspace).
//
// The walks below take a plain string rather than a block, so a feature holding
// text the flat model cannot address — a table cell's own field, say — asks the
// same question the engine's own prose asks and gets the same answer. Kept
// separate from `cjk.ts` because CJK is handled specially (each ideograph is its
// own word); this defines what counts as an ordinary word character.
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
import { isCJKCharacter } from "./cjk";

const WORD_CHAR = /[\p{L}\p{N}\p{M}_\u200c\u200d]/u;

/** Whether a single character counts as part of a word for word-wise actions. */
export function isWordChar(char: string): boolean {
  return WORD_CHAR.test(char);
}

// Helper function to find word boundaries - distinguishes between word characters and non-word characters
// Uses Unicode property escapes to support all languages
// For CJK text, each character is treated as a word boundary
export function findWordBoundary(
  text: string,
  index: number,
  direction: "left" | "right",
): number {
  if (direction === "left") {
    // Move left to find start of previous word
    let i = index;

    if (i === 0) return 0;

    // Check if current position is a CJK character
    if (i > 0 && isCJKCharacter(text[i - 1])) {
      // For CJK, move one character at a time
      return i - 1;
    }

    // Skip current character type for non-CJK
    const startIsWordChar = isWordChar(text[i - 1]);
    if (startIsWordChar) {
      while (i > 0 && isWordChar(text[i - 1]) && !isCJKCharacter(text[i - 1])) {
        i--;
      }
    } else {
      while (i > 0 && !isWordChar(text[i - 1])) {
        i--;
      }
    }

    return i;
  } else {
    // Move right to find end of next word
    let i = index;

    if (i === text.length) return text.length;

    // Check if current position is a CJK character
    if (i < text.length && isCJKCharacter(text[i])) {
      // For CJK, move one character at a time
      return i + 1;
    }

    // Skip current character type for non-CJK
    const startIsWordChar = isWordChar(text[i]);
    if (startIsWordChar) {
      while (
        i < text.length &&
        isWordChar(text[i]) &&
        !isCJKCharacter(text[i])
      ) {
        i++;
      }
    } else {
      while (i < text.length && !isWordChar(text[i])) {
        i++;
      }
    }

    return i;
  }
}

// Find word boundaries for selection. Word characters are defined by
// `isWordChar` (letters, numbers, combining marks, joiners, underscore) so
// vocalized Arabic and joined Persian/Indic words stay whole.
// For CJK characters, each character is treated as a word.
export function findWordStart(text: string, index: number): number {
  let i = index;

  // If we're at a CJK character, just select that one character
  if (i < text.length && isCJKCharacter(text[i])) {
    return i;
  }

  // Move left while we're in word characters (see isWordChar)
  // Stop at CJK characters
  while (i > 0 && isWordChar(text[i - 1]) && !isCJKCharacter(text[i - 1])) {
    i--;
  }
  return i;
}

export function findWordEnd(text: string, index: number): number {
  let i = index;

  // If we're at a CJK character, just select that one character
  if (i < text.length && isCJKCharacter(text[i])) {
    return i + 1;
  }

  // Move right while we're in word characters (see isWordChar)
  // Stop at CJK characters
  while (i < text.length && isWordChar(text[i]) && !isCJKCharacter(text[i])) {
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

  // For CJK characters, delete one character at a time
  if (isCJKCharacter(text[i - 1])) {
    return i - 1;
  }

  // Check what type of character we're starting from (Unicode-aware)
  const startsOnWord = isWordChar(text[i - 1]);

  if (startsOnWord) {
    // Delete word characters (see isWordChar: letters, numbers, marks, joiners, underscore)
    while (i > 0 && isWordChar(text[i - 1]) && !isCJKCharacter(text[i - 1])) {
      i--;
    }
  } else {
    // Delete non-word characters (spaces, punctuation, special characters together)
    while (i > 0 && !isWordChar(text[i - 1])) {
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

  // For CJK characters, delete one character at a time
  if (isCJKCharacter(text[i])) {
    return i + 1;
  }

  // Check what type of character we're starting from (Unicode-aware)
  const startsOnWord = isWordChar(text[i]);

  if (startsOnWord) {
    // Delete word characters (see isWordChar: letters, numbers, marks, joiners, underscore)
    while (i < text.length && isWordChar(text[i]) && !isCJKCharacter(text[i])) {
      i++;
    }
  } else {
    // Delete non-word characters (spaces, punctuation, special characters together)
    while (i < text.length && !isWordChar(text[i])) {
      i++;
    }
  }

  return i;
}
