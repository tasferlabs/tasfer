/**
 * Script classification and lookup normalisation.
 *
 * Dictionaries are routed by writing script (see {@link Script}); the
 * functions here decide the script of a token and turn its display form into
 * the form the engines are asked about. Normalisation is deliberately
 * conservative: it removes what a dictionary never stores (tashkeel, tatweel,
 * bidi controls, presentation-form ligatures) and nothing more. Hamza forms,
 * ta marbuta and alif maqsura are kept because confusing them is exactly the
 * kind of error the checker should flag; {@link arabicVariants} exists for
 * the opt-in lenient mode.
 *
 * Pure functions, no state: safe to share across editors and workers.
 */

import type { Script } from "./protocol";

export type { Script } from "./protocol";

/** Arabic script blocks (Arabic, Supplement, Extended-A, Presentation Forms A/B). */
function isArabicCodePoint(cp: number): boolean {
  return (
    (cp >= 0x0600 && cp <= 0x06ff) ||
    (cp >= 0x0750 && cp <= 0x077f) ||
    (cp >= 0x08a0 && cp <= 0x08ff) ||
    (cp >= 0xfb50 && cp <= 0xfdff) ||
    (cp >= 0xfe70 && cp <= 0xfeff)
  );
}

const LETTER_RE = /\p{L}/u;
const LATIN_RE = /\p{Script=Latin}/u;
const TATWEEL = 0x0640;

/**
 * Classify a word by the script of its letters. Marks, digits, punctuation,
 * tatweel and format characters (ZWNJ/ZWJ, bidi controls) never affect the
 * result. A word with letters from two classes is `mixed`; a word with no
 * letters at all, or letters outside Arabic and Latin, is `other`.
 */
export function scriptOf(word: string): Script {
  let arab = false;
  let latn = false;
  let other = false;
  for (const ch of word) {
    const cp = ch.codePointAt(0) as number;
    if (cp === TATWEEL || !LETTER_RE.test(ch)) continue;
    if (isArabicCodePoint(cp)) arab = true;
    else if (LATIN_RE.test(ch)) latn = true;
    else other = true;
  }
  const classes = Number(arab) + Number(latn) + Number(other);
  if (classes > 1) return "mixed";
  if (arab) return "arab";
  if (latn) return "latn";
  return "other";
}

/** Bidi controls, ZWNJ/ZWJ and soft hyphen: invisible, never part of a word. */
const INVISIBLE_RE = /[\u200C-\u200F\u202A-\u202E\u2066-\u2069\u00AD]/gu;
/** Tatweel plus Arabic combining marks (tashkeel, Quranic annotation marks). */
const ARABIC_MARKS_RE =
  /[\u0640\u064B-\u065F\u0670\u0610-\u061A\u06D6-\u06ED]/gu;
/** Presentation forms A/B: contextual and ligature glyph code points. */
const PRESENTATION_FORMS_RE = /[\uFB50-\uFDFF\uFE70-\uFEFF]+/gu;

/**
 * The form of a word that is looked up in a dictionary of `script`.
 *
 * Always: NFC, invisible controls stripped. For Arabic: tatweel and tashkeel
 * removed, presentation forms folded to their base letters (`ﻻ` → `لا`).
 * Never folds hamza forms, ta marbuta or alif maqsura.
 */
export function normalizeForLookup(word: string, script: Script): string {
  let out = word.normalize("NFC").replace(INVISIBLE_RE, "");
  if (script === "arab") {
    // Fold first: some isolated tashkeel forms decompose to a space or a
    // tatweel plus the mark (U+FE70 → " ً"), which the mark pass then removes.
    out = out
      .replace(PRESENTATION_FORMS_RE, (m) =>
        m.normalize("NFKC").replace(/ /g, ""),
      )
      .replace(ARABIC_MARKS_RE, "");
  }
  return out;
}

const ALIF_FORMS = ["ا", "أ", "إ", "آ"]; // ا أ إ آ
const HA_FORMS = ["ه", "ة"]; // ه ة
const YA_FORMS = ["ي", "ى"]; // ي ى
/** One-letter proclitics that may sit before the alif being varied. */
const PROCLITICS = new Set(["و", "ف", "ب", "ك", "ل"]); // و ف ب ك ل

/**
 * Orthographic variants of an Arabic word for the lenient option: the alif
 * at the start (or right after a one-letter proclitic) swapped among
 * ا/أ/إ/آ, final ه↔ة and final ى↔ي, in every combination. Deduplicated and
 * excluding the input itself. At most 4 × 2 - 1 = 7 entries.
 */
export function arabicVariants(word: string): string[] {
  const chars: string[] = [];
  for (const ch of word) chars.push(ch);
  if (chars.length === 0) return [];

  let alifIndex = -1;
  if (ALIF_FORMS.includes(chars[0])) alifIndex = 0;
  else if (
    chars.length > 1 &&
    PROCLITICS.has(chars[0]) &&
    ALIF_FORMS.includes(chars[1])
  ) {
    alifIndex = 1;
  }
  const heads: string[] = [];
  if (alifIndex >= 0) {
    for (const alif of ALIF_FORMS) {
      const copy = chars.slice();
      copy[alifIndex] = alif;
      heads.push(copy.join(""));
    }
  } else {
    heads.push(word);
  }

  const last = chars[chars.length - 1];
  const tails = HA_FORMS.includes(last)
    ? HA_FORMS
    : YA_FORMS.includes(last)
      ? YA_FORMS
      : null;

  const out = new Set<string>();
  for (const head of heads) {
    if (!tails) {
      out.add(head);
      continue;
    }
    // `head` still ends in `last`; swap only the final code point.
    const stem = head.slice(0, head.length - last.length);
    for (const tail of tails) out.add(stem + tail);
  }
  out.delete(word);
  return [...out];
}

/**
 * Case forms a Latin word may be stored under. `"Hello"` → `["hello"]`
 * (sentence-initial capital), `"HELLO"` → `["hello", "Hello"]`. Lowercase and
 * irregular mixed-case input (`"iPhone"`) yield nothing.
 */
export function caseVariants(word: string): string[] {
  const lower = word.toLowerCase();
  const upper = word.toUpperCase();
  if (word === lower) return [];
  if (word === upper) {
    const capitalised = capitalize(lower);
    return capitalised === lower ? [lower] : [lower, capitalised];
  }
  if (word === capitalize(lower)) return [lower];
  return [];
}

/** Restore the casing pattern of `original` onto `word` (used for suggestions). */
export function matchCase(word: string, original: string): string {
  const lower = original.toLowerCase();
  if (original === lower) return word;
  const upper = original.toUpperCase();
  if (original === upper && hasTwoCasedLetters(original))
    return word.toUpperCase();
  if (original === capitalize(lower)) return capitalize(word);
  return word;
}

function hasTwoCasedLetters(word: string): boolean {
  let n = 0;
  for (const ch of word)
    if (ch.toLowerCase() !== ch.toUpperCase() && ++n >= 2) return true;
  return false;
}

function capitalize(word: string): string {
  if (!word) return word;
  const first = String.fromCodePoint(word.codePointAt(0) as number);
  return first.toUpperCase() + word.slice(first.length);
}

const REPEAT_RE = /(\p{L})\1{2,}/gu;

/**
 * For words with a run of three or more identical letters, the forms with
 * every such run shortened to two letters and to one (`"sooo"` →
 * `["soo", "so"]`). Empty when there is no such run.
 */
export function collapseRepeats(word: string): string[] {
  if (!REPEAT_RE.test(word)) return [];
  const two = word.replace(REPEAT_RE, "$1$1");
  const one = word.replace(REPEAT_RE, "$1");
  return two === one ? [one] : [two, one];
}
