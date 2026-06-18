/**
 * Font measurement, metrics, and text wrapping for the editor.
 *
 * The editor is font-agnostic: the host application defines which font families
 * exist and their CSS font-stacks via the per-instance theme (`EditorTheme.fonts`
 * → resolved `EditorStyles.fonts`). The resolved registry is threaded into every
 * measurement call (no module global). The host also loads the font faces, then
 * calls `notifyFontsLoaded` (and `notifyFontsChanged` whenever the available
 * faces or stacks change — e.g. a script-specific font becomes available) so the
 * editor can flush its metrics cache and re-measure with the real fonts.
 */

import { containsCJK, isCJKCharacter } from "./cjk";
import type { MarkRegistry, MarkReplacement } from "./rendering/marks";
import type { Char, CharRun, Mark, MarkSpan } from "./serlization/loadPage";
// Formatted text measurement - handles Char[] with MarkSpan[]
import { markKey } from "./serlization/loadPage";
import type {
  EditorStyles,
  FontFamily,
  FontMetrics,
  FontStyles,
} from "./state-types";
import { charRunsToChars } from "./sync/char-runs";

// Re-exported so the package root can surface `FontFamily`.
export type { FontFamily };

// Legacy text segment type (for backward compatibility)
interface TextSegment {
  content: string;
  formats?: Mark[];
}

// A batch of consecutive characters with the same formatting.
//
// The batch carries only the metric-affecting facts the measurement engine
// needs — `isBold` (weight) and `replacement` (a mark that renders its run as an
// atomic non-text unit, e.g. inline math, so its width is the rendered width).
// The *visual* mark channels (italic, code chip, link, strike, color) are
// resolved from `formats` through the per-instance MarkRegistry at paint time,
// so they don't live here.
export interface TextBatch {
  text: string;
  formats: Mark[];
  isBold: boolean;
  /** The replacement renderer for this run, or null for plain text. */
  replacement: MarkReplacement | null;
}

/** The first of `formats` that renders as a replacement, or null. */
function replacementFor(
  formats: Mark[],
  marks: MarkRegistry | undefined,
): MarkReplacement | null {
  if (!marks) return null;
  for (const f of formats) {
    const r = marks.get(f.type)?.replacement;
    if (r) return r;
  }
  return null;
}

// Line wrapping result with information about consumed characters
export interface WrappedLine {
  text: string;
  consumedSpace: boolean; // True if this line consumed a trailing space character
}

// Whether the host has reported that the base font faces are loaded. This is a
// browser-level fact (a @font-face finished loading), shared by every editor
// instance — not per-instance config — so it stays a module global, as do the
// pure measurement caches below (keyed by the resolved CSS font-stack, so two
// instances with different registries can't collide).
// eslint-disable-next-line local/no-global-mutable-state -- browser-level "@font-face loaded" fact, identical for every instance on the page.
let fontsLoaded = false;

// Callbacks fired once when fonts finish loading
const fontReadyCallbacks: Array<() => void> = [];

// Global metrics cache (immutable) - keyed by "fontStack-fontSize-fontWeight".
// eslint-disable-next-line local/no-global-mutable-state -- pure measurement cache keyed by resolved CSS font-stack; instance-independent, so two instances can't collide.
let metricsCache: ReadonlyMap<string, FontMetrics> = new Map();

// Canvas context for measurements (created once)
const measurementCanvas = (() => {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  return canvas.getContext("2d")!;
})();

/**
 * Resolve the CSS font-stack for a family key from a (per-instance) font
 * registry (`EditorStyles.fonts`). Unknown keys fall back to the configured
 * default family, then to a generic system stack.
 */
export function getFontStack(
  fontFamily: FontFamily,
  fonts: FontStyles,
): string {
  return (
    fonts.families[fontFamily] ??
    fonts.families[fonts.defaultFamily] ??
    "sans-serif"
  );
}

/**
 * The active font family for an instance: the explicitly-selected family from
 * its resolved styles, or the registry's default. Replaces the former global
 * `getCurrentFontFamily()` — selection is now per-instance theme state.
 */
export function currentFontFamily(styles: EditorStyles): FontFamily {
  return styles.fontFamily ?? styles.fonts.defaultFamily;
}

/** Register a one-shot callback for when fonts are ready. Fires immediately if already loaded. Returns unsubscribe fn. */
export function onFontsReady(cb: () => void): () => void {
  if (fontsLoaded) {
    cb();
    return () => {};
  }
  fontReadyCallbacks.push(cb);
  return () => {
    const idx = fontReadyCallbacks.indexOf(cb);
    if (idx >= 0) fontReadyCallbacks.splice(idx, 1);
  };
}

/**
 * Notify the editor that the base font faces have finished loading.
 * Flushes cached metrics so text is re-measured with the real fonts and fires
 * any `onFontsReady` listeners (e.g. to trigger a re-render).
 *
 * Loading the fonts themselves is the host application's responsibility — the
 * editor only needs to know when they're ready.
 */
export function notifyFontsLoaded(): void {
  if (fontsLoaded) return;
  fontsLoaded = true;
  // Flush cached metrics/widths so they're re-measured with the real fonts,
  // and force ctx.font re-assignment so canvases resolve the loaded faces
  metricsCache = new Map();
  charWidthCache = new Map();
  fontEpoch++;
  // Notify listeners (editor re-render)
  const cbs = fontReadyCallbacks.splice(0);
  for (const cb of cbs) cb();
}

/**
 * Notify the editor that the set of available font faces or their stacks has
 * changed after the initial load — e.g. a script-specific font (Arabic, CJK…)
 * finished loading and the host updated `EditorStyles.fonts` to reference it.
 * Flushes cached metrics so measurements use the new stacks and fires
 * `onFontsReady` listeners so the editor re-renders.
 */
export function notifyFontsChanged(): void {
  // Flush metrics/width caches so measurements use the (possibly new) font
  // stacks, and force ctx.font re-assignment on measurement canvases
  metricsCache = new Map();
  charWidthCache = new Map();
  fontEpoch++;
  // Notify listeners so the editor re-renders
  const cbs = fontReadyCallbacks.splice(0);
  for (const cb of cbs) cb();
}

// Helper function to create cache key. Keyed by the resolved CSS font-stack
// (not the family key) so two instances whose registries map the same key to
// different stacks never collide in the shared cache.
function createCacheKey(
  fontStack: string,
  fontSize: number,
  fontWeight: string,
): string {
  return `${fontStack}-${fontSize}-${fontWeight}`;
}

// Last font string applied to each measurement context. Assigning `ctx.font`
// makes the browser re-parse the font string even when it's unchanged, which
// dominates per-character measurement — so skip redundant assignments. Keyed
// by context, so independent editor instances can't clobber each other.
// `fontEpoch` is bumped when font faces load/change: a canvas only resolves
// newly loaded faces after `ctx.font` is re-assigned, so the epoch forces one
// fresh assignment per context after every font event.
const lastAppliedFont = new WeakMap<CanvasRenderingContext2D, string>();
// eslint-disable-next-line local/no-global-mutable-state -- monotonic font-load epoch paired with the per-context lastAppliedFont WeakMap; a browser-level fact shared by every instance.
let fontEpoch = 0;

// Apply font to a context. Returns the resolved CSS font-stack so callers can
// build cache keys without re-resolving the registry.
function applyFont(
  ctx: CanvasRenderingContext2D,
  fontSize: number,
  fontWeight: string,
  fontFamily: FontFamily,
  fonts: FontStyles,
): string {
  const fontStack = getFontStack(fontFamily, fonts);
  const font = `${fontWeight} ${fontSize}px ${fontStack}`;
  const cacheKey = `${fontEpoch}|${font}`;
  if (lastAppliedFont.get(ctx) !== cacheKey) {
    ctx.font = font;
    lastAppliedFont.set(ctx, cacheKey);
  }
  return fontStack;
}
// Pure function to calculate font metrics
function calculateFontMetrics(
  fontFamily: FontFamily,
  fontSize: number,
  fontWeight: string,
  fonts: FontStyles,
): FontMetrics {
  const ctx = measurementCanvas;
  applyFont(ctx, fontSize, fontWeight, fontFamily, fonts);
  const textMetrics = ctx.measureText("Mg");

  // Use font bounding box metrics for consistent line height across all characters
  return {
    fontSize,
    fontWeight,
    fontFamily,
    ascent: textMetrics.fontBoundingBoxAscent,
    descent: textMetrics.fontBoundingBoxDescent,
  };
}
// Get font metrics with lazy per-key caching.
// Metrics are computed on first access for each font/size/weight combo,
// avoiding the upfront cost of pre-computing all 80 combinations.
export function getFontMetrics(
  fontSize: number,
  fontWeight: string,
  fontFamily: FontFamily,
  fonts: FontStyles,
): FontMetrics {
  const fontStack = getFontStack(fontFamily, fonts);
  const cacheKey = createCacheKey(fontStack, fontSize, fontWeight);
  const cached = metricsCache.get(cacheKey);

  if (cached) {
    return cached;
  }

  // Calculate on demand
  const metrics = calculateFontMetrics(fontFamily, fontSize, fontWeight, fonts);

  // Update cache
  metricsCache = new Map(metricsCache).set(cacheKey, metrics);

  return metrics;
}

// Width cache for short strings — wrapText measures one character at a time,
// so per-char widths are re-requested constantly across frames. Like
// metricsCache this memoizes pure measurements (instance-independent), and is
// flushed by notifyFontsLoaded/notifyFontsChanged. Longer strings (batched
// ligature measurement) are arbitrary and unbounded, so they stay uncached.
// eslint-disable-next-line local/no-global-mutable-state -- pure per-char width cache keyed by resolved CSS font-stack; instance-independent, so two instances can't collide.
let charWidthCache = new Map<string, number>();

// Measure character
export function measureCtxText(
  text: string,
  fontSize: number,
  fontWeight: string,
  fontFamily: FontFamily,
  fonts: FontStyles,
): number {
  const ctx = measurementCanvas;
  // <= 2 covers surrogate pairs while keeping the cache bounded
  if (text.length <= 2) {
    const fontStack = getFontStack(fontFamily, fonts);
    const cacheKey = `${fontStack}|${fontWeight}|${fontSize}|${text}`;
    let width = charWidthCache.get(cacheKey);
    if (width === undefined) {
      applyFont(ctx, fontSize, fontWeight, fontFamily, fonts);
      width = ctx.measureText(text).width;
      charWidthCache.set(cacheKey, width);
    }
    return width;
  }

  applyFont(ctx, fontSize, fontWeight, fontFamily, fonts);
  return ctx.measureText(text).width;
}

// Helper: Check if a char is within a format span
function isCharInSpan(
  charIndex: number,
  span: MarkSpan,
  chars: Char[],
): boolean {
  const startIdx = chars.findIndex((c) => c.id === span.startCharId);
  const endIdx = chars.findIndex((c) => c.id === span.endCharId);

  if (startIdx === -1 || endIdx === -1) return false;

  return charIndex >= startIdx && charIndex <= endIdx;
}

// Helper: Get formats that apply to a character at a given index
export function getFormatsAtIndex(
  charIndex: number,
  chars: Char[],
  formats: MarkSpan[],
): Mark[] {
  const activeMarks: Mark[] = [];

  for (const span of formats) {
    if (isCharInSpan(charIndex, span, chars)) {
      activeMarks.push(span.format);
    }
  }

  return activeMarks;
}

// === Batching utilities for Arabic/RTL text support ===
// These batch consecutive characters with the same formatting together
// to preserve ligatures and cursive connections in scripts like Arabic

// Create a unique key for a set of formats (for batching comparison)
export function getFormatKey(formats: Mark[]): string {
  return formats.map(markKey).sort().join("|");
}

// Batch CRDT characters by formatting within a visible index range
// This preserves Arabic ligatures by keeping same-formatted chars together
export function batchChars(
  chars: Char[],
  formats: MarkSpan[],
  startIndex: number,
  endIndex: number,
  marks?: MarkRegistry,
): TextBatch[] {
  const batches: TextBatch[] = [];
  let currentBatch: TextBatch | null = null;
  let visibleIndex = 0;

  for (let i = 0; i < chars.length; i++) {
    const char = chars[i];

    // Skip deleted characters
    if (char.deleted) continue;

    // Check if this character is in the range
    if (visibleIndex < startIndex) {
      visibleIndex++;
      continue;
    }

    if (visibleIndex >= endIndex) {
      break;
    }

    const charFormats = getFormatsAtIndex(i, chars, formats);
    const formatKey = getFormatKey(charFormats);

    if (currentBatch && getFormatKey(currentBatch.formats) === formatKey) {
      // Same formatting, append to current batch
      currentBatch.text += char.char;
    } else {
      // Different formatting, start new batch. Only the metric-affecting facts
      // (bold weight, replacement renderer) are precomputed; visual channels are
      // resolved from `formats` via the MarkRegistry at paint time.
      currentBatch = {
        text: char.char,
        formats: charFormats,
        isBold: charFormats.some((f) => f.type === "strong"),
        replacement: replacementFor(charFormats, marks),
      };
      batches.push(currentBatch);
    }

    visibleIndex++;
  }

  return batches;
}

// Measure width of batched text (preserves Arabic ligatures)
export function measureBatchedText(
  batches: TextBatch[],
  fontSize: number,
  baseFontWeight: string,
  fontFamily: FontFamily,
  fonts: FontStyles,
): number {
  let width = 0;

  for (const batch of batches) {
    if (batch.replacement) {
      const dims = batch.replacement.measure(batch.text, fontSize);
      if (dims) {
        width += dims.width;
        continue;
      }
      // Fall back to text measurement on render error
    }
    const effectiveFontWeight = batch.isBold ? "bold" : baseFontWeight;
    // Measure the entire batch as a string (preserves ligature widths)
    width += measureCtxText(
      batch.text,
      fontSize,
      effectiveFontWeight,
      fontFamily,
      fonts,
    );
  }

  return width;
}

/**
 * Calculate cumulative widths for all character positions in a range.
 * Optimized for cursor positioning while preserving Arabic ligatures.
 *
 * For Arabic and other connected scripts, ligatures can form across formatting boundaries.
 * To measure positions accurately, we measure from the line start for each position,
 * ensuring ligatures are formed correctly throughout the entire line.
 *
 * @param chars - CRDT character array
 * @param formats - Format spans
 * @param startIndex - Start of visible character range
 * @param endIndex - End of visible character range
 * @param fontSize - Font size in pixels
 * @param baseFontWeight - Base font weight (before bold formatting)
 * @param fontFamily - Font family to use
 * @returns Array where index i contains the cumulative width from startIndex to startIndex+i
 */
export function measureCRDTPositions(
  chars: Char[],
  formats: MarkSpan[],
  startIndex: number,
  endIndex: number,
  fontSize: number,
  baseFontWeight: string,
  fontFamily: FontFamily,
  fonts: FontStyles,
  marks?: MarkRegistry,
): number[] {
  const lineLength = endIndex - startIndex;
  const positions: number[] = new Array(lineLength + 1);

  positions[0] = 0;

  // For each position, measure from the start to that position
  // This ensures Arabic ligatures are formed correctly across formatting boundaries
  for (let i = 1; i <= lineLength; i++) {
    positions[i] = measureTextUpToIndex(
      chars,
      formats,
      startIndex,
      startIndex + i,
      fontSize,
      baseFontWeight,
      fontFamily,
      fonts,
      0,
      marks,
    );
  }

  return positions;
}

// Measure width of CRDT text (Char[] with MarkSpan[]) up to a specific character position
// Uses batching to preserve Arabic ligature widths
export function measureTextUpToIndex(
  chars: Char[],
  formats: MarkSpan[],
  startIndex: number,
  endIndex: number,
  fontSize: number,
  baseFontWeight: string,
  fontFamily: FontFamily,
  fonts: FontStyles,
  _codePadding: number = 0,
  marks?: MarkRegistry,
): number {
  // Use batched measurement to preserve Arabic ligatures
  const batches = batchChars(chars, formats, startIndex, endIndex, marks);

  // Replacement-span atomic fixup. batchChars can produce a replacement batch
  // whose text is a *partial* slice of the span's source (when the requested
  // range cuts mid-span). measure() would then run on unparseable input. Rewrite
  // each replacement batch to match the wrap convention: the span's first char
  // carries the full rendered width, every other char in the span carries 0.
  // This keeps measurement consistent with rendering and wrapping, so the cursor
  // x stays aligned with the rendered run.
  if (batches.some((b) => b.replacement)) {
    const visIdxOfId = new Map<string, number>();
    const visibleChars: string[] = [];
    {
      let v = 0;
      for (const c of chars) {
        if (c.deleted) continue;
        visIdxOfId.set(c.id, v);
        visibleChars.push(c.char);
        v++;
      }
    }

    type ReplSpan = {
      startVisIdx: number;
      endVisIdx: number;
      text: string;
    };
    const replSpans: ReplSpan[] = [];
    for (const f of formats) {
      if (!marks?.get(f.format.type)?.replacement) continue;
      const s = visIdxOfId.get(f.startCharId);
      const e = visIdxOfId.get(f.endCharId);
      if (s === undefined || e === undefined) continue;
      replSpans.push({
        startVisIdx: s,
        endVisIdx: e,
        text: visibleChars.slice(s, e + 1).join(""),
      });
    }

    let visIdx = startIndex;
    for (const batch of batches) {
      const batchStart = visIdx;
      const batchEnd = batchStart + batch.text.length;
      visIdx = batchEnd;
      if (!batch.replacement) continue;
      const span = replSpans.find(
        (s) => s.startVisIdx <= batchStart && s.endVisIdx >= batchEnd - 1,
      );
      if (!span) continue;
      if (batchStart === span.startVisIdx) {
        // First char of the span is included → contribute full rendered width.
        // Use the full source so measure() hits the cache key used by paint.
        batch.text = span.text;
      } else {
        // Past the first char of the span → contribute 0 width.
        batch.text = "";
        batch.replacement = null;
      }
    }
  }

  return measureBatchedText(
    batches,
    fontSize,
    baseFontWeight,
    fontFamily,
    fonts,
  );
}

/**
 * Measure text width up to a specific index in the chars array
 * Uses batched measurement to preserve Arabic ligatures
 */
export function measureCharsUpToIndex(
  charRuns: CharRun[],
  formats: MarkSpan[],
  startIndex: number,
  endIndex: number,
  fontSize: number,
  baseFontWeight: string,
  fontFamily: FontFamily,
  fonts: FontStyles,
  codePadding: number = 0,
  marks?: MarkRegistry,
): number {
  // Convert charRuns to Char[] for compatibility with existing measurement code
  const chars = charRunsToChars(charRuns);
  // Use the batched measurement function from fonts.ts
  // This preserves Arabic ligatures by measuring text in batches with the same formatting
  return measureTextUpToIndex(
    chars,
    formats,
    startIndex,
    endIndex,
    fontSize,
    baseFontWeight,
    fontFamily,
    fonts,
    codePadding,
    marks,
  );
}

// Measure a single text segment with its formats
export function measureTextSegment(
  textSegment: TextSegment,
  fontSize: number,
  baseFontWeight: string,
  fontFamily: FontFamily,
  fonts: FontStyles,
  codePadding: number = 0,
): number {
  // Determine effective font weight (bold overrides base weight)
  const effectiveFontWeight = textSegment.formats?.some(
    (f) => f.type === "strong",
  )
    ? "bold"
    : baseFontWeight;

  let width = measureCtxText(
    textSegment.content,
    fontSize,
    effectiveFontWeight,
    fontFamily,
    fonts,
  );

  // Add code padding if applicable
  if (textSegment.formats?.some((f) => f.type === "code")) {
    width += codePadding * 2;
  }

  return width;
}

// Wrap CRDT text (Char[] with MarkSpan[]) for rendering
// Uses incremental character measurement for O(n) complexity
export function wrapText(
  chars: Char[],
  formats: MarkSpan[],
  maxWidth: number,
  fontSize: number,
  baseFontWeight: string,
  fontFamily: FontFamily,
  fonts: FontStyles,
  _codePadding: number = 0,
  _compositionRange: { start: number; end: number } | null = null,
  marks?: MarkRegistry,
): WrappedLine[] {
  // Get visible text
  const visibleChars = chars.filter((c) => !c.deleted);
  const fullText = visibleChars.map((c) => c.char).join("");

  if (fullText.length === 0) {
    return [{ text: "", consumedSpace: false }];
  }

  // Check if text contains CJK characters
  const hasCJK = containsCJK(fullText);

  // Pre-compute format info for each visible character (O(n) once)
  // Map from visible index to original chars array index
  const visibleToOriginalIndex: number[] = [];
  for (let i = 0; i < chars.length; i++) {
    if (!chars[i].deleted) {
      visibleToOriginalIndex.push(i);
    }
  }

  // Helper to get font weight for a character at visible index
  const getFontWeightAtIndex = (visibleIndex: number): string => {
    const originalIndex = visibleToOriginalIndex[visibleIndex];
    const charFormats = getFormatsAtIndex(originalIndex, chars, formats);
    return charFormats.some((f) => f.type === "strong")
      ? "bold"
      : baseFontWeight;
  };

  // Pre-compute replacement-span ranges (visible indices) and their rendered
  // widths. A replacement run (e.g. an inline-math chip) is drawn as a single
  // atomic unit whose width is the rendered width — not the sum of its source
  // character widths — so wrapping must treat the span as one unit at the
  // rendered width. We attribute the full span width to the first char and 0 to
  // the rest, making the span effectively non-breakable (subsequent 0-width
  // chars can never trigger a wrap on their own).
  const replSpanFirstWidth = new Map<number, number>();
  const replSpanIsTail = new Set<number>();
  for (const span of formats) {
    const replacement = marks?.get(span.format.type)?.replacement;
    if (!replacement) continue;
    const startOrig = chars.findIndex((c) => c.id === span.startCharId);
    const endOrig = chars.findIndex((c) => c.id === span.endCharId);
    if (startOrig === -1 || endOrig === -1) continue;
    let startVis = -1;
    let endVis = -1;
    for (let i = 0; i < visibleToOriginalIndex.length; i++) {
      const orig = visibleToOriginalIndex[i];
      if (orig === startOrig) startVis = i;
      if (orig === endOrig) endVis = i;
    }
    if (startVis === -1 || endVis === -1) continue;
    const text = visibleChars
      .slice(startVis, endVis + 1)
      .map((c) => c.char)
      .join("");
    const dims = replacement.measure(text, fontSize);
    if (!dims) continue; // fall through to plain-text widths on render error
    replSpanFirstWidth.set(startVis, dims.width);
    for (let i = startVis + 1; i <= endVis; i++) {
      replSpanIsTail.add(i);
    }
  }

  const lines: WrappedLine[] = [];
  let currentLine = "";
  let currentLineWidth = 0;

  // Track character widths for the current line (for backtracking on word wrap)
  let lineCharWidths: number[] = [];

  for (
    let visibleIndex = 0;
    visibleIndex < visibleChars.length;
    visibleIndex++
  ) {
    const char = visibleChars[visibleIndex].char;
    const isCJK = isCJKCharacter(char);
    const isSpace = char === " ";

    // Measure this single character (O(1) per character).
    // Replacement span: first char carries the full rendered width; remaining
    // chars carry 0 width so the span is atomic and never breaks mid-run.
    let charWidth: number;
    const replFirstWidth = replSpanFirstWidth.get(visibleIndex);
    if (replFirstWidth !== undefined) {
      charWidth = replFirstWidth;
    } else if (replSpanIsTail.has(visibleIndex)) {
      charWidth = 0;
    } else {
      const fontWeight = getFontWeightAtIndex(visibleIndex);
      charWidth = measureCtxText(char, fontSize, fontWeight, fontFamily, fonts);
    }

    // Check if adding this character would exceed max width
    if (currentLineWidth + charWidth > maxWidth && currentLine.length > 0) {
      // Line is full, need to wrap
      if (isCJK || isSpace || hasCJK) {
        // For CJK or spaces, break here
        lines.push({ text: currentLine, consumedSpace: isSpace });
        currentLine = isSpace ? "" : char;
        currentLineWidth = isSpace ? 0 : charWidth;
        lineCharWidths = isSpace ? [] : [charWidth];
      } else {
        // Latin character - try to find last space in current line
        const lastSpaceIndex = currentLine.lastIndexOf(" ");
        if (lastSpaceIndex > 0) {
          // Break at the space
          const lineToAdd = currentLine.substring(0, lastSpaceIndex);
          lines.push({ text: lineToAdd, consumedSpace: true });

          // Start new line with text after the space + current char
          const afterSpace = currentLine.substring(lastSpaceIndex + 1);
          currentLine = afterSpace + char;

          // Recalculate width for the carried-over text
          // Sum up the widths of characters after the space
          const charsAfterSpace = currentLine.length - 1; // -1 for new char
          let newLineWidth = charWidth;
          for (let i = 0; i < charsAfterSpace; i++) {
            newLineWidth += lineCharWidths[lastSpaceIndex + 1 + i];
          }
          currentLineWidth = newLineWidth;

          // Update lineCharWidths
          lineCharWidths = lineCharWidths.slice(lastSpaceIndex + 1);
          lineCharWidths.push(charWidth);
        } else {
          // No space found, force break
          lines.push({ text: currentLine, consumedSpace: false });
          currentLine = char;
          currentLineWidth = charWidth;
          lineCharWidths = [charWidth];
        }
      }
    } else {
      // Character fits on current line
      currentLine += char;
      currentLineWidth += charWidth;
      lineCharWidths.push(charWidth);
    }
  }

  // Add remaining text
  if (currentLine) {
    lines.push({ text: currentLine, consumedSpace: false });
  }

  return lines.length > 0 ? lines : [{ text: "", consumedSpace: false }];
}
