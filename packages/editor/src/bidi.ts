/**
 * Minimal Unicode Bidirectional Algorithm (UBA) for a single already-wrapped
 * line of text.
 *
 * The canvas paint path draws each format batch with the browser's own bidi
 * (via `ctx.direction` + `fillText`), so a mixed Arabic/Latin line is visually
 * reordered by the platform. The selection-rectangle and caret geometry, by
 * contrast, are computed by hand from logical cumulative widths. Without the
 * reordering here they assume logical order == visual order, which is only true
 * for a wholly-LTR or wholly-RTL line — so a highlight over an Arabic word
 * embedded in an LTR line (or vice-versa) lands on the wrong glyphs.
 *
 * This module resolves per-character embedding levels and groups the line into
 * directional runs in visual (left-to-right) order. It implements the core
 * rules (W1–W7, N1–N2, I1–I2, L2) for a single paragraph with no explicit
 * embedding/isolate controls — which covers ordinary typed prose in Latin,
 * Arabic, Hebrew, digits and punctuation. Paired-bracket resolution (N0) and
 * the deprecated explicit-embedding formatting characters are intentionally
 * omitted.
 */

export type BidiDir = "ltr" | "rtl";

/** Bidi character types used by the resolution rules. */
type BidiType =
  | "L"
  | "R"
  | "AL"
  | "EN"
  | "ES"
  | "ET"
  | "AN"
  | "CS"
  | "NSM"
  | "BN"
  | "B"
  | "S"
  | "WS"
  | "ON";

/** A maximal run of characters that share one embedding level. */
export interface BidiRun {
  /** Inclusive start index into the line string. */
  start: number;
  /** Exclusive end index into the line string. */
  end: number;
  /** Resolved embedding level; even = LTR, odd = RTL. */
  level: number;
}

const RE_MARK = /\p{M}/u;
const RE_LETTER = /\p{L}/u;

// Strong right-to-left Arabic-family letters (bidi class AL).
function isArabicLetter(cp: number): boolean {
  return (
    (cp >= 0x0600 && cp <= 0x06ff) || // Arabic
    (cp >= 0x0750 && cp <= 0x077f) || // Arabic Supplement
    (cp >= 0x0870 && cp <= 0x089f) || // Arabic Extended-B
    (cp >= 0x08a0 && cp <= 0x08ff) || // Arabic Extended-A
    (cp >= 0xfb50 && cp <= 0xfdff) || // Arabic Presentation Forms-A
    (cp >= 0xfe70 && cp <= 0xfeff) || // Arabic Presentation Forms-B
    (cp >= 0x0700 && cp <= 0x074f) || // Syriac
    (cp >= 0x0780 && cp <= 0x07bf) // Thaana
  );
}

// Strong right-to-left Hebrew-family letters (bidi class R).
function isHebrewLetter(cp: number): boolean {
  return (
    (cp >= 0x0590 && cp <= 0x05ff) || // Hebrew
    (cp >= 0x07c0 && cp <= 0x07ff) || // NKo
    (cp >= 0xfb1d && cp <= 0xfb4f) // Hebrew Presentation Forms
  );
}

// Arabic-Indic and extended Arabic-Indic digits (bidi class AN).
function isArabicNumber(cp: number): boolean {
  return (cp >= 0x0660 && cp <= 0x0669) || (cp >= 0x06f0 && cp <= 0x06f9);
}

function bidiType(ch: string): BidiType {
  const cp = ch.codePointAt(0) ?? 0;

  // Combining marks are non-spacing marks regardless of script.
  if (RE_MARK.test(ch)) return "NSM";

  if (isArabicNumber(cp)) return "AN";
  if (cp >= 0x30 && cp <= 0x39) return "EN"; // ASCII digits
  if (isArabicLetter(cp)) return "AL";
  if (isHebrewLetter(cp)) return "R";

  // Weak/neutral punctuation relevant to typed text.
  if (ch === "+" || ch === "-" || ch === "−") return "ES";
  if (
    ch === "#" ||
    ch === "$" ||
    ch === "%" ||
    ch === "¢" || // ¢
    ch === "£" || // £
    ch === "¥" || // ¥
    ch === "°" || // °
    ch === "٪" // ٪ Arabic percent
  )
    return "ET";
  if (
    ch === "," ||
    ch === "." ||
    ch === ":" ||
    ch === "/" ||
    ch === " " || // no-break space
    ch === "،" // ، Arabic comma
  )
    return "CS";

  if (ch === "\t") return "S";
  if (ch === "\n") return "B";
  if (ch === " " || /\s/.test(ch)) return "WS";

  if (RE_LETTER.test(ch)) return "L";

  return "ON";
}

/** Resolve embedding levels for every character of `text` under `baseDir`. */
export function resolveBidiLevels(text: string, baseDir: BidiDir): number[] {
  const n = text.length;
  const baseLevel = baseDir === "rtl" ? 1 : 0;
  const sor: "L" | "R" = baseLevel % 2 === 0 ? "L" : "R";
  const eor = sor;

  if (n === 0) return [];

  const types: BidiType[] = new Array(n);
  for (let i = 0; i < n; i++) types[i] = bidiType(text[i]);

  // --- W1: NSM takes the type of the previous character (sor at the start). ---
  for (let i = 0; i < n; i++) {
    if (types[i] === "NSM") types[i] = i === 0 ? sor : types[i - 1];
  }

  // --- W2: EN → AN when the last strong type seen is AL. ---
  {
    let lastStrong: "L" | "R" | "AL" = sor;
    for (let i = 0; i < n; i++) {
      const t = types[i];
      if (t === "L" || t === "R" || t === "AL") lastStrong = t;
      else if (t === "EN" && lastStrong === "AL") types[i] = "AN";
    }
  }

  // --- W3: AL → R. ---
  for (let i = 0; i < n; i++) if (types[i] === "AL") types[i] = "R";

  // --- W4: a single ES between two EN → EN; a single CS between two numbers
  //         of the same kind → that number type. ---
  for (let i = 1; i < n - 1; i++) {
    const prev = types[i - 1];
    const next = types[i + 1];
    if (types[i] === "ES" && prev === "EN" && next === "EN") types[i] = "EN";
    else if (
      types[i] === "CS" &&
      prev === next &&
      (prev === "EN" || prev === "AN")
    )
      types[i] = prev;
  }

  // --- W5: a sequence of ET adjacent to EN takes the type EN. ---
  for (let i = 0; i < n; i++) {
    if (types[i] !== "ET") continue;
    let j = i;
    while (j < n && types[j] === "ET") j++;
    const before = i > 0 ? types[i - 1] : sor;
    const after = j < n ? types[j] : eor;
    if (before === "EN" || after === "EN") {
      for (let k = i; k < j; k++) types[k] = "EN";
    }
    i = j - 1;
  }

  // --- W6: remaining ES/ET/CS → ON. ---
  for (let i = 0; i < n; i++) {
    if (types[i] === "ES" || types[i] === "ET" || types[i] === "CS")
      types[i] = "ON";
  }

  // --- W7: EN → L when the last strong type seen is L. ---
  {
    let lastStrong: "L" | "R" = sor;
    for (let i = 0; i < n; i++) {
      const t = types[i];
      if (t === "L" || t === "R") lastStrong = t;
      else if (t === "EN" && lastStrong === "L") types[i] = "L";
    }
  }

  // --- N1/N2: resolve neutrals (and BN, treated as neutral). EN and AN count
  //     as R for the purpose of bounding neutral sequences. ---
  const isNeutral = (t: BidiType) =>
    t === "B" || t === "S" || t === "WS" || t === "ON" || t === "BN";
  const strongDir = (t: BidiType): "L" | "R" => (t === "L" ? "L" : "R"); // R, EN, AN → R
  for (let i = 0; i < n; i++) {
    if (!isNeutral(types[i])) continue;
    let j = i;
    while (j < n && isNeutral(types[j])) j++;
    const before: "L" | "R" = i > 0 ? strongDir(types[i - 1]) : sor;
    const after: "L" | "R" = j < n ? strongDir(types[j]) : eor;
    const resolved: BidiType =
      before === after ? before : baseLevel % 2 === 0 ? "L" : "R";
    for (let k = i; k < j; k++) types[k] = resolved;
    i = j - 1;
  }

  // --- I1/I2: implicit levels from the resolved types. ---
  const levels = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const t = types[i];
    if (baseLevel % 2 === 0) {
      // Even (LTR) base: R → +1, AN/EN → +2.
      if (t === "R") levels[i] = baseLevel + 1;
      else if (t === "AN" || t === "EN") levels[i] = baseLevel + 2;
      else levels[i] = baseLevel;
    } else {
      // Odd (RTL) base: L/EN/AN → +1.
      if (t === "L" || t === "EN" || t === "AN") levels[i] = baseLevel + 1;
      else levels[i] = baseLevel;
    }
  }

  return levels;
}

/** Group resolved levels into maximal single-level runs (logical order). */
export function bidiRuns(levels: number[]): BidiRun[] {
  const runs: BidiRun[] = [];
  let i = 0;
  const n = levels.length;
  while (i < n) {
    let j = i + 1;
    while (j < n && levels[j] === levels[i]) j++;
    runs.push({ start: i, end: j, level: levels[i] });
    i = j;
  }
  return runs;
}

/**
 * Runs in visual (left-to-right) order per rule L2: from the highest level down
 * to the lowest odd level, reverse any contiguous sequence of runs at that
 * level or above. Returns a new array; input is not mutated.
 */
export function visualRunOrder(runs: BidiRun[]): BidiRun[] {
  if (runs.length <= 1) return runs.slice();
  let maxLevel = 0;
  for (const r of runs) if (r.level > maxLevel) maxLevel = r.level;

  const order = runs.slice();
  for (let level = maxLevel; level >= 1; level--) {
    let i = 0;
    while (i < order.length) {
      if (order[i].level >= level) {
        let j = i;
        while (j < order.length && order[j].level >= level) j++;
        // Reverse order[i, j).
        for (let a = i, b = j - 1; a < b; a++, b--) {
          const tmp = order[a];
          order[a] = order[b];
          order[b] = tmp;
        }
        i = j;
      } else {
        i++;
      }
    }
  }
  return order;
}

/**
 * Full line analysis: resolved levels, logical runs, and the same runs in
 * visual order. `baseDir` is the line's resolved paragraph direction.
 */
export function analyzeLineBidi(
  text: string,
  baseDir: BidiDir,
): { levels: number[]; runs: BidiRun[]; visual: BidiRun[] } {
  const levels = resolveBidiLevels(text, baseDir);
  const runs = bidiRuns(levels);
  return { levels, runs, visual: visualRunOrder(runs) };
}
