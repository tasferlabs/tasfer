/**
 * The text engine: wrap, caret, click → offset and selection geometry for one
 * run of mark-formatted CRDT text.
 *
 * Every place that shows editable text — a paragraph, a list item, a quote, a
 * code block, a table cell — lays it out and measures it here, so a caret, a
 * click and a highlight land on the same glyphs the painter draws, in every
 * one of them, including mixed Arabic/English lines and inline-math chips.
 *
 * Nothing here knows about blocks, block indices or editor state. A text box is
 * addressed by visible UTF-16 offsets into its own characters, and every
 * coordinate is relative to the box: x from the left edge of the text area, y
 * from the top of its first line. The caller owns where the box sits (a block's
 * indent and top inset, a cell's padding) and adds that origin itself.
 *
 *   layoutText()          — wrap + measure once → TextLayout
 *   textCaretRect()       — caret box for an offset
 *   textOffsetAtPoint()   — nearest offset to a point
 *   textRangeRects()      — highlight rectangles for a range
 *   textLineIndexAt()     — the line an offset's caret sits on
 */

import { analyzeLineBidi } from "./bidi";
import { isMidSurrogatePair } from "./code-points";
import {
  type FontFamily,
  getFontMetrics,
  measureCRDTPositions,
  measureTextUpToIndex,
  type ReplacementSlice,
  type WrappedLine,
  wrapText,
} from "./fonts";
import { resolveMarkRunsFromChars } from "./mark-runs";
import type { MarkRegistry, MarkReplacement } from "./rendering/marks";
import type { Char, Mark, MarkRange } from "./serlization/loadPage";
import type {
  FontMetrics,
  FontStyles,
  RenderedLine,
  TextStyle,
} from "./state-types";
import { getVisibleTextFromChars } from "./sync/char-runs";
import type { StructuredContentMap } from "./sync/structured-content";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The style channels text measurement reads. */
export type TextMeasureStyle = Pick<
  TextStyle,
  "fontSize" | "fontWeight" | "lineHeight"
>;

/**
 * Horizontal alignment of each line inside the box. `null` is the reading
 * direction's leading edge (left in LTR, right in RTL) — what prose uses.
 */
export type TextAlign = "left" | "center" | "right" | null;

export interface TextLayoutInput {
  /** Document-order characters, tombstones included. */
  readonly chars: Char[];
  readonly formats: readonly MarkRange[];
  /** Width of the text area lines wrap to. */
  readonly width: number;
  readonly textStyle: TextMeasureStyle;
  readonly fontFamily: FontFamily;
  readonly fonts: FontStyles;
  readonly direction: "ltr" | "rtl";
  readonly align?: TextAlign;
  readonly codePadding?: number;
  /** Lets measurement reserve a replacement run's width (an inline-math chip). */
  readonly marks?: MarkRegistry;
  /** Structured attachments replacement-run source resolvers read. */
  readonly structuredContent?: StructuredContentMap;
  /** Visible range of live IME preview text folded into `chars`, if any. */
  readonly compositionRange?: { start: number; end: number } | null;
  /**
   * Pre-wrapped lines, for text that breaks by its own rules (a code block
   * breaks on "\n"). Omitted, the text soft-wraps to `width`.
   */
  readonly wrapped?: WrappedLine[];
}

/** The replacement slices a wrapped line renders (see {@link ReplacementSlice}). */
export interface LineSlices {
  /** Continuation slice opening the line, from a run that started earlier. */
  readonly lead?: ReplacementSlice;
  /** Slices riding with an anchor char on the line, by anchor index. */
  readonly anchored: ReadonlyMap<number, ReplacementSlice>;
}

/** One laid-out text box. Line boxes are relative to the box (x is always 0). */
export interface TextLayout {
  readonly lines: readonly RenderedLine[];
  /** Sum of the line heights. */
  readonly contentHeight: number;
  /** Width of the text area the lines were wrapped to. */
  readonly width: number;
  readonly isRTL: boolean;
  readonly align: TextAlign;
  readonly textStyle: TextMeasureStyle;
  readonly fontFamily: FontFamily;
  /** Resolved font registry — resolves `fontFamily` to a CSS stack. */
  readonly fonts: FontStyles;
  readonly marks?: MarkRegistry;
  readonly structuredContent?: StructuredContentMap;
  readonly codePadding: number;
  readonly fontMetrics: FontMetrics;
  readonly lineHeight: number;
  /** Characters this layout was measured from (may include composition text). */
  readonly chars: Char[];
  readonly formats: readonly MarkRange[];
  readonly compositionRange: { start: number; end: number } | null;
  /** Raw wrap result, retained for consumers that need consumedSpace. */
  readonly wrapped: WrappedLine[];
  /**
   * Per-visible-index advance override for replacement chips that wrapped across
   * lines: each line-fragment's first char → its on-this-line rendered width, the
   * rest → 0. Threaded into every width measurement (caret-x, hit-test, selection)
   * so they attribute each line's chip slice its own advance, matching the
   * reflowed paint. Empty when no chip wraps (every chip is one whole fragment).
   */
  readonly replCharWidths: Map<number, number>;
  /**
   * Replacement slices rendered on each line, parallel to `lines`. A run that
   * reflows spans lines it owns no character on, so this — not the line's index
   * range — is what resolves which piece of a formula a line draws.
   */
  readonly lineSlices: readonly LineSlices[];
}

export interface TextRect {
  x: number;
  y: number;
  width: number;
  height: number;
  /** y of the text baseline this rect's glyphs sit on. */
  baseline?: number;
}

// ---------------------------------------------------------------------------
// Replacement runs (inline chips)
// ---------------------------------------------------------------------------

/**
 * A replacement-mark run resolved against a resolved `Char[]` view: `[start,
 * end)` are visible-character indices (the caret-edge range — a structured run
 * is one anchor char, so `end === start + 1`), `text` is the canonical source
 * resolved from the run's attachment, and `replacement` is the mark's
 * renderer. Flat indices treat the run as one atomic unit; interior geometry
 * belongs to the replacement's nested-content hooks.
 */
export interface ReplacementRun {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly mark: Mark;
  readonly replacement: MarkReplacement;
}

/**
 * Replacement-mark runs in a resolved char view, as visible-index runs.
 *
 * Resolution is delegated to `resolveMarkRunsFromChars` — the SAME tolerant,
 * ordinal-based resolver the edit/caret path uses (`getInlineMathSpans`/
 * `query.marks`) — so rendering and editing always agree on a chip's extent.
 * (This used to do its own strict `startCharId`/`endCharId` lookup, which
 * dropped a whole chip to plain text the instant an endpoint char was tombstoned
 * — e.g. backspacing the last char of an inline formula — even though the caret
 * still descended into it, so the painted chip and the live caret diverged.)
 */
export function replacementRuns(
  chars: Char[],
  formats: readonly MarkRange[],
  marks: MarkRegistry,
  attachments?: StructuredContentMap,
): ReplacementRun[] {
  if (!formats.some((f) => marks.get(f.format.type)?.replacement)) return [];
  const runs: ReplacementRun[] = [];
  for (const run of resolveMarkRunsFromChars(chars, formats)) {
    const replacement = marks.get(run.name)?.replacement;
    if (!replacement) continue;
    const mark: Mark = {
      type: run.name,
      ...(Object.keys(run.attrs).length > 0 ? { attrs: run.attrs } : {}),
    };
    const text =
      replacement.source?.(run.text, { mark, attachments }) ?? run.text;
    runs.push({
      start: run.startIndex,
      end: run.endIndex,
      text,
      mark,
      replacement,
    });
  }
  return runs;
}

/** The replacement runs of a laid-out box (none without a mark registry). */
export function layoutReplacementRuns(layout: TextLayout): ReplacementRun[] {
  return layout.marks
    ? replacementRuns(
        layout.chars,
        layout.formats,
        layout.marks,
        layout.structuredContent,
      )
    : [];
}

export interface ReplacementFragment {
  readonly run: ReplacementRun;
  readonly start: number;
  readonly end: number;
  readonly text: string;
  /** Range in the run's canonical replacement source represented by `text`. */
  readonly sourceRange: { readonly start: number; readonly end: number };
  /** Whether the fragment opens its line rather than riding with the anchor. */
  readonly lead: boolean;
}

/**
 * Resolve one marked run's piece of a textual line.
 *
 * A structured run is a single anchor char, so a run that reflows across lines
 * cannot be sliced by character index: the wrap records the slices in SOURCE
 * offsets instead (see {@link ReplacementSlice}), and a continuation slice's
 * line holds none of the run's characters at all. Without slices the fragment is
 * the whole run rendering its whole canonical source — the atomic chip.
 */
export function replacementFragment(
  run: ReplacementRun,
  lineStart: number,
  lineEnd: number,
  slices?: LineSlices,
): ReplacementFragment | null {
  const lead = slices?.lead;
  if (lead && lead.index === run.start) {
    return {
      run,
      start: lineStart,
      end: lineStart,
      text: run.text.slice(lead.sourceStart, lead.sourceEnd),
      sourceRange: { start: lead.sourceStart, end: lead.sourceEnd },
      lead: true,
    };
  }
  const start = Math.max(run.start, lineStart);
  const end = Math.min(run.end, lineEnd);
  if (end <= start) return null;
  const anchored = slices?.anchored.get(run.start);
  return {
    run,
    start,
    end,
    text: anchored
      ? run.text.slice(anchored.sourceStart, anchored.sourceEnd)
      : run.text,
    sourceRange: anchored
      ? { start: anchored.sourceStart, end: anchored.sourceEnd }
      : { start: 0, end: run.text.length },
    lead: false,
  };
}

export interface ReplacementFragmentGeometry extends ReplacementFragment {
  /** Visual x bounds relative to the box. */
  readonly left: number;
  readonly right: number;
}

/**
 * Resolve a replacement fragment's visual box on one line.
 *
 * The stored run is logical-order data, while the canvas box may be reordered
 * by bidi. Keeping this calculation shared by nested caret and nested hit-test
 * prevents the two paths from disagreeing about an RTL-embedded replacement.
 */
export function replacementFragmentGeometry(
  layout: TextLayout,
  lineIndex: number,
  line: RenderedLine,
  run: ReplacementRun,
): ReplacementFragmentGeometry | null {
  const fragment = replacementFragment(
    run,
    line.startIndex,
    line.endIndex,
    layout.lineSlices[lineIndex],
  );
  if (!fragment) return null;
  const edges = lineEdges(layout, line);
  // A continuation row opens the line, so its box is simply the lead itself:
  // from the line's start edge (the right edge in RTL) across its own width.
  if (fragment.lead) {
    const width = line.leadOffset ?? 0;
    const left = layout.isRTL ? edges.right - width : edges.left;
    return { ...fragment, left, right: left + width };
  }
  const lead = line.leadOffset ?? 0;
  const widths = linePositions(layout, line);
  const startLocal = fragment.start - line.startIndex;
  if (startLocal + 1 >= widths.length) return null;
  const { runs, visual } = analyzeLineBidi(
    line.text,
    layout.isRTL ? "rtl" : "ltr",
  );
  const baseLevel = layout.isRTL ? 1 : 0;
  const pureLine =
    runs.length === 0 || (runs.length === 1 && runs[0].level === baseLevel);
  let edgeA: number;
  let edgeB: number;
  if (pureLine) {
    if (layout.isRTL) {
      edgeA = edges.right - lead - widths[startLocal];
      edgeB = edges.right - lead - widths[startLocal + 1];
    } else {
      edgeA = edges.left + lead + widths[startLocal];
      edgeB = edges.left + lead + widths[startLocal + 1];
    }
  } else {
    const lineWidth = widths[widths.length - 1];
    const origin = layout.isRTL
      ? edges.right - lead - lineWidth
      : edges.left + lead;
    const runLeft = new Map<(typeof runs)[number], number>();
    let cursor = origin;
    for (const bidiRun of visual) {
      runLeft.set(bidiRun, cursor);
      cursor += widths[bidiRun.end] - widths[bidiRun.start];
    }
    const owner = runs.find(
      (bidiRun) => startLocal >= bidiRun.start && startLocal < bidiRun.end,
    );
    if (!owner) return null;
    const ownerLeft = runLeft.get(owner) ?? origin;
    const visualX = (index: number): number =>
      owner.level % 2 === 0
        ? ownerLeft + (widths[index] - widths[owner.start])
        : ownerLeft + (widths[owner.end] - widths[index]);
    edgeA = visualX(startLocal);
    edgeB = visualX(startLocal + 1);
  }
  return {
    ...fragment,
    left: Math.min(edgeA, edgeB),
    right: Math.max(edgeA, edgeB),
  };
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

/**
 * Width of a visible range of CRDT text, measured in format batches so Arabic
 * ligatures and kerning match what the painter draws.
 */
export function measureTextRange(
  chars: Char[],
  formats: readonly MarkRange[],
  startIndex: number,
  endIndex: number,
  textStyle: TextMeasureStyle,
  fontFamily: FontFamily,
  fonts: FontStyles,
  codePadding: number,
  marks?: MarkRegistry,
  replCharWidths?: Map<number, number>,
): number {
  return measureTextUpToIndex(
    chars,
    formats,
    startIndex,
    endIndex,
    textStyle.fontSize,
    textStyle.fontWeight,
    fontFamily,
    fonts,
    codePadding,
    marks,
    replCharWidths,
  );
}

/** Width between two visible offsets of a laid-out box. */
function rangeWidth(layout: TextLayout, from: number, to: number): number {
  return measureTextRange(
    layout.chars,
    layout.formats,
    from,
    to,
    layout.textStyle,
    layout.fontFamily,
    layout.fonts,
    layout.codePadding,
    layout.marks,
    layout.replCharWidths,
  );
}

/** Cumulative width to every offset of a line: `[i]` is start → start + i. */
function linePositions(layout: TextLayout, line: RenderedLine): number[] {
  return measureCRDTPositions(
    layout.chars,
    layout.formats,
    line.startIndex,
    line.endIndex,
    layout.textStyle.fontSize,
    layout.textStyle.fontWeight,
    layout.fontFamily,
    layout.fonts,
    layout.marks,
    layout.replCharWidths,
  );
}

function textAscentOf(layout: TextLayout): number {
  return Number.isFinite(layout.fontMetrics.ascent)
    ? layout.fontMetrics.ascent
    : layout.textStyle.fontSize * 0.8;
}

/**
 * A line's left and right edge inside the box, after alignment.
 *
 * Prose (`align: null`) hugs its reading start: the left edge in LTR, the
 * right edge in RTL. A line wider than the box has no slack to align with, so
 * its READING start is pinned to the box edge and the tail overflows — aligning
 * a negative slack would push the first characters out of view instead.
 */
export function lineEdges(
  layout: Pick<TextLayout, "width" | "isRTL" | "align">,
  line: Pick<RenderedLine, "width">,
): { left: number; right: number } {
  const { width, isRTL, align } = layout;
  const slack = width - line.width;
  const resolved = align ?? (isRTL ? "right" : "left");
  if (slack < 0 ? isRTL : resolved === "right") {
    return { left: width - line.width, right: width };
  }
  if (slack >= 0 && resolved === "center") {
    return { left: slack / 2, right: slack / 2 + line.width };
  }
  return { left: 0, right: line.width };
}

/** Whether a line has a single direction run at the box's base level. */
function pureBidi(layout: TextLayout, line: RenderedLine) {
  const bidi = analyzeLineBidi(line.text, layout.isRTL ? "rtl" : "ltr");
  const baseLevel = layout.isRTL ? 1 : 0;
  const pure =
    bidi.runs.length === 0 ||
    (bidi.runs.length === 1 && bidi.runs[0].level === baseLevel);
  return { ...bidi, pure };
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/** Wrap and measure a text box once; every other pass reads the result. */
export function layoutText(input: TextLayoutInput): TextLayout {
  const {
    chars,
    formats,
    width,
    textStyle,
    fontFamily,
    fonts,
    marks,
    structuredContent,
  } = input;
  const codePadding = input.codePadding ?? 0;
  const compositionRange = input.compositionRange ?? null;
  const isRTL = input.direction === "rtl";

  const wrapped =
    input.wrapped ??
    wrapText(
      chars,
      formats,
      width,
      textStyle.fontSize,
      textStyle.fontWeight,
      fontFamily,
      fonts,
      codePadding,
      compositionRange,
      marks,
      structuredContent,
      !isRTL,
    );

  const fontMetrics = getFontMetrics(
    textStyle.fontSize,
    textStyle.fontWeight,
    fontFamily,
    fonts,
  );
  const lineHeight = fontMetrics.fontSize * textStyle.lineHeight;
  const textAscent = Number.isFinite(fontMetrics.ascent)
    ? fontMetrics.ascent
    : textStyle.fontSize * 0.8;
  const textDescent = Number.isFinite(fontMetrics.descent)
    ? fontMetrics.descent
    : textStyle.fontSize * 0.2;
  const replacements = marks
    ? replacementRuns(chars, formats, marks, structuredContent)
    : [];

  // Build line boxes with the exact startIndex/endIndex accounting (including
  // consumed wrap spaces) used by every downstream pass.
  const lines: RenderedLine[] = [];
  // Per-line replacement-chip fragment advances (see TextLayout). Filled as
  // each line resolves its chip fragments, then threaded into every width
  // measurement so a chip that wrapped across lines is measured per slice.
  const replCharWidths = new Map<number, number>();
  const lineSlices: LineSlices[] = [];
  let textIndex = 0;
  let lineY = 0;
  for (let i = 0; i < wrapped.length; i++) {
    const wl = wrapped[i];
    const lineStartIndex = textIndex;
    const lineEndIndex = textIndex + wl.text.length;
    let ascent = textAscent;
    let descent = textDescent;
    const anchored = new Map<number, ReplacementSlice>(
      (wl.slices ?? []).map((slice) => [slice.index, slice]),
    );
    lineSlices.push({ lead: wl.leadSlice, anchored });
    // A continuation row of a reflowing run opens the line: it owns no
    // character, so its advance can't live in `replCharWidths` — it offsets
    // every x measured from the line start instead, and grows the line box.
    let leadOffset = 0;
    if (wl.leadSlice) {
      const run = replacements.find((r) => r.start === wl.leadSlice?.index);
      const dims = run?.replacement.measure(
        run.text.slice(wl.leadSlice.sourceStart, wl.leadSlice.sourceEnd),
        textStyle.fontSize,
      );
      if (dims) {
        leadOffset = dims.width;
        ascent = Math.max(ascent, dims.height - dims.depthBelowBaseline);
        descent = Math.max(descent, dims.depthBelowBaseline);
      }
    }
    // Replacement fragments on THIS line — a chip clipped to the line. Record
    // each fragment's first-char advance (rest → 0) so measurement attributes
    // the slice its own width, and grow the line box around the chip. A chip
    // that reflowed contributes one slice per line it spans; an atomic chip is
    // its whole self on one line (fragment == run).
    for (const run of replacements) {
      const fragStart = Math.max(run.start, lineStartIndex);
      const fragEnd = Math.min(run.end, lineEndIndex);
      if (fragEnd <= fragStart) continue;
      const slice = anchored.get(run.start);
      const dims = run.replacement.measure(
        slice ? run.text.slice(slice.sourceStart, slice.sourceEnd) : run.text,
        textStyle.fontSize,
      );
      if (!dims) continue;
      replCharWidths.set(fragStart, dims.width);
      for (let v = fragStart + 1; v < fragEnd; v++) replCharWidths.set(v, 0);
      ascent = Math.max(ascent, dims.height - dims.depthBelowBaseline);
      descent = Math.max(descent, dims.depthBelowBaseline);
    }
    const lineWidth =
      leadOffset +
      measureTextRange(
        chars,
        formats,
        lineStartIndex,
        lineEndIndex,
        textStyle,
        fontFamily,
        fonts,
        codePadding,
        marks,
        replCharWidths,
      );
    const actualLineHeight = Math.max(lineHeight, ascent + descent);
    lines.push({
      text: wl.text,
      x: 0,
      y: lineY,
      width: lineWidth,
      height: actualLineHeight,
      baselineOffset: ascent,
      startIndex: lineStartIndex,
      endIndex: lineEndIndex,
      ...(leadOffset > 0 ? { leadOffset } : {}),
    });
    lineY += actualLineHeight;
    textIndex += wl.text.length;
    if (wl.consumedSpace) textIndex += 1;
  }

  return {
    lines,
    contentHeight: lineY,
    width,
    isRTL,
    align: input.align ?? null,
    textStyle,
    fontFamily,
    fonts,
    marks,
    structuredContent,
    codePadding,
    fontMetrics,
    lineHeight,
    chars,
    formats,
    compositionRange,
    wrapped,
    replCharWidths,
    lineSlices,
  };
}

// ---------------------------------------------------------------------------
// Caret
// ---------------------------------------------------------------------------

/**
 * The line a caret at `index` sits on, or -1 when no line holds it (past the
 * end of the text).
 *
 * An offset on a soft-wrap boundary belongs to the line it ends. The trailing
 * edge of a run that reflows past a line belongs after its LAST continuation
 * row instead: every row of it shares the same end index, and only the last
 * one is followed by the run's own text.
 */
export function textLineIndexAt(layout: TextLayout, index: number): number {
  for (const [lineIndex, line] of layout.lines.entries()) {
    if (index < line.startIndex || index > line.endIndex) continue;
    if (index === line.endIndex && layout.lineSlices[lineIndex + 1]?.lead) {
      continue;
    }
    return lineIndex;
  }
  return -1;
}

/**
 * Caret box for a visible offset. `y` is the top of the text (ascent above the
 * baseline) and `height` the line box height; a renderer that wants a
 * text-height caret draws ascent + descent from `y`.
 */
export function textCaretRect(
  layout: TextLayout,
  index: number,
): { x: number; y: number; height: number } {
  const { isRTL } = layout;
  const textAscent = textAscentOf(layout);
  const lineIndex = textLineIndexAt(layout, index);
  const line = layout.lines[lineIndex];

  if (!line) {
    // Empty box or caret past the end.
    const lastLine = layout.lines[layout.lines.length - 1];
    return {
      x: isRTL ? layout.width : 0,
      y: lastLine
        ? lastLine.y + (lastLine.baselineOffset ?? textAscent) - textAscent
        : 0,
      height: lastLine?.height ?? layout.lineHeight,
    };
  }

  const lead = line.leadOffset ?? 0;
  const edges = lineEdges(layout, line);
  // A replacement run is one atomic anchor char, so a flat caret only ever
  // rests on its edges — the boundary measure below covers it. Interior carets
  // are nested-content carets.
  const caretY = line.y + (line.baselineOffset ?? textAscent) - textAscent;
  const width = (from: number, to: number) => rangeWidth(layout, from, to);

  // Mixed-direction (bidi) line: place the caret through the visual run order
  // so it sits at the right glyph boundary in an embedded run.
  const { runs, visual, pure } = pureBidi(layout, line);
  if (!pure) {
    const lineLen = line.text.length;
    const i0 = Math.max(0, Math.min(lineLen, index - line.startIndex));
    let totalW = 0;
    for (const r of runs) {
      totalW += width(line.startIndex + r.start, line.startIndex + r.end);
    }
    const origin = isRTL ? edges.right - lead - totalW : edges.left + lead;
    const runLeftX = new Map<(typeof runs)[number], number>();
    let cx = origin;
    for (const r of visual) {
      runLeftX.set(r, cx);
      cx += width(line.startIndex + r.start, line.startIndex + r.end);
    }
    // The run owning this boundary: the one that contains i0 as an
    // interior/left edge, or the last run when the caret is at line end.
    let owner = runs[runs.length - 1];
    for (const r of runs) {
      if (i0 >= r.start && i0 < r.end) {
        owner = r;
        break;
      }
    }
    const l = runLeftX.get(owner) ?? origin;
    const ownerStart = line.startIndex + owner.start;
    const ownerEnd = line.startIndex + owner.end;
    const caretIdx = line.startIndex + i0;
    const localX =
      owner.level % 2 === 0
        ? width(ownerStart, caretIdx)
        : width(caretIdx, ownerEnd);
    return { x: l + localX, y: caretY, height: line.height };
  }

  const widthFromStart = width(line.startIndex, index);
  return {
    x: isRTL
      ? edges.right - lead - widthFromStart
      : edges.left + lead + widthFromStart,
    y: caretY,
    height: line.height,
  };
}

// ---------------------------------------------------------------------------
// Hit-testing
// ---------------------------------------------------------------------------

/**
 * The visible offset nearest a point. A point between lines resolves on the
 * line it is over; anywhere else (a box's padding) on the last line. A
 * replacement run (an inline-math chip) is one atomic anchor char: a point on
 * it snaps to its near edge — interior positions belong to the run's nested
 * selection model, never flat offsets.
 */
export function textOffsetAtPoint(
  layout: TextLayout,
  x: number,
  y: number,
): number {
  for (const line of layout.lines) {
    if (y >= line.y && y < line.y + line.height) {
      return offsetWithinLine(layout, line, x);
    }
  }
  const last = layout.lines[layout.lines.length - 1];
  return last ? offsetWithinLine(layout, last, x) : 0;
}

// Every candidate offset below skips the middle of a surrogate pair: a caret
// there splits an emoji, and the next keystroke stores two lone halves.
function offsetWithinLine(
  layout: TextLayout,
  line: RenderedLine,
  relativeX: number,
): number {
  const { isRTL } = layout;
  const lineStartIndex = line.startIndex;
  const lineEndIndex = line.endIndex;
  const lineText = line.text;
  // A continuation row of a reflowing chip opens the line, so the line's own
  // characters begin past it (before it, measuring right-to-left, in RTL).
  const lead = line.leadOffset ?? 0;
  const edges = lineEdges(layout, line);
  const positionWidths = linePositions(layout, line);
  const lineWidth = positionWidths[positionWidths.length - 1];

  // Bidi (mixed-direction) line: map the click through the visual run order.
  // `positionWidths[i]` is the cumulative logical width to line-relative index
  // i, so run/segment widths come straight from it (no extra measurement).
  const {
    runs: bidiRunsList,
    visual: bidiVisual,
    pure: pureHitLine,
  } = pureBidi(layout, line);
  if (!pureHitLine) {
    const origin = isRTL ? edges.right - lead - lineWidth : edges.left + lead;
    const runLeftX = new Map<(typeof bidiRunsList)[number], number>();
    let cx = origin;
    for (const r of bidiVisual) {
      runLeftX.set(r, cx);
      cx += positionWidths[r.end] - positionWidths[r.start];
    }
    // Pick the visual run under the click (nearest one if the click is in a
    // gap or past the ends).
    let chosen = bidiRunsList[0];
    let chosenDist = Infinity;
    for (const r of bidiRunsList) {
      const l = runLeftX.get(r) ?? origin;
      const rRight = l + (positionWidths[r.end] - positionWidths[r.start]);
      if (relativeX >= l && relativeX <= rRight) {
        chosen = r;
        chosenDist = 0;
        break;
      }
      const d = relativeX < l ? l - relativeX : relativeX - rRight;
      if (d < chosenDist) {
        chosenDist = d;
        chosen = r;
      }
    }
    const l = runLeftX.get(chosen) ?? origin;
    let best = chosen.start;
    let bestDist = Infinity;
    for (let i = chosen.start; i <= chosen.end; i++) {
      if (isMidSurrogatePair(lineText, i)) continue;
      // Visual x of logical boundary i within the run: LTR grows from the
      // run's left; RTL grows from its right (reversed).
      const vx =
        chosen.level % 2 === 0
          ? l + (positionWidths[i] - positionWidths[chosen.start])
          : l + (positionWidths[chosen.end] - positionWidths[i]);
      const d = Math.abs(relativeX - vx);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }

    // Inline-math chips on a bidi line: snap to the chip's near edge exactly as
    // the monotonic path below does, but locate the chip by its VISUAL x — its
    // run is reordered away from its logical position. All of a chip's chars
    // share one embedding level, so the chip is a sub-range of a single bidi
    // run; take that run's geometry.
    for (const run of layoutReplacementRuns(layout)) {
      if (!run.replacement.hitTest) continue;
      const fragStart = Math.max(run.start, lineStartIndex);
      const fragEnd = Math.min(run.end, lineEndIndex);
      if (fragEnd <= fragStart) continue;
      const startLocal = fragStart - lineStartIndex;
      if (startLocal + 1 >= positionWidths.length) continue;
      const owner = bidiRunsList.find(
        (r) => startLocal >= r.start && startLocal < r.end,
      );
      if (!owner) continue;
      const ox = runLeftX.get(owner) ?? origin;
      // Visual x of the two logical boundaries bounding the chip's single
      // advance. The chip glyph box is between them, whatever the run's
      // direction — take min/max for its visual left/right edges.
      const vxOf = (i: number): number =>
        owner.level % 2 === 0
          ? ox + (positionWidths[i] - positionWidths[owner.start])
          : ox + (positionWidths[owner.end] - positionWidths[i]);
      const eA = vxOf(startLocal);
      const eB = vxOf(startLocal + 1);
      const chipLeftX = Math.min(eA, eB);
      const chipRightX = Math.max(eA, eB);
      // Logical index at the chip's visually-left / -right edge (reversed in an
      // RTL run), so a click snaps to the near boundary.
      const leftEdge = owner.level % 2 === 0 ? fragStart : fragEnd;
      const rightEdge = owner.level % 2 === 0 ? fragEnd : fragStart;
      if (relativeX <= chipLeftX || relativeX >= chipRightX) {
        const bestIdx = lineStartIndex + best;
        if (bestIdx > fragStart && bestIdx < fragEnd) {
          best =
            (relativeX <= chipLeftX ? leftEdge : rightEdge) - lineStartIndex;
        }
        continue;
      }
      return relativeX - chipLeftX < (chipRightX - chipLeftX) / 2
        ? leftEdge
        : rightEdge;
    }

    return lineStartIndex + best;
  }

  if (isRTL) {
    const lineVisualStart = edges.right - lead - lineWidth;
    const lineVisualEnd = edges.right - lead;

    if (relativeX < lineVisualStart) return lineEndIndex;
    if (relativeX > lineVisualEnd) return lineStartIndex;

    let bestPosition = lineStartIndex;
    let minDistance = Infinity;
    for (let i = 0; i <= lineText.length; i++) {
      if (isMidSurrogatePair(lineText, i)) continue;
      const charVisualX = edges.right - lead - positionWidths[i];
      const distance = Math.abs(relativeX - charVisualX);
      if (distance < minDistance) {
        minDistance = distance;
        bestPosition = lineStartIndex + i;
      }
    }
    return bestPosition;
  }

  const start = edges.left + lead;
  if (relativeX <= start) return lineStartIndex;

  let bestPosition = lineStartIndex;
  let minDistance = Math.abs(relativeX - start);
  for (let i = 0; i <= lineText.length; i++) {
    if (isMidSurrogatePair(lineText, i)) continue;
    const distance = Math.abs(relativeX - (start + positionWidths[i]));
    if (distance < minDistance) {
      minDistance = distance;
      bestPosition = lineStartIndex + i;
    }
  }

  // Replacement runs are atomic to the flat model: one anchor char, one
  // advance. The nearest-stop loop above can land on an interior index (they
  // all collapse to the right edge); snap to the near edge by the click's x.
  for (const run of layoutReplacementRuns(layout)) {
    if (run.start < lineStartIndex || run.start >= lineEndIndex) continue;
    const startLocal = run.start - lineStartIndex;
    if (startLocal + 1 >= positionWidths.length) continue;
    // The run's anchor char carries its on-line slice width (the override
    // map), so its left/right edges are the adjacent position widths.
    const chipLeftX = start + positionWidths[startLocal];
    const chipRightX = start + positionWidths[startLocal + 1];
    if (relativeX <= chipLeftX || relativeX >= chipRightX) {
      if (bestPosition > run.start && bestPosition < run.end) {
        bestPosition = relativeX <= chipLeftX ? run.start : run.end;
      }
      continue;
    }
    return relativeX - chipLeftX < (chipRightX - chipLeftX) / 2
      ? run.start
      : run.end;
  }

  return bestPosition;
}

/**
 * The range a double-click at a point selects when it lands on a replacement
 * run's glyph box: the run, whole. A point landing on its box selects the run
 * even where a resolved offset would miss it (a double-click past the end of a
 * line ending in a chip). Returns null off any run, and on a mixed-direction
 * line, where the caller falls back to offset-based word selection.
 */
export function replacementRangeAtPoint(
  layout: TextLayout,
  x: number,
  y: number,
): { start: number; end: number } | null {
  const runs = layoutReplacementRuns(layout);
  if (runs.length === 0) return null;
  const { isRTL } = layout;

  for (const line of layout.lines) {
    if (y < line.y || y >= line.y + line.height) continue;
    if (!pureBidi(layout, line).pure) return null;

    const positionWidths = linePositions(layout, line);
    const lineWidth = positionWidths[positionWidths.length - 1];
    const lead = line.leadOffset ?? 0;
    const edges = lineEdges(layout, line);
    const origin = isRTL ? edges.right - lead - lineWidth : edges.left + lead;

    for (const run of runs) {
      // Only a whole, unwrapped chip on this line: the replacement resolves the
      // point against its ENTIRE source, so a fragment clipped by a wrap would
      // mis-map the coordinates.
      if (run.start < line.startIndex || run.end > line.endIndex) continue;
      const startLocal = run.start - line.startIndex;
      if (startLocal + 1 >= positionWidths.length) continue;
      // The chip is one advance; its two boundary widths give its visual edges
      // (RTL grows the visual x from the right).
      const eA = isRTL
        ? origin + (lineWidth - positionWidths[startLocal])
        : origin + positionWidths[startLocal];
      const eB = isRTL
        ? origin + (lineWidth - positionWidths[startLocal + 1])
        : origin + positionWidths[startLocal + 1];
      if (x < Math.min(eA, eB) || x > Math.max(eA, eB)) continue;
      return { start: run.start, end: run.end };
    }
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/**
 * Highlight rectangles for a range, one per line — or one per direction run on
 * a mixed-direction line, since a logical range across an embedded run is not
 * visually contiguous.
 *
 * `start: null` means the range begins before this box (a selection arriving
 * from a neighbour) and `end: null` that it continues past it; that side then
 * takes the whole line edge.
 *
 * `hitTest` asks for the rects a point-in-selection test should use rather
 * than the painted ones: a selection covering a whole inline-math chip then
 * reports the chip's full atomic box, so a tap anywhere on it — including its
 * padding, which the glyph-hugging rows don't cover — counts as touching the
 * selection.
 */
export function textRangeRects(
  layout: TextLayout,
  start: number | null,
  end: number | null,
  options: { readonly hitTest?: boolean } = {},
): TextRect[] {
  const { isRTL, textStyle } = layout;
  const rects: TextRect[] = [];
  const startsHere = start !== null;
  const endsHere = end !== null;

  // A range confined ENTIRELY within one replacement chip that paints its own
  // per-row selection rects (inline math): highlight the selected glyphs' own
  // rows instead of filling the chip's full (inflated) line box. A range that
  // also covers surrounding text falls through to the line-box fill below.
  // LTR only; RTL chips fall through, matching the caret.
  if (!isRTL && start !== null && end !== null && end > start) {
    const confiningRun = layoutReplacementRuns(layout).find(
      (r) => r.replacement.selectionRects && start >= r.start && end <= r.end,
    );
    // A structured run is one atomic anchor char, so a confined range is always
    // the whole run and the rows span the whole canonical source. Hit-testing
    // skips the tight rows and falls through to the full line-box fill.
    if (confiningRun && !options.hitTest) {
      // One pass per line the run appears on: a reflowing formula contributes a
      // slice per line, each highlighting its own rows at its own left edge.
      const chipRects: TextRect[] = [];
      for (const [lineIndex, line] of layout.lines.entries()) {
        const fragment = replacementFragmentGeometry(
          layout,
          lineIndex,
          line,
          confiningRun,
        );
        if (!fragment) continue;
        const rowRects = confiningRun.replacement.selectionRects?.(
          fragment.text,
          textStyle.fontSize,
          0,
          fragment.text.length,
          { caretOffset: 0, editing: false },
        );
        if (!rowRects || rowRects.length === 0) continue;
        const baselineY =
          line.y + (line.baselineOffset ?? layout.fontMetrics.ascent);
        for (const rr of rowRects) {
          chipRects.push({
            x: fragment.left + rr.x,
            y: baselineY + rr.top,
            width: rr.width,
            height: rr.bottom - rr.top,
            baseline: baselineY,
          });
        }
      }
      if (chipRects.length > 0) return chipRects;
    }
  }

  const width = (from: number, to: number) => rangeWidth(layout, from, to);

  layout.lines.forEach((line, lineIndex) => {
    const lineY = line.y;
    const baseline = lineY + (line.baselineOffset ?? layout.fontMetrics.ascent);
    const lead = line.leadOffset ?? 0;
    const edges = lineEdges(layout, line);

    // The logical range of THIS line the selection covers.
    const lineSelStart = startsHere
      ? Math.max(line.startIndex, start)
      : line.startIndex;
    const lineSelEnd = endsHere ? Math.min(line.endIndex, end) : line.endIndex;
    if (lineSelStart >= lineSelEnd) {
      // A continuation row of a reflowing run holds none of the run's
      // characters, so the index test above can never see it. Fill it directly
      // when the selection covers the run its slice belongs to — otherwise a
      // selected formula would highlight only the row its anchor sits on.
      const leadSlice = layout.lineSlices[lineIndex]?.lead;
      const covered =
        leadSlice &&
        (!startsHere || start <= leadSlice.index) &&
        (!endsHere || end >= leadSlice.index + 1);
      if (covered) {
        rects.push({
          x: isRTL ? edges.right - lead : edges.left,
          y: lineY,
          width: lead,
          height: line.height,
          baseline,
        });
      }
      return;
    }

    // A line whose only run is at the base level needs no reordering.
    const { runs, visual, pure } = pureBidi(layout, line);

    if (pure) {
      // The line opens with a continuation row whose run the selection also
      // covers (it starts at or before the run's anchor): the fill starts at the
      // line edge, taking the row in. Otherwise it starts past it.
      const leadCovered =
        lead > 0 &&
        (!startsHere ||
          start <= (layout.lineSlices[lineIndex]?.lead?.index ?? -1));
      let selectionStartX = leadCovered ? edges.left : edges.left + lead;
      let selectionEndX = edges.left + line.width;
      if (isRTL) {
        selectionEndX = leadCovered
          ? edges.right
          : edges.right - lead - width(line.startIndex, lineSelStart);
        selectionStartX =
          edges.right - lead - width(line.startIndex, lineSelEnd);
      } else {
        if (lineSelStart > line.startIndex) {
          selectionStartX =
            edges.left + lead + width(line.startIndex, lineSelStart);
        }
        if (lineSelEnd < line.endIndex) {
          selectionEndX =
            edges.left + lead + width(line.startIndex, lineSelEnd);
        }
      }
      rects.push({
        x: selectionStartX,
        y: lineY,
        width: selectionEndX - selectionStartX,
        height: line.height,
        baseline,
      });
      return;
    }

    // Mixed-direction (bidi) line: lay runs out in visual order, then emit one
    // rect per selected run.
    let totalWidth = 0;
    for (const r of runs) {
      totalWidth += width(line.startIndex + r.start, line.startIndex + r.end);
    }
    // LTR lines start from their left edge, RTL lines end flush at their right
    // edge. Both start past any continuation row opening the line.
    const origin = isRTL ? edges.right - lead - totalWidth : edges.left + lead;
    const runLeft = new Map<(typeof runs)[number], number>();
    let cursorX = origin;
    for (const r of visual) {
      runLeft.set(r, cursorX);
      cursorX += width(line.startIndex + r.start, line.startIndex + r.end);
    }

    const lineLen = line.text.length;
    const lo = Math.max(0, Math.min(lineLen, lineSelStart - line.startIndex));
    const hi = Math.max(0, Math.min(lineLen, lineSelEnd - line.startIndex));
    for (const r of runs) {
      const a = Math.max(r.start, lo);
      const b = Math.min(r.end, hi);
      if (a >= b) continue;
      const runStartIdx = line.startIndex + r.start;
      const runEndIdx = line.startIndex + r.end;
      const selA = line.startIndex + a;
      const selB = line.startIndex + b;
      const rx = runLeft.get(r) ?? origin;
      let xLeft: number;
      let xRight: number;
      if (r.level % 2 === 0) {
        // LTR run: logical order matches visual order.
        xLeft = rx + width(runStartIdx, selA);
        xRight = rx + width(runStartIdx, selB);
      } else {
        // RTL run: reversed — the visually-left edge is the logically-later end.
        xLeft = rx + width(selB, runEndIdx);
        xRight = rx + width(selA, runEndIdx);
      }
      rects.push({
        x: xLeft,
        y: lineY,
        width: xRight - xLeft,
        height: line.height,
        baseline,
      });
    }
  });

  return rects;
}

// ---------------------------------------------------------------------------
// IME composition preview
// ---------------------------------------------------------------------------

/**
 * Characters with live IME preview text folded in at visible offset `at`, for
 * layout and paint only: the preview's ids are placeholders and are never
 * stored. `replace` hides a visible range the commit will overwrite (a
 * selection typed over), so the preview reads the way the result will.
 *
 * Tombstones stay in document order — mark ranges anchor to their endpoint
 * ids, and a range whose endpoint char went missing would drop its mark for the
 * length of the composition. The preview is split per UTF-16 unit, like every
 * stored char, so an emoji in it keeps offsets and widths aligned.
 */
export function foldComposition(
  chars: readonly Char[],
  at: number,
  text: string,
  replace?: { readonly from: number; readonly to: number },
): { chars: Char[]; compositionRange: { start: number; end: number } | null } {
  if (text.length === 0 && !replace) {
    return { chars: [...chars], compositionRange: null };
  }
  const preview: Char[] = Array.from({ length: text.length }, (_, i) => ({
    id: `composition-${i}`,
    char: text[i],
  }));
  const out: Char[] = [];
  let visible = 0;
  let inserted = false;
  for (const char of chars) {
    if (char.deleted) {
      out.push(char);
      continue;
    }
    if (visible === at && !inserted) {
      out.push(...preview);
      inserted = true;
    }
    const hidden = replace && visible >= replace.from && visible < replace.to;
    out.push(hidden ? { ...char, deleted: true } : char);
    visible++;
  }
  if (!inserted) out.push(...preview);
  return {
    chars: out,
    compositionRange:
      text.length > 0 ? { start: at, end: at + text.length } : null,
  };
}

/** Rects under the composition preview of a box, one per line or bidi run. */
export function compositionRects(layout: TextLayout): TextRect[] {
  const range = layout.compositionRange;
  return range ? textRangeRects(layout, range.start, range.end) : [];
}

/** Visible length of a box's text. */
export function textLength(layout: TextLayout): number {
  return getVisibleTextFromChars(layout.chars).length;
}
