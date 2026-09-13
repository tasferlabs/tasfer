/**
 * Prose tokenizer: turns a block's visible text into the words worth
 * checking, with exact UTF-16 offsets back into the input.
 *
 * Word boundaries come from `Intl.Segmenter` (UAX #29) when the host has it,
 * with a regex fallback otherwise. Everything that is not prose is filtered
 * out before it reaches an engine: URLs, emails, mentions, paths and ids
 * (see {@link protectedSpans}), tokens with digits, identifiers
 * (`snake_case`, `camelCase`), mixed-script words and — unless asked —
 * ALL-CAPS acronyms. The caller adds its own `skip` ranges for code, link and
 * math runs it knows about from the document model.
 *
 * No state: the segmenter is created by the owner ({@link createSegmenter})
 * and passed in, so each worker host or checker holds its own.
 */

import type { Script } from "./protocol";
import { normalizeForLookup, scriptOf } from "./script";

export interface Token {
  readonly from: number;
  /** Exclusive end offset. */
  readonly to: number;
  /** The word exactly as it appears in the text. */
  readonly text: string;
  /** The form to ask a dictionary about (see `normalizeForLookup`). */
  readonly normalized: string;
  readonly script: Script;
}

export interface TokenizeOptions {
  /** Offset spans never tokenised (code/link/math runs); tokens overlapping one are dropped. */
  readonly skip: ReadonlyArray<readonly [number, number]>;
  /** Keep ALL-CAPS Latin tokens instead of treating them as acronyms. */
  readonly flagAllCaps: boolean;
}

export type Span = [number, number];

/** A word-granularity segmenter, or null where `Intl.Segmenter` is unavailable. */
export function createSegmenter(): Intl.Segmenter | null {
  try {
    if (typeof Intl === "undefined" || typeof Intl.Segmenter !== "function")
      return null;
    return new Intl.Segmenter("und", { granularity: "word" });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Protected spans
// ---------------------------------------------------------------------------

/** Characters that end a URL/path-ish run. */
const RUN = `[^\\s<>"'\`()\\[\\]{}]`;
const TLDS =
  "com|org|net|edu|gov|mil|int|io|dev|app|ai|co|me|info|biz|xyz|tech|cloud|design|blog|shop|store|site|online|page|news|tv|fm|ly|to|us|uk|de|fr|es|it|nl|se|no|fi|dk|pl|ru|ch|at|be|ie|pt|gr|tr|il|sa|ae|eg|jo|lb|kw|qa|bh|om|iq|sy|ma|dz|tn|ly|sd|ye|ps|in|jp|cn|kr|au|nz|ca|br|mx|ar|za|ng|ke|id|my|sg|ph|vn|th|pk|bd";

const PROTECTED_PATTERNS: readonly RegExp[] = [
  // scheme://…  (also mailto:, tel: without slashes)
  new RegExp(
    `(?<![\\p{L}\\p{N}])[a-zA-Z][a-zA-Z0-9+.-]{1,15}:(?://${RUN}+|(?<=mailto:|tel:)${RUN}+)`,
    "gu",
  ),
  // www.…
  new RegExp(`(?<![\\p{L}\\p{N}.])www\\.${RUN}+`, "gu"),
  // bare domain.tld with a known TLD, or any TLD when a /path follows
  new RegExp(
    `(?<![\\p{L}\\p{N}@.-])(?:[a-zA-Z0-9-]+\\.)+(?:(?:${TLDS})(?![\\p{L}\\p{N}])(?:/${RUN}*)?|[a-zA-Z]{2,24}/${RUN}*)`,
    "gu",
  ),
  // emails
  /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu,
  // @mentions
  /(?<![\p{L}\p{N}])@[\p{L}\p{N}_.]*[\p{L}\p{N}_]/gu,
  // #hashtags (Latin and Arabic letters alike)
  /(?<![\p{L}\p{N}&])#[\p{L}\p{M}\p{N}_]+/gu,
  // POSIX-ish paths: /usr/x  ./a/b  ../a/b  ~/a/b
  /(?<!\S)(?:\.{1,2}|~)?\/[\w.-]+(?:\/[\w.-]*)+/gu,
  // Windows paths: C:\x
  /(?<![\p{L}\p{N}])[a-zA-Z]:\\[^\s"'<>|]*/gu,
  // long hex ids
  /(?<![\p{L}\p{N}])[0-9a-fA-F]{16,}(?![\p{L}\p{N}])/gu,
  // base64-ish ids: 20+ chars of the alphabet including at least one non-letter
  /(?<![\p{L}\p{N}+/=])(?=[A-Za-z]*[0-9+/=])[A-Za-z0-9+/=]{20,}(?![\p{L}\p{N}+/=])/gu,
];

/**
 * Spans of `text` that are never spelled: URLs, emails, mentions, hashtags,
 * file paths and long ids. Sorted and merged. Never throws.
 */
export function protectedSpans(text: string): Span[] {
  const spans: Span[] = [];
  try {
    for (const re of PROTECTED_PATTERNS) {
      // `matchAll` clones the regex, so the shared constants stay stateless.
      for (const m of text.matchAll(re)) {
        if (m[0].length > 0) spans.push([m.index, m.index + m[0].length]);
      }
    }
  } catch {
    // A pathological input must not take spellcheck down with it.
  }
  return mergeSpans(spans);
}

/** Sort spans and merge the ones that overlap or touch. */
export function mergeSpans(spans: Iterable<readonly [number, number]>): Span[] {
  const sorted: Span[] = [];
  for (const [a, b] of spans) if (b > a) sorted.push([a, b]);
  sorted.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const out: Span[] = [];
  for (const span of sorted) {
    const last = out[out.length - 1];
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else out.push([span[0], span[1]]);
  }
  return out;
}

/** True when `[from, to)` intersects any of the sorted, merged `spans`. */
function overlaps(spans: readonly Span[], from: number, to: number): boolean {
  // Binary search for the first span ending after `from`.
  let lo = 0;
  let hi = spans.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (spans[mid][1] <= from) lo = mid + 1;
    else hi = mid;
  }
  return lo < spans.length && spans[lo][0] < to;
}

// ---------------------------------------------------------------------------
// Tokenize
// ---------------------------------------------------------------------------

interface RawSegment {
  from: number;
  to: number;
  text: string;
}

/** Fallback when there is no segmenter: letters/marks/digits joined by apostrophes. */
const FALLBACK_WORD_RE =
  /[\p{L}\p{M}\p{Nd}_]+(?:['\u2019][\p{L}\p{M}\p{Nd}_]+)*/gu;

function rawSegments(text: string, seg: Intl.Segmenter | null): RawSegment[] {
  const out: RawSegment[] = [];
  if (seg) {
    for (const s of seg.segment(text)) {
      if (s.isWordLike)
        out.push({
          from: s.index,
          to: s.index + s.segment.length,
          text: s.segment,
        });
    }
  } else {
    for (const m of text.matchAll(FALLBACK_WORD_RE)) {
      out.push({ from: m.index, to: m.index + m[0].length, text: m[0] });
    }
  }
  return out;
}

const QUOTE_CHARS = new Set([
  "'",
  "\u2019",
  "\u2018",
  '"',
  "\u201C",
  "\u201D",
  "\u00AB",
  "\u00BB",
]);
const HYPHEN_RE = /[-\u2010\u2011\u2013]/;
const DIGIT_RE = /\p{Nd}/u;
const CAMEL_RE = /\p{Ll}\p{Lu}/u;
const MAX_TOKEN_LENGTH = 100;

function trimQuotes(s: RawSegment): RawSegment | null {
  let { from, to } = s;
  while (from < to && QUOTE_CHARS.has(s.text[from - s.from])) from++;
  while (to > from && QUOTE_CHARS.has(s.text[to - 1 - s.from])) to--;
  if (from >= to) return null;
  if (from === s.from && to === s.to) return s;
  return { from, to, text: s.text.slice(from - s.from, to - s.from) };
}

function splitHyphens(s: RawSegment, out: RawSegment[]): void {
  if (!HYPHEN_RE.test(s.text)) {
    out.push(s);
    return;
  }
  let start = 0;
  for (let i = 0; i <= s.text.length; i++) {
    if (i === s.text.length || HYPHEN_RE.test(s.text[i])) {
      if (i > start)
        out.push({
          from: s.from + start,
          to: s.from + i,
          text: s.text.slice(start, i),
        });
      start = i + 1;
    }
  }
}

/** Letters excluding tatweel (U+0640 is a modifier letter but carries no spelling). */
function countLetters(text: string): number {
  let n = 0;
  for (const ch of text) if (ch !== "\u0640" && /\p{L}/u.test(ch)) n++;
  return n;
}

function isAllCaps(text: string): boolean {
  return text === text.toUpperCase() && text !== text.toLowerCase();
}

/**
 * Tokenise `text` into checkable words. Offsets are UTF-16 indices into the
 * input; `normalized` is what the engines are asked about.
 */
export function tokenize(
  text: string,
  opts: TokenizeOptions,
  seg: Intl.Segmenter | null,
): Token[] {
  const excluded = mergeSpans([...protectedSpans(text), ...opts.skip]);
  const tokens: Token[] = [];
  const pieces: RawSegment[] = [];
  for (const raw of rawSegments(text, seg)) {
    if (excluded.length > 0 && overlaps(excluded, raw.from, raw.to)) continue;
    const trimmed = trimQuotes(raw);
    if (!trimmed) continue;
    pieces.length = 0;
    splitHyphens(trimmed, pieces);
    for (const piece of pieces) {
      const t = piece.text;
      if (t.length > MAX_TOKEN_LENGTH) continue;
      if (DIGIT_RE.test(t)) continue;
      if (t.includes("_") || CAMEL_RE.test(t)) continue;
      if (countLetters(t) < 2) continue;
      const script = scriptOf(t);
      if (script !== "latn" && script !== "arab") continue;
      if (script === "latn" && !opts.flagAllCaps && isAllCaps(t)) continue;
      const normalized = normalizeForLookup(t, script);
      if (countLetters(normalized) < 2) continue;
      tokens.push({
        from: piece.from,
        to: piece.to,
        text: t,
        normalized,
        script,
      });
    }
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// wordAt
// ---------------------------------------------------------------------------

/**
 * The word-like segment containing `offset`, also when the caret sits right
 * after the word (`offset === to`). Null in whitespace/punctuation.
 */
export function wordAt(
  text: string,
  offset: number,
  seg: Intl.Segmenter | null,
): { from: number; to: number } | null {
  if (offset < 0 || offset > text.length) return null;
  if (seg) {
    const segments = seg.segment(text);
    const at = offset < text.length ? segments.containing(offset) : undefined;
    if (at && at.isWordLike)
      return { from: at.index, to: at.index + at.segment.length };
    if (offset > 0) {
      const before = segments.containing(offset - 1);
      if (before && before.isWordLike) {
        return { from: before.index, to: before.index + before.segment.length };
      }
    }
    return null;
  }
  for (const m of text.matchAll(FALLBACK_WORD_RE)) {
    const from = m.index;
    const to = from + m[0].length;
    if (from > offset) break;
    if (offset <= to) return { from, to };
  }
  return null;
}
