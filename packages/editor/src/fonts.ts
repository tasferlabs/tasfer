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
import { resolveMarkRunsFromChars } from "./inline-math-spans";
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

// A batch of consecutive characters with the same formatting.
//
// The batch carries only the metric-affecting facts the measurement engine
// needs — the folded font variants (`bold`/`italic`, from each mark's
// `MarkMetrics`) and `replacement` (a mark that renders its run as an atomic
// non-text unit, e.g. inline math, so its width is the rendered width). The
// *visual* mark channels (code chip, link, strike, color) are resolved from
// `formats` through the per-instance MarkRegistry at paint time, so they don't
// live here.
export interface TextBatch {
  text: string;
  formats: Mark[];
  /** Folded `MarkMetrics.bold` across the run — renders + measures heavier. */
  bold: boolean;
  /** Folded `MarkMetrics.italic` across the run — renders + measures slanted. */
  italic: boolean;
  /** The replacement renderer for this run, or null for plain text. */
  replacement: MarkReplacement | null;
  /**
   * Pre-resolved advance for this batch, overriding any measurement. Set for a
   * replacement batch whose width was computed per line-fragment by the layout
   * (so a chip wrapped across lines contributes its on-this-line width, not the
   * whole formula's) — see {@link measureTextUpToIndex}'s `replCharWidths`.
   */
  fixedWidth?: number;
}

/**
 * Fold the metric-affecting font variants of a run's marks into one resolved
 * pair (any mark that sets a flag wins). The measurement engine and paint both
 * read this so wrap/caret geometry stays in sync with what's drawn. Resolved
 * through the per-instance {@link MarkRegistry}; without it (no registry in
 * scope) a run carries no metric variants.
 */
export function composeMarkMetrics(
  formats: Mark[],
  marks: MarkRegistry | undefined,
): { bold: boolean; italic: boolean } {
  let bold = false;
  let italic = false;
  if (marks) {
    for (const f of formats) {
      const m = marks.get(f.type)?.metrics;
      if (!m) continue;
      if (m.bold) bold = true;
      if (m.italic) italic = true;
    }
  }
  return { bold, italic };
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

// Canvas context for measurements (created once, lazily). Created on first use
// rather than at module load so this module stays importable in DOM-free hosts
// (e.g. the device-node SharedWorker in `apps/web`), which pull `fonts` in
// transitively via the schema/node graph but never measure text.
// eslint-disable-next-line local/no-global-mutable-state -- stateless, reusable measurement context; instance-independent, so two instances can't collide.
let measurementCanvas: CanvasRenderingContext2D | null = null;
function getMeasurementCanvas(): CanvasRenderingContext2D {
  if (!measurementCanvas) {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    measurementCanvas = canvas.getContext("2d")!;
  }
  return measurementCanvas;
}

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
  texFallbackCache = new Map();
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
  texFallbackCache = new Map();
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
  fontStyle: string = "normal",
): string {
  const fontStack = getFontStack(fontFamily, fonts);
  // Only prefix a non-default style so plain (non-italic) font strings stay
  // byte-identical to before — keeps the hot ctx.font cache key stable.
  const stylePrefix =
    fontStyle && fontStyle !== "normal" ? `${fontStyle} ` : "";
  const font = `${stylePrefix}${fontWeight} ${fontSize}px ${fontStack}`;
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
  const ctx = getMeasurementCanvas();
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
  fontStyle: string = "normal",
): number {
  const ctx = getMeasurementCanvas();
  // <= 2 covers surrogate pairs while keeping the cache bounded
  if (text.length <= 2) {
    const fontStack = getFontStack(fontFamily, fonts);
    const cacheKey = `${fontStack}|${fontStyle}|${fontWeight}|${fontSize}|${text}`;
    let width = charWidthCache.get(cacheKey);
    if (width === undefined) {
      applyFont(ctx, fontSize, fontWeight, fontFamily, fonts, fontStyle);
      width = ctx.measureText(text).width;
      charWidthCache.set(cacheKey, width);
    }
    return width;
  }

  applyFont(ctx, fontSize, fontWeight, fontFamily, fonts, fontStyle);
  return ctx.measureText(text).width;
}

// Em metrics for @cypherkit/tex's `\text{…}` fallback, keyed by
// `fontFamily|char`. Pure (a browser fact about a CSS family + glyph), so like
// charWidthCache it is instance-independent; flushed with the other caches when
// faces load/change.
// eslint-disable-next-line local/no-global-mutable-state -- pure per-(family,char) em-metrics cache; instance-independent, so two instances can't collide.
let texFallbackCache = new Map<
  string,
  { width: number; ascent: number; depth: number }
>();

// Reference pixel size the fallback is measured at. Canvas text advance scales
// linearly with size for a given family, so em = px / REF is size-independent.
const TEX_FALLBACK_REF_PX = 100;

/**
 * Measure a single character for the tex `\text{…}` fallback (see
 * {@link getTexTextFallback}), in em at size 1, using `fontFamily`. The math
 * engine calls this for characters its own fonts have no glyph for (CJK, emoji,
 * …) so they lay out at their true width; the same `fontFamily` paints them, so
 * geometry and paint agree. Height/depth come from the font's bounding box for a
 * stable line size across scripts.
 */
export function measureTexFallbackEm(
  text: string,
  fontFamily: string,
): { width: number; ascent: number; depth: number } {
  const cacheKey = `${fontFamily}|${text}`;
  const cached = texFallbackCache.get(cacheKey);
  if (cached) return cached;

  const ctx = getMeasurementCanvas();
  ctx.font = `${TEX_FALLBACK_REF_PX}px ${fontFamily}`;
  // We set ctx.font directly (not via applyFont); drop the applyFont cache entry
  // for this ctx so the next applyFont re-applies rather than trusting a stale key.
  lastAppliedFont.delete(ctx);
  const m = ctx.measureText(text);
  const metrics = {
    width: m.width / TEX_FALLBACK_REF_PX,
    ascent:
      (m.fontBoundingBoxAscent || TEX_FALLBACK_REF_PX * 0.88) /
      TEX_FALLBACK_REF_PX,
    depth:
      (m.fontBoundingBoxDescent || TEX_FALLBACK_REF_PX * 0.12) /
      TEX_FALLBACK_REF_PX,
  };
  texFallbackCache.set(cacheKey, metrics);
  return metrics;
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

  // Resolve each span's char-array index range ONCE. The shared
  // getFormatsAtIndex resolves a span's endpoints with a linear findIndex per
  // char, so calling it in this per-char loop was O(chars² × spans) — the
  // dominant hit-test cost on a long single-run line (a matrix's LaTeX source).
  // An id→index map makes the per-char lookup O(spans).
  const indexOfId = new Map<string, number>();
  for (let i = 0; i < chars.length; i++) indexOfId.set(chars[i].id, i);
  const spanRanges = formats.map((span) => ({
    format: span.format,
    start: indexOfId.get(span.startCharId) ?? -1,
    end: indexOfId.get(span.endCharId) ?? -1,
  }));
  const formatsAtIndex = (i: number): Mark[] => {
    const active: Mark[] = [];
    for (const r of spanRanges) {
      if (r.start !== -1 && r.end !== -1 && i >= r.start && i <= r.end) {
        active.push(r.format);
      }
    }
    return active;
  };

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

    const charFormats = formatsAtIndex(i);
    const formatKey = getFormatKey(charFormats);

    if (currentBatch && getFormatKey(currentBatch.formats) === formatKey) {
      // Same formatting, append to current batch
      currentBatch.text += char.char;
    } else {
      // Different formatting, start new batch. Only the metric-affecting facts
      // (folded font variants, replacement renderer) are precomputed; visual
      // channels are resolved from `formats` via the MarkRegistry at paint time.
      const metrics = composeMarkMetrics(charFormats, marks);
      currentBatch = {
        text: char.char,
        formats: charFormats,
        bold: metrics.bold,
        italic: metrics.italic,
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
    // A layout-resolved per-fragment width wins (a chip wrapped across lines).
    if (batch.fixedWidth !== undefined) {
      width += batch.fixedWidth;
      continue;
    }
    if (batch.replacement) {
      const dims = batch.replacement.measure(batch.text, fontSize);
      if (dims) {
        width += dims.width;
        continue;
      }
      // Fall back to text measurement on render error
    }
    const effectiveFontWeight = batch.bold ? "bold" : baseFontWeight;
    const fontStyle = batch.italic ? "italic" : "normal";
    // Measure the entire batch as a string (preserves ligature widths)
    width += measureCtxText(
      batch.text,
      fontSize,
      effectiveFontWeight,
      fontFamily,
      fonts,
      fontStyle,
    );
  }

  return width;
}

/**
 * Calculate cumulative widths for all character positions in a range.
 * Optimized for cursor positioning while preserving Arabic ligatures.
 *
 * The range is batched ONCE (by formatting run) and, within each batch, its
 * prefix strings are measured as whole strings — exactly how the painter lays a
 * line down: `ctx.fillText(batch.text, x)` per run, runs placed left to right
 * (TextNode.paint). Measuring each prefix whole keeps within-run kerning and
 * cursive joins (Arabic and other connected scripts) byte-identical to the
 * paint, so the caret lands on the rendered glyph boundary. Because runs are
 * painted independently, cross-run width is additive here too — matching the
 * painter, which advances `x` by each run's measured width.
 *
 * This replaced a per-position `measureTextUpToIndex` call that re-batched the
 * whole prefix on every position and, through the linear id lookups in
 * `getFormatsAtIndex`, degraded to roughly O(n³) on a long single-run line — a
 * large matrix's LaTeX source while it is being edited. Batching once collapses
 * that to a single formatting pass plus the prefix measurements, with identical
 * output.
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
  replCharWidths?: Map<number, number>,
): number[] {
  const lineLength = endIndex - startIndex;
  const positions: number[] = new Array(lineLength + 1);
  positions[0] = 0;
  if (lineLength <= 0) return positions;

  // Batch the visible range once (by formatting run), instead of re-batching a
  // growing prefix for every position.
  const batches = batchChars(chars, formats, startIndex, endIndex, marks);
  const hasReplacement = batches.some((b) => b.replacement);

  // A replacement run (inline-math chip) renders as one glyph box, so its whole
  // rendered width rides on its first char (0 on the rest) unless the layout
  // recorded per-fragment widths for a wrapped chip (`replCharWidths`). Resolve
  // each replacement span's visible-index range and rendered width ONCE here.
  // measureTextUpToIndex rebuilt these maps on every call; driving it per
  // position made hit-testing a line with a chip O(n²) (the profiled cost).
  const replSpans: { start: number; end: number; width: number }[] = [];
  if (hasReplacement && !replCharWidths) {
    const visIdxOfId = new Map<string, number>();
    const visibleChars: string[] = [];
    let v = 0;
    for (const c of chars) {
      if (c.deleted) continue;
      visIdxOfId.set(c.id, v++);
      visibleChars.push(c.char);
    }
    for (const f of formats) {
      const repl = marks?.get(f.format.type)?.replacement;
      if (!repl) continue;
      const s = visIdxOfId.get(f.startCharId);
      const e = visIdxOfId.get(f.endCharId);
      if (s === undefined || e === undefined) continue;
      const dims = repl.measure(
        visibleChars.slice(s, e + 1).join(""),
        fontSize,
      );
      // A render error (dims undefined) makes the chip fall back to its plain
      // source width; NaN flags that so the batch takes the text path below.
      replSpans.push({ start: s, end: e, width: dims ? dims.width : NaN });
    }
  }

  // `widthBefore` is the summed width of completed batches; each position is that
  // plus the current batch's contribution. For text runs that contribution is
  // the whole-prefix measurement (kerning / cursive joins), matching the
  // painter's per-run fillText; for replacement runs it is the additive per-char
  // model above. Output is identical to the old per-position path, without its
  // per-position re-batching and map rebuilds.
  let pos = 1;
  let widthBefore = 0;
  let visIdx = startIndex;

  const textPrefixWidths = (batch: TextBatch): void => {
    const weight = batch.bold ? "bold" : baseFontWeight;
    const style = batch.italic ? "italic" : "normal";
    const { text } = batch;
    for (let k = 1; k < text.length; k++) {
      positions[pos++] =
        widthBefore +
        measureCtxText(
          text.slice(0, k),
          fontSize,
          weight,
          fontFamily,
          fonts,
          style,
        );
    }
    widthBefore += measureCtxText(
      text,
      fontSize,
      weight,
      fontFamily,
      fonts,
      style,
    );
    positions[pos++] = widthBefore;
  };

  for (const batch of batches) {
    const len = batch.text.length;

    if (!batch.replacement) {
      textPrefixWidths(batch);
      visIdx += len;
      continue;
    }

    if (replCharWidths) {
      // Wrapped-chip fragment: each char carries its recorded on-this-line width.
      let acc = widthBefore;
      for (let k = 0; k < len; k++) {
        acc += replCharWidths.get(visIdx + k) ?? 0;
        positions[pos++] = acc;
      }
      widthBefore = acc;
      visIdx += len;
      continue;
    }

    // Atomic chip: full width on the run's first char, but only when this batch
    // begins the span — a fragment that can't see the chip's start contributes
    // nothing (matches measureTextUpToIndex's span fixup).
    const span = replSpans.find(
      (s) => s.start <= visIdx && s.end >= visIdx + len - 1,
    );
    if (span && Number.isNaN(span.width)) {
      textPrefixWidths(batch); // render error → source width, as batched measure does
    } else {
      const w = span && visIdx === span.start ? span.width : 0;
      for (let k = 1; k <= len; k++) positions[pos++] = widthBefore + w;
      widthBefore += w;
    }
    visIdx += len;
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
  // Per-visible-index advance override for replacement chips, keyed by visible
  // char index. When a chip wraps across lines the layout splits it into
  // per-line fragments and records, here, each fragment's first char → its
  // on-this-line rendered width and the rest → 0. Supplying it makes width
  // measurement attribute each line's slice its own advance (instead of the
  // whole formula's), keeping the caret aligned with the reflowed paint. When
  // omitted, the legacy whole-chip atomic fixup below applies.
  replCharWidths?: Map<number, number>,
): number {
  // Use batched measurement to preserve Arabic ligatures
  const batches = batchChars(chars, formats, startIndex, endIndex, marks);

  // Per-fragment override: attribute each replacement batch the sum of its
  // chars' recorded widths (a wrapped chip's slice on this line), so a batch that
  // is the middle/end of a chip still contributes its real width.
  if (replCharWidths && batches.some((b) => b.replacement)) {
    let visIdx = startIndex;
    for (const batch of batches) {
      const batchStart = visIdx;
      const batchEnd = batchStart + batch.text.length;
      visIdx = batchEnd;
      if (!batch.replacement) continue;
      let w = 0;
      for (let v = batchStart; v < batchEnd; v++)
        w += replCharWidths.get(v) ?? 0;
      batch.fixedWidth = w;
    }
    return measureBatchedText(
      batches,
      fontSize,
      baseFontWeight,
      fontFamily,
      fonts,
    );
  }

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
  replCharWidths?: Map<number, number>,
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
    replCharWidths,
  );
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
  // Whether a replacement run (inline-math chip) may be SPLIT across lines at its
  // internal break offsets. True in LTR text (the chip reflows at its operators).
  // False in RTL: a formula is an atomic LTR box within the bidi line — the same
  // model every mainstream system uses (browsers/KaTeX/MathJax keep inline math
  // an atomic inline-block; bidi TeX places it as one LTR box) — because the
  // RTL caret/selection/paint paths treat a chip atomically, so splitting it
  // here would only diverge from them. An atomic chip still wraps as a WHOLE unit
  // (moves to its own line; overflows/cuts if wider than the line).
  allowReplacementBreaks: boolean = true,
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

  // Helper to get the metric-affecting font variant for a character at visible
  // index — folded from its marks' MarkMetrics through the registry.
  const getFontVariantAtIndex = (
    visibleIndex: number,
  ): { weight: string; style: string } => {
    const originalIndex = visibleToOriginalIndex[visibleIndex];
    const charFormats = getFormatsAtIndex(originalIndex, chars, formats);
    const metrics = composeMarkMetrics(charFormats, marks);
    return {
      weight: metrics.bold ? "bold" : baseFontWeight,
      style: metrics.italic ? "italic" : "normal",
    };
  };

  // Pre-compute replacement-span layout for wrapping. A replacement run (an
  // inline-math chip) renders as glyphs, not its source characters, so wrapping
  // must use its rendered width. A run MAY expose internal break offsets (math's
  // top-level operators) so a too-wide run flows across lines instead of
  // overflowing as one block: we split it into SEGMENTS at those offsets,
  // attribute each segment's rendered width to the segment's first char (0 to the
  // rest, so a wrap can only trigger at a segment start), and mark each interior
  // segment start as a break opportunity. A run with no break offsets is one
  // segment — the classic atomic chip. `chipChars` flags every char inside a run
  // so the Latin space-backtrack never splits a run at a space in its SOURCE
  // (e.g. `\sin x`), which would render an invalid slice.
  const segFirstWidth = new Map<number, number>();
  const chipTail = new Set<number>();
  const segBreakBefore = new Set<number>();
  const chipChars = new Set<number>();
  // Resolve replacement runs through the SAME tolerant, ordinal-based resolver
  // the paint/caret path uses (`TextNode.replacementRuns`). A strict
  // `startCharId`/`endCharId` lookup dropped a whole chip to plain text — losing
  // its wrap breakpoints — the instant an endpoint char was tombstoned (e.g.
  // backspacing a chip's first/last char), so a wrapped formula stopped wrapping
  // on delete while paint still drew it as a formula. `run.endIndex` is the
  // caret-edge (after the last surviving char), so the last visible index is
  // `endIndex - 1`.
  for (const run of resolveMarkRunsFromChars(chars, formats)) {
    const replacement = marks?.get(run.name)?.replacement;
    if (!replacement) continue;
    const startVis = run.startIndex;
    const endVis = run.endIndex - 1;
    if (endVis < startVis) continue;
    const text = run.text;
    const dims = replacement.measure(text, fontSize);
    if (!dims) continue; // fall through to plain-text widths on render error
    for (let i = startVis; i <= endVis; i++) chipChars.add(i);

    // Segment boundaries within the run: [0, ...interior breaks, length]. In RTL
    // the chip stays atomic (no interior breaks), so it's one whole segment.
    const rawBreaks = allowReplacementBreaks
      ? (replacement.breakpoints?.(text, fontSize) ?? [])
      : [];
    const bounds = [
      0,
      ...rawBreaks
        .filter((b) => b > 0 && b < text.length)
        .sort((a, b) => a - b),
      text.length,
    ];
    // Cumulative rendered width up to each boundary (measured WITH leading
    // context, so a segment's leading inter-atom glue rides with it — a small,
    // safe overestimate of a continuation line's true standalone width, so wrap
    // never packs a line past the budget).
    const cum = [0];
    for (let k = 1; k < bounds.length; k++) {
      const d =
        bounds[k] === text.length
          ? dims
          : replacement.measure(text.slice(0, bounds[k]), fontSize);
      cum.push(d ? d.width : cum[k - 1]);
    }
    for (let k = 0; k + 1 < bounds.length; k++) {
      const segStartVis = startVis + bounds[k];
      segFirstWidth.set(segStartVis, Math.max(0, cum[k + 1] - cum[k]));
      if (k > 0) segBreakBefore.add(segStartVis); // interior break: may lead a line
      for (
        let v = startVis + bounds[k] + 1;
        v < startVis + bounds[k + 1];
        v++
      ) {
        chipTail.add(v);
      }
    }
  }

  const lines: WrappedLine[] = [];
  let currentLine = "";
  let currentLineWidth = 0;

  // Per-line parallel arrays: each char's width and its visible index (the latter
  // lets the Latin backtrack skip spaces that live inside a replacement run).
  let lineCharWidths: number[] = [];
  let lineCharVis: number[] = [];

  for (
    let visibleIndex = 0;
    visibleIndex < visibleChars.length;
    visibleIndex++
  ) {
    const char = visibleChars[visibleIndex].char;
    const isCJK = isCJKCharacter(char);
    const isSpace = char === " ";

    // Measure this single character (O(1) per character). A replacement segment's
    // first char carries the segment width; the rest carry 0.
    let charWidth: number;
    const segW = segFirstWidth.get(visibleIndex);
    // A chip-interior char: inside a replacement segment but not its first char,
    // so it carries 0 width and must always ride with its segment (never start or
    // force a line on its own).
    const isChipTail = segW === undefined && chipTail.has(visibleIndex);
    if (segW !== undefined) {
      charWidth = segW;
    } else if (isChipTail) {
      charWidth = 0;
    } else {
      const { weight, style } = getFontVariantAtIndex(visibleIndex);
      charWidth = measureCtxText(
        char,
        fontSize,
        weight,
        fontFamily,
        fonts,
        style,
      );
    }
    // A break may be taken before this char when it starts an interior segment of
    // a replacement run (math operator) — the run's source splits here.
    const isSegBreak = segBreakBefore.has(visibleIndex);

    // Check if adding this character would exceed max width. A chip-interior char
    // (0 width) never triggers a wrap on its own: once a chip overflows, its tail
    // chars would otherwise re-trip this and carve the formula char by char — an
    // atomic / too-wide chip must overflow as one piece (the "cut" terminal case),
    // not shatter. It always rides with the segment it belongs to.
    if (
      currentLineWidth + charWidth > maxWidth &&
      currentLine.length > 0 &&
      !isChipTail
    ) {
      // Line is full, need to wrap
      if (isSegBreak) {
        // Break before this math segment so it leads the continuation line; each
        // line's chip slice renders standalone.
        lines.push({ text: currentLine, consumedSpace: false });
        currentLine = char;
        currentLineWidth = charWidth;
        lineCharWidths = [charWidth];
        lineCharVis = [visibleIndex];
      } else if (isCJK || isSpace || hasCJK) {
        // For CJK or spaces, break here
        lines.push({ text: currentLine, consumedSpace: isSpace });
        currentLine = isSpace ? "" : char;
        currentLineWidth = isSpace ? 0 : charWidth;
        lineCharWidths = isSpace ? [] : [charWidth];
        lineCharVis = isSpace ? [] : [visibleIndex];
      } else {
        // Latin character - break at the last space NOT inside a replacement run
        // (a chip's source spaces, e.g. `\sin x`, are not legal break points).
        let lastSpaceIndex = -1;
        for (let p = currentLine.length - 1; p > 0; p--) {
          if (currentLine[p] === " " && !chipChars.has(lineCharVis[p])) {
            lastSpaceIndex = p;
            break;
          }
        }
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

          // Update parallel per-line arrays
          lineCharWidths = lineCharWidths.slice(lastSpaceIndex + 1);
          lineCharWidths.push(charWidth);
          lineCharVis = lineCharVis.slice(lastSpaceIndex + 1);
          lineCharVis.push(visibleIndex);
        } else {
          // No space found, force break
          lines.push({ text: currentLine, consumedSpace: false });
          currentLine = char;
          currentLineWidth = charWidth;
          lineCharWidths = [charWidth];
          lineCharVis = [visibleIndex];
        }
      }
    } else {
      // Character fits on current line
      currentLine += char;
      currentLineWidth += charWidth;
      lineCharWidths.push(charWidth);
      lineCharVis.push(visibleIndex);
    }
  }

  // Add remaining text
  if (currentLine) {
    lines.push({ text: currentLine, consumedSpace: false });
  }

  return lines.length > 0 ? lines : [{ text: "", consumedSpace: false }];
}
