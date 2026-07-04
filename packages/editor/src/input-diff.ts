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
 * Whether `surface` still carries its leading sentinel.
 *
 * The regular-space sentinel is not read back verbatim: contenteditable engines
 * normalize whitespace and frequently substitute a leading space with a
 * non-breaking space (` `) — even under `white-space: pre`, and especially
 * at the very start of the field. So ANY single leading whitespace counts as the
 * sentinel; requiring an exact `" "` match would misread a browser-substituted
 * NBSP as "sentinel gone" and let that NBSP leak into the document as a spurious
 * leading space. An empty sentinel (iOS) is always considered present.
 */
export function hasSentinel(surface: string, sentinel: string): boolean {
  if (sentinel === "") return true;
  return surface.length > 0 && isWordBoundaryChar(surface[0]);
}

/**
 * `surface` with its leading sentinel removed — the mirrored region the editor
 * reconciles against the document. Tolerant of the browser having substituted
 * the sentinel space with an NBSP (see {@link hasSentinel}); returns the surface
 * unchanged when the sentinel is genuinely absent.
 */
export function stripSentinel(surface: string, sentinel: string): string {
  if (sentinel === "") return surface;
  return hasSentinel(surface, sentinel) ? surface.slice(1) : surface;
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

/**
 * The start offset of the sentence containing `pos` in `text`: the index just
 * after the most recent sentence terminator (`.`, `!`, or `?`) and the run of
 * whitespace following it, or 0 when there is none. Whitespace right after a
 * terminator belongs to the *next* sentence, so a caret sitting in that gap
 * (e.g. just after `"Hi. "`) reports the gap's end — making the result stable as
 * the user types the first character of the new sentence.
 *
 * The input surface mirrors `text.slice(sentenceStart, caret)` so the OS keyboard
 * sees the real left-context and applies its own sentence-capitalization: it
 * capitalizes a word that genuinely begins a sentence and leaves mid-sentence
 * words alone, instead of capitalizing every word.
 */
export function sentenceStartOffset(text: string, pos: number): number {
  const end = Math.max(0, Math.min(pos, text.length));
  let start = 0;
  let i = 0;
  while (i < end) {
    const ch = text[i];
    if (ch === "." || ch === "!" || ch === "?") {
      let j = i + 1;
      while (j < end && isWordBoundaryChar(text[j])) j++;
      start = j;
      i = j;
    } else {
      i++;
    }
  }
  return start;
}

/** A half-open `[start, end)` span of verbatim source the surface must not enter. */
export interface ProtectedSpan {
  start: number;
  end: number;
}

/**
 * Clamp the start of the mirrored word so it never reaches into a protected
 * span — a stretch of verbatim SOURCE (an inline math chip's LaTeX) that the OS
 * keyboard must not autocorrect. Spans are caret-edge ranges in the same
 * coordinate space as `caret`.
 *
 * Returns the floor the word may not start before (the end of the last span at
 * or before the caret, else 0), or `null` when `caret` sits *strictly inside* a
 * span — there is no prose word to mirror, so the caller falls back to the bare
 * sentinel. A caret exactly on a span edge is outside it: at the right edge the
 * floor advances past the span; at the left edge the span is ignored.
 */
export function clampMirrorStartToSpans(
  spans: Iterable<ProtectedSpan>,
  caret: number,
): number | null {
  let floor = 0;
  for (const { start, end } of spans) {
    if (start < caret && caret < end) return null;
    if (end <= caret) floor = Math.max(floor, end);
  }
  return floor;
}

/**
 * Whether the caret sits in verbatim SOURCE rather than prose — a preformatted
 * block (a math or code block, source end to end) or *strictly inside* a
 * replacement-mark run (an inline math chip's LaTeX). This is exactly the
 * condition under which the surface withholds a live word from the OS keyboard
 * (see {@link clampMirrorStartToSpans}); the editor also uses it to switch off
 * native predictive text / autocorrect so the mobile suggestion strip can't
 * offer nonsense fixes for LaTeX. Node/mark-agnostic: the caller supplies the
 * preformatted flag and the replacement spans. A caret on a span edge is prose.
 */
export function caretInProtectedSource(
  isPreformatted: boolean,
  replacementSpans: Iterable<ProtectedSpan>,
  caret: number,
): boolean {
  if (isPreformatted) return true;
  return clampMirrorStartToSpans(replacementSpans, caret) === null;
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

/**
 * Recognize a keystroke that landed BEFORE the sentinel and reorder the surface
 * so the sentinel stays leading.
 *
 * The surface's DOM caret belongs after the sentinel, but a browser that focuses
 * the contenteditable without an explicit selection places it at offset 0 —
 * before the sentinel (the editor re-asserts the caret on focus, but this guards
 * any path where a stale caret survives). Typing there turns ` ` into `C `:
 * the sentinel is no longer leading, so a naive reconciliation reads the WHOLE
 * surface — trailing sentinel space included — as typed content and leaks a
 * spurious space into the document.
 *
 * The shape is unambiguous: the previous surface carried its sentinel, the new
 * one doesn't, and the change is a pure insertion at offset 0 that left the
 * previous surface (sentinel first) intact after it. Returns the surface as it
 * would read had the caret been where it belongs — sentinel, then the inserted
 * text, then the rest — so the caller reconciles only the typed characters.
 * Returns `null` for every other change (deletes, replacements, mid-surface
 * edits, or an empty sentinel), which the caller handles as before.
 */
export function rescueCaretBeforeSentinel(
  prev: string,
  next: string,
  sentinel: string,
): string | null {
  if (sentinel === "") return null;
  if (!hasSentinel(prev, sentinel)) return null;
  if (hasSentinel(next, sentinel)) return null;
  const delta = computeSurfaceDelta(prev, next);
  const isPureInsertionAtStart =
    delta.deleteStart === 0 && delta.deleteEnd === 0 && delta.insert.length > 0;
  if (!isPureInsertionAtStart) return null;
  // `next` is `insert + prev`; keep whatever character the browser holds as the
  // sentinel (it may have substituted an NBSP) and move the insertion after it.
  return prev[0] + delta.insert + prev.slice(1);
}
