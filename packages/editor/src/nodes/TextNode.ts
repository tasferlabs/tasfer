/**
 * TextNode — the on-canvas behavior for every textual block (headings,
 * paragraph, and the bullet/numbered/todo list family).
 *
 * This is the heart of the "geometry on the view" design. Historically the text
 * layout (wrap + indent/marker offsets + RTL base-x + line metrics) was
 * re-derived independently in ~10 places: the render pass, the height pass, the
 * caret-coordinate pass, the click→position hit-test, and the selection-rect
 * pass — each re-calling wrapText/getTextStyle/getFontMetrics with the same
 * inputs. They agreed only because they all happened to read the same styles.
 * The moment a block lays text out differently (a custom style, a custom block)
 * those parallel derivations drift and the caret lands in the wrong place.
 *
 * The fix is a single canonical `layout()` that every pass consumes:
 *
 *   layout()       — wrap + measure once → TextNodeLayout (height + line boxes
 *                    + the indent/marker/RTL geometry needed downstream)
 *   paint()        — draw from a layout (never re-wraps)
 *   caretRect()    — caret screen rect from a layout (used by selection.ts)
 *   positionFromPoint() — click→caret index from a layout (hit-testing)
 *   selectionRects()    — highlight rectangles from a layout
 *
 * All arithmetic here was moved verbatim from renderer.ts / selection.ts so
 * behavior is preserved; the win is that there is now exactly one source of
 * truth for text geometry.
 *
 * Serialization (markdown/HTML/text round-trip) lives as methods on the class,
 * adapted into a BlockCodec by the schema. This is also the parser's fallback:
 * any block-start token no codec claims (plain text, unknown HTML tags,
 * heading4+ tokens) parses as a paragraph, with the unclaimed token's content
 * flowing into the text via `inlineText()`.
 */

import { analyzeLineBidi } from "../bidi";
import {
  batchChars,
  currentFontFamily,
  type FontFamily,
  getFontMetrics,
  getFontStack,
  measureCRDTPositions,
  measureTextUpToIndex,
  type TextBatch,
  type WrappedLine,
  wrapText,
} from "../fonts";
import { resolveMarkRunsFromChars } from "../inline-math-spans";
import {
  getBlockTextContent,
  isTouchDevice,
  memoizeNodeLayout,
  mergeBlockStyle,
} from "../node-shared";
import {
  allDecorations,
  rangeDecorationToSelection,
} from "../rendering/decorations";
import type {
  MarkChipStyle,
  MarkRegistry,
  MarkReplacement,
  MarkReplacementEdit,
  MarkUnderlineStyle,
} from "../rendering/marks";
import {
  type BlockRuntimeState,
  Node,
  type NodeLayout,
  type NodeLayoutCtx,
  type NodePaintCtx,
} from "../rendering/nodes/Node";
import { getTextDirection } from "../rtl";
import type { InputCtx, NodeCodec } from "../serlization/codecs/types";
import type {
  Block,
  Char,
  CharRun,
  Mark,
  MarkSpan,
} from "../serlization/loadPage";
import {
  HEADING_1,
  HEADING_2,
  HEADING_3,
  NEWLINE,
} from "../serlization/tokenizer";
import type {
  BlockBounds,
  EditorState,
  EditorStyles,
  FontMetrics,
  FontStyles,
  Position,
  RenderedBlock,
  RenderedLine,
  TextStyle,
} from "../state-types";
import { isCaretScratchActive, transformTypedInput } from "../state-utils";
import { isTextualBlock } from "../sync/block-registry";
import {
  charRunsToChars,
  getVisibleTextFromChars,
  getVisibleTextFromRuns,
  iterateAllChars,
} from "../sync/char-runs";
import type { CodeBlock } from "./CodeNode";
import type { ListBlock } from "./ListNode";
import type { MathBlock } from "./MathNode";
import type { QuoteBlock } from "./QuoteNode";

/**
 * A replacement-mark run resolved against a resolved `Char[]` view: `[start,
 * end)` are visible-character indices (the caret-edge range), `text` is the run's
 * source (the run's visible chars), and `replacement` is the mark's renderer. The
 * geometry passes use this to let the caret descend INTO a replacement (e.g. an
 * inline-math chip) — interior indices map to rendered positions via the
 * replacement's `caretRect`/`hitTest`, with no math-specific knowledge here.
 */
interface ReplacementRun {
  readonly start: number;
  readonly end: number;
  readonly text: string;
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
function replacementRuns(
  chars: Char[],
  formats: MarkSpan[],
  marks: MarkRegistry,
): ReplacementRun[] {
  if (!formats.some((f) => marks.get(f.format.type)?.replacement)) return [];
  const runs: ReplacementRun[] = [];
  for (const run of resolveMarkRunsFromChars(chars, formats)) {
    const replacement = marks.get(run.name)?.replacement;
    if (!replacement) continue;
    runs.push({
      start: run.startIndex,
      end: run.endIndex,
      text: run.text,
      replacement,
    });
  }
  return runs;
}

/** The replacement run strictly containing `index` (start < index < end), or null. */
function enclosingReplacementRun(
  runs: ReplacementRun[],
  index: number,
): ReplacementRun | null {
  for (const run of runs) {
    if (index > run.start && index < run.end) return run;
  }
  return null;
}

/**
 * The block types handled by TextNode itself: headings + paragraph.
 *
 * The bullet/numbered/todo list family is handled by `ListNode`, a subclass
 * registered separately so a host can opt out of lists. ListNode inherits
 * all the text geometry here and only overrides the leading-inset, marker, and
 * placeholder hooks (see the `protected` methods at the bottom of the class).
 */
export const TEXT_BLOCK_TYPES = [
  "heading1",
  "heading2",
  "heading3",
  "paragraph",
] as const;

/**
 * The canonical text layout. Extends NodeLayout (height + line boxes) with the
 * derived geometry every text pass needs, so no pass re-derives it.
 *
 * `lines` boxes carry x/y RELATIVE to the block's content origin is intentional:
 * absolute positioning differs between the scroll-space render pass and the
 * document-space caret pass, so callers add their own origin. The line boxes do
 * carry absolute-independent fields: width, height, startIndex, endIndex.
 */
export interface TextNodeLayout extends NodeLayout {
  readonly isRTL: boolean;
  readonly textStyle: TextStyle;
  readonly fontFamily: FontFamily;
  /** Resolved font registry for this instance — used to resolve `fontFamily`
   *  to a CSS stack during measurement (keeps caret/hit-test in sync). */
  readonly fonts: FontStyles;
  /** Resolved mark registry for this instance — lets caret/hit-test/selection
   *  measurement reserve a replacement run's rendered width (e.g. an inline-math
   *  chip), keeping them in sync with wrap + paint. */
  readonly marks?: MarkRegistry;
  readonly codePadding: number;
  readonly fontMetrics: FontMetrics;
  readonly lineHeight: number;
  readonly indentOffset: number;
  readonly markerWidth: number;
  /**
   * Vertical inset before the first line (and mirrored after the last via the
   * style's paddingBottom). Zero for every built-in text block; CodeNode uses it
   * to pad text down from the top of its background box. Every Y-positioned pass
   * (paint, caret, hit-test, selection) starts from `blockTop + insetY`.
   */
  readonly insetY: number;
  /** Content width available to text (maxWidth minus list indent + marker). */
  readonly adjustedMaxWidth: number;
  /** Resolved characters used for this layout (may include composition text). */
  readonly chars: Char[];
  readonly formats: MarkSpan[];
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
}

/** Arguments to the {@link TextNode.renderLineText} glyph-drawing hook. */
export interface RenderLineTextArgs {
  readonly block: TextualBlock;
  readonly ctx: CanvasRenderingContext2D;
  readonly chars: Char[];
  readonly formats: MarkSpan[];
  readonly lineStartIndex: number;
  readonly lineEndIndex: number;
  /** The line's visible text (already resolved, composition folded in). */
  readonly lineText: string;
  /** Left edge to start drawing from (RTL callers pass the right edge). */
  readonly x: number;
  readonly baselineY: number;
  readonly textStyle: TextStyle;
  readonly fontFamily: FontFamily;
  readonly styles: EditorStyles;
  readonly marks: MarkRegistry;
  readonly isRTL: boolean;
  readonly requestRedraw: () => void;
  readonly hoveredInlineMath: { startIndex: number; endIndex: number } | null;
  /** Block text index of the collapsed caret when it's in this block, else null. */
  readonly caretIndex: number | null;
  /** Whether a math command is being typed at `caretIndex` (render it literally). */
  readonly commandEntryActive: boolean;
}

export interface Heading extends BlockRuntimeState {
  type: "heading1" | "heading2" | "heading3";
  charRuns: CharRun[]; // Character runs (squashed CRDT storage)
  formats: MarkSpan[]; // Format spans reference char IDs
}
export interface Paragraph extends BlockRuntimeState {
  type: "paragraph";
  charRuns: CharRun[]; // Character runs (squashed CRDT storage)
  formats: MarkSpan[]; // Format spans reference char IDs
}

export type TextBlock = Heading | Paragraph;
export type TextualBlock =
  | TextBlock
  | ListBlock
  | CodeBlock
  | MathBlock
  | QuoteBlock;

// ---------------------------------------------------------------------------
// Composition injection (shared with the renderer's cursor layer)
// ---------------------------------------------------------------------------

/**
 * Inject the active IME composition text into a block's characters for layout.
 * Returns plain content when no composition is active in this block.
 *
 * Moved verbatim from renderer.ts so both the text view (paint) and the cursor
 * layer (renderer) resolve composition content identically.
 */
export function getContentWithComposition(
  block: Block,
  state: EditorState,
  blockIndex: number,
): {
  chars: Char[];
  formats: MarkSpan[];
  compositionRange: { start: number; end: number } | null;
} {
  if (!isTextualBlock(block)) {
    return { chars: [], formats: [], compositionRange: null };
  }

  // Check if composition is active and cursor is in this block
  if (
    !state.ui.composition ||
    !state.ui.composition.isComposing ||
    !state.document.cursor ||
    state.document.cursor.position.blockIndex !== blockIndex
  ) {
    return {
      chars: charRunsToChars(block.charRuns),
      formats: block.formats,
      compositionRange: null,
    };
  }

  const compositionText = state.ui.composition.text;
  if (!compositionText) {
    return {
      chars: charRunsToChars(block.charRuns),
      formats: block.formats,
      compositionRange: null,
    };
  }

  const caretIndex = state.document.cursor.position.textIndex;

  // Run the preview through the SAME node/mark transform the commit uses (see
  // transformTypedInput → the caret seam). This is what keeps a formula typeset
  // while composing: in math the transform wraps CJK into `\text{…}` (which the
  // host font renders) or merges it into an adjacent run, so the injected preview
  // parses instead of de-typesetting the equation into raw source, and it matches
  // exactly what compositionend will commit. In prose the transform is a no-op,
  // so the raw text is injected at the caret, unchanged. A transform that swallows
  // the input (nothing renderable) shows the plain block.
  const transform = transformTypedInput(
    state,
    block,
    caretIndex,
    compositionText,
  );
  const previewText = transform?.input ?? compositionText;
  const insertAt = transform?.insertAt ?? caretIndex;
  if (previewText.length === 0) {
    return {
      chars: charRunsToChars(block.charRuns),
      formats: block.formats,
      compositionRange: null,
    };
  }

  // Create temporary composition chars (without IDs since they're not persisted)
  const compositionChars: Char[] = Array.from(previewText).map((char, i) => ({
    id: `composition-${i}`,
    char,
    deleted: false,
  }));

  // Insert the preview chars at `insertAt` (a VISIBLE index) while keeping
  // tombstoned chars in document order. `resolveMarkRunsFromChars` (the
  // replacement/chip resolver used by the layout below) anchors each mark span
  // to its exact endpoint char IDs and DROPS the span outright when an endpoint
  // isn't present in the char array. So the array must include deleted chars —
  // exactly what the canonical `charRunsToChars` path does. Iterating only
  // VISIBLE chars here silently hid any chip whose boundary char had been
  // tombstoned (common after editing a chip), flashing the whole formula to raw
  // LaTeX for the duration of the composition even when the preview lands
  // outside the chip. Injecting before the visible char at `insertAt` keeps the
  // preview where the commit will land; interleaved tombstones stay put.
  const modifiedChars: Char[] = [];
  let visibleIndex = 0;
  let insertionDone = false;

  for (const { id, char, deleted } of iterateAllChars(block.charRuns)) {
    if (!deleted && visibleIndex === insertAt && !insertionDone) {
      modifiedChars.push(...compositionChars);
      insertionDone = true;
    }
    modifiedChars.push({ id, char, ...(deleted ? { deleted: true } : {}) });
    if (!deleted) visibleIndex++;
  }

  // If the insert point is at the end (past the last visible char), append it.
  if (!insertionDone) {
    modifiedChars.push(...compositionChars);
  }

  return {
    chars: modifiedChars,
    formats: block.formats, // Keep formats as-is
    compositionRange: {
      start: insertAt,
      end: insertAt + previewText.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Measurement / drawing helpers (moved verbatim from renderer.ts)
// ---------------------------------------------------------------------------

// Measure the width of a portion of CRDT text using batched (ligature-safe)
// measurement so cursor x stays aligned with wrap + render.
function measureLineWidth(
  chars: Char[],
  formats: MarkSpan[],
  lineStartIndex: number,
  lineEndIndex: number,
  textStyle: TextStyle,
  fontFamily: FontFamily,
  fonts: FontStyles,
  codePadding: number,
  marks?: MarkRegistry,
  replCharWidths?: Map<number, number>,
): number {
  return measureTextUpToIndex(
    chars,
    formats,
    lineStartIndex,
    lineEndIndex,
    textStyle.fontSize,
    textStyle.fontWeight,
    fontFamily,
    fonts,
    codePadding,
    marks,
    replCharWidths,
  );
}

// Draw already-resolved placeholder text. The text itself is resolved by the
// view's `placeholderText` hook (paragraph/heading in the base class, list/todo
// in ListNode), so this helper stays type-agnostic.
function renderPlaceholder(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  styles: EditorStyles,
  textStyle: TextStyle,
  text: string,
  isRTL: boolean,
  maxWidth: number,
) {
  if (!text) return;
  // Appearance is resolved per block from the block's own placeholder override
  // (color / relative size / weight), falling back to the global placeholder
  // color, a 1× scale, and the block's own weight. This keeps type-specific
  // placeholder styling (e.g. the quote's smaller ghost) in the theme rather
  // than in node code, with no type switch here.
  const ph = textStyle.placeholder;
  const fontSize = Math.round(textStyle.fontSize * (ph?.fontScale ?? 1));
  const fontWeight = ph?.fontWeight ?? textStyle.fontWeight;
  ctx.save();
  ctx.fillStyle = ph?.color ?? styles.placeholder.color;
  ctx.font = `${fontWeight} ${fontSize}px ${getFontStack(
    currentFontFamily(styles),
    styles.fonts,
  )}`;
  ctx.textBaseline = "alphabetic";
  ctx.direction = isRTL ? "rtl" : "ltr";

  // Clamp to the available text width so long placeholders (e.g. the quote's
  // "Write something worth remembering…") don't spill past the node and off the
  // viewport on narrow screens. Real content wraps; the ghost text is a single
  // line, so we truncate it with an ellipsis instead.
  const drawn = maxWidth > 0 ? truncateToWidth(ctx, text, maxWidth) : text;
  const textX = isRTL ? x + maxWidth : x;
  ctx.fillText(drawn, textX, y);
  ctx.restore();
}

// Shorten `text` to the longest prefix that fits `maxWidth` once the trailing
// ellipsis is appended. Assumes `ctx.font` is already set. Returns `text`
// unchanged when it already fits.
function truncateToWidth(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  const ellipsis = "…";
  const ellipsisWidth = ctx.measureText(ellipsis).width;
  if (ellipsisWidth > maxWidth) return "";
  const budget = maxWidth - ellipsisWidth;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(text.slice(0, mid)).width <= budget) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return text.slice(0, lo).trimEnd() + ellipsis;
}

// Underline decoration for composition (IME) text.
function renderCompositionUnderline(
  ctx: CanvasRenderingContext2D,
  chars: Char[],
  formats: MarkSpan[],
  lineStartIndex: number,
  lineEndIndex: number,
  compositionStart: number,
  compositionEnd: number,
  x: number,
  y: number,
  textStyle: TextStyle,
  fontFamily: FontFamily,
  fonts: FontStyles,
  fontMetrics: FontMetrics,
  codePadding: number,
  isRTL: boolean,
  _maxWidth: number,
  marks?: MarkRegistry,
) {
  const underlineStart = Math.max(lineStartIndex, compositionStart);
  const underlineEnd = Math.min(lineEndIndex, compositionEnd);

  if (underlineStart >= underlineEnd) return;

  // Composition folded INSIDE an inline-math chip: the composed glyphs are drawn
  // by the chip's tex formula (a `\text{…}` run), not as line text, so a flat
  // text-width underline would land in the wrong place. Underline the composed
  // sub-range through the chip's own selection rects instead, so it hugs the
  // rendered glyphs — matching how a block equation underlines its preview and
  // how the OS marks the string being composed. LTR chips only; an RTL chip falls
  // through to the flat underline below.
  if (!isRTL && marks) {
    const run = replacementRuns(chars, formats, marks).find(
      (r) => r.start <= underlineStart && underlineEnd <= r.end,
    );
    if (run?.replacement.selectionRects) {
      // Clip the run to this line (a chip may have wrapped) and work against its
      // on-this-line fragment, exactly as the interior-caret geometry does.
      const fragStart = Math.max(run.start, lineStartIndex);
      const fragEnd = Math.min(run.end, lineEndIndex);
      if (underlineStart >= fragStart && underlineEnd <= fragEnd) {
        const fragText = run.text.slice(
          fragStart - run.start,
          fragEnd - run.start,
        );
        const rects = run.replacement.selectionRects(
          fragText,
          textStyle.fontSize,
          underlineStart - fragStart,
          underlineEnd - fragStart,
        );
        if (rects.length > 0) {
          const chipLeft = measureTextUpToIndex(
            chars,
            formats,
            lineStartIndex,
            fragStart,
            textStyle.fontSize,
            textStyle.fontWeight,
            fontFamily,
            fonts,
            codePadding,
            marks,
          );
          const baselineY = y + fontMetrics.ascent;
          ctx.save();
          ctx.strokeStyle = textStyle.color;
          ctx.lineWidth = 1.5;
          for (const r of rects) {
            const uy = baselineY + r.bottom + 1;
            ctx.beginPath();
            ctx.moveTo(x + chipLeft + r.x, uy);
            ctx.lineTo(x + chipLeft + r.x + r.width, uy);
            ctx.stroke();
          }
          ctx.restore();
          return;
        }
      }
    }
  }

  const offsetToStart = measureLineWidth(
    chars,
    formats,
    lineStartIndex,
    underlineStart,
    textStyle,
    fontFamily,
    fonts,
    codePadding,
    marks,
  );

  const underlineWidth = measureLineWidth(
    chars,
    formats,
    underlineStart,
    underlineEnd,
    textStyle,
    fontFamily,
    fonts,
    codePadding,
    marks,
  );

  const underlineY = y + fontMetrics.ascent + 2;
  const underlineThickness = 1.5;

  ctx.save();
  ctx.strokeStyle = textStyle.color;
  ctx.lineWidth = underlineThickness;
  ctx.beginPath();

  if (isRTL) {
    const startX = x - offsetToStart;
    ctx.moveTo(startX, underlineY);
    ctx.lineTo(startX - underlineWidth, underlineY);
  } else {
    const startX = x + offsetToStart;
    ctx.moveTo(startX, underlineY);
    ctx.lineTo(startX + underlineWidth, underlineY);
  }

  ctx.stroke();
  ctx.restore();
}

/** The visual style of one text run, folded from all its marks' channels. */
interface ComposedMarkStyle {
  strikethrough: boolean;
  /** Glyph fill color, or undefined to use the block's base text color. */
  color?: string;
  /** Background chip (code). */
  background?: MarkChipStyle;
  /** Underline (link). */
  underline?: MarkUnderlineStyle;
  /** Replacement renderer (inline math): draws its own glyphs, measured atomically. */
  replacement?: MarkReplacement;
}

/**
 * Resolve a run's stored marks through the per-instance {@link MarkRegistry}
 * and fold their style channels into one {@link ComposedMarkStyle}. Replaces the
 * former hardcoded `batch.isCode / isLink / isMath` branches in `renderLine`.
 *
 * Precedence preserves the prior behavior: a chip-bearing mark's color (code)
 * wins over a plain color (link); strike / underline are additive; a
 * replacement mark (math) wins the run and contributes no inline channels.
 * Metric-affecting variants (bold, italic) are not handled here — they're folded
 * into the {@link TextBatch} by the measurement engine so wrap and paint agree.
 */
function composeMarkStyle(
  formats: Mark[],
  marks: MarkRegistry,
  styles: EditorStyles,
): ComposedMarkStyle {
  let strikethrough = false;
  let background: MarkChipStyle | undefined;
  let chipColor: string | undefined;
  let plainColor: string | undefined;
  let underline: MarkUnderlineStyle | undefined;
  let replacement: MarkReplacement | undefined;

  for (const format of formats) {
    const mark = marks.get(format.type);
    if (!mark) continue;
    if (mark.replacement) {
      replacement = mark.replacement;
      continue;
    }
    const s = mark.style({ styles, mark: format });
    if (s.strikethrough) strikethrough = true;
    if (s.underline) underline = s.underline;
    if (s.background) {
      background = s.background;
      if (s.color) chipColor = s.color;
    } else if (s.color) {
      plainColor = s.color;
    }
  }

  return {
    strikethrough,
    background,
    underline,
    color: chipColor ?? plainColor,
    replacement,
  };
}

// Render a single line with CRDT formatting (batched to preserve ligatures).
// Per-mark visual style is resolved through the editor's MarkRegistry, so the
// renderer no longer special-cases individual mark types.
function renderLine(
  ctx: CanvasRenderingContext2D,
  chars: Char[],
  formats: MarkSpan[],
  lineStartIndex: number,
  lineEndIndex: number,
  x: number,
  y: number,
  textStyle: TextStyle,
  fontFamily: FontFamily,
  styles: EditorStyles,
  marks: MarkRegistry,
  isRTL: boolean,
  requestRedraw: () => void,
  hoveredInlineMath: { startIndex: number; endIndex: number } | null = null,
  caretIndex: number | null = null,
  commandEntryActive: boolean = false,
) {
  ctx.direction = isRTL ? "rtl" : "ltr";

  const batches: TextBatch[] = batchChars(
    chars,
    formats,
    lineStartIndex,
    lineEndIndex,
    marks,
  );

  let currentX = x;
  let batchVisibleStart = lineStartIndex;

  for (const batch of batches) {
    const style = composeMarkStyle(batch.formats, marks, styles);
    const effectiveFontWeight = batch.bold ? "bold" : textStyle.fontWeight;
    const fontStyle = batch.italic ? "italic" : "normal";

    ctx.font = `${fontStyle} ${effectiveFontWeight} ${textStyle.fontSize}px ${getFontStack(fontFamily, styles.fonts)}`;
    ctx.textBaseline = "alphabetic";

    const batchVisibleEnd = batchVisibleStart + batch.text.length;

    // Replacement marks (inline math) draw their own glyphs and measure as an
    // atomic unit — they win the run. Fall through to plain text only when the
    // replacement can't render (measure returns null), matching prior behavior.
    if (style.replacement) {
      const hovered =
        hoveredInlineMath !== null &&
        batchVisibleStart >= hoveredInlineMath.startIndex &&
        batchVisibleEnd <= hoveredInlineMath.endIndex;
      // Where the collapsed caret sits relative to this run — lets the
      // replacement adapt to in-progress editing (inline math keeps a command
      // still being typed as literal source). `editing` is the block-level "caret
      // scratch armed here" flag; the replacement only acts on it when the caret
      // is actually in its run (caretOffset set). measure AND paint derive their
      // geometry from the same `edit`, so reserved width matches drawn glyphs.
      const caretOffset =
        caretIndex !== null &&
        caretIndex >= batchVisibleStart &&
        caretIndex <= batchVisibleEnd
          ? caretIndex - batchVisibleStart
          : undefined;
      const edit: MarkReplacementEdit = {
        caretOffset,
        editing: commandEntryActive,
      };
      const dims = style.replacement.measure(
        batch.text,
        textStyle.fontSize,
        edit,
      );
      if (dims) {
        style.replacement.paint({
          ctx,
          text: batch.text,
          x: currentX,
          y,
          fontSize: textStyle.fontSize,
          isRTL,
          hovered,
          dims,
          styles,
          edit,
          requestRedraw,
        });
        currentX += isRTL ? -dims.width : dims.width;
        batchVisibleStart = batchVisibleEnd;
        continue;
      }
    }

    const textWidth = ctx.measureText(batch.text).width;
    const visualX = currentX;

    // Background chip (code).
    if (style.background) {
      const chip = style.background;
      ctx.save();
      ctx.fillStyle = chip.color;
      const rectX = isRTL
        ? visualX - textWidth - chip.padding
        : visualX - chip.padding;
      const rectY = y - textStyle.fontSize - chip.padding;
      const rectWidth = textWidth + chip.padding * 2;
      const rectHeight = textStyle.fontSize * textStyle.lineHeight;
      ctx.beginPath();
      ctx.roundRect(rectX, rectY, rectWidth, rectHeight, chip.borderRadius);
      ctx.fill();
      ctx.restore();
    }

    ctx.fillStyle = style.color ?? textStyle.color;
    ctx.fillText(batch.text, visualX, y);

    // Underline (link).
    if (style.underline) {
      const u = style.underline;
      ctx.save();
      ctx.strokeStyle = u.color;
      ctx.lineWidth = u.thickness;
      ctx.beginPath();
      if (isRTL) {
        ctx.moveTo(visualX - textWidth, y + textStyle.fontSize * 0.1);
        ctx.lineTo(visualX, y + textStyle.fontSize * 0.1);
      } else {
        ctx.moveTo(visualX, y + textStyle.fontSize * 0.1);
        ctx.lineTo(visualX + textWidth, y + textStyle.fontSize * 0.1);
      }
      ctx.stroke();
      ctx.restore();
    }

    // Strike-through — uses the resolved fill color, matching prior behavior.
    if (style.strikethrough) {
      ctx.save();
      ctx.strokeStyle = ctx.fillStyle;
      ctx.lineWidth = Math.max(1, textStyle.fontSize / 16);
      ctx.beginPath();
      if (isRTL) {
        ctx.moveTo(visualX - textWidth, y - textStyle.fontSize * 0.3);
        ctx.lineTo(visualX, y - textStyle.fontSize * 0.3);
      } else {
        ctx.moveTo(visualX, y - textStyle.fontSize * 0.3);
        ctx.lineTo(visualX + textWidth, y - textStyle.fontSize * 0.3);
      }
      ctx.stroke();
      ctx.restore();
    }

    if (isRTL) {
      currentX -= textWidth;
    } else {
      currentX += textWidth;
    }
    batchVisibleStart = batchVisibleEnd;
  }

  ctx.direction = "ltr";
}

// ---------------------------------------------------------------------------
// Selection rectangles (moved verbatim from renderer.renderSelectionCore)
// ---------------------------------------------------------------------------

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Compute the highlight rectangles for a selection within one text block.
 * Ported verbatim from renderSelectionCore — returns rects instead of drawing,
 * so both the painter and the hit-test (isPointWithinSelectionRects) share it.
 */
function computeSelectionRects(
  layout: TextNodeLayout,
  baseX: number,
  blockTopY: number,
  maxWidth: number,
  selection: { anchor: Position; focus: Position; isForward: boolean },
  blockIndex: number,
  // When true, close the vertical gaps in the selection so it reads as one
  // connected shape: each line still hugs its own text width (ragged edges
  // where line widths differ), but a block the selection passes through fills
  // its own top/bottom box (its inter-block spacing) so adjacent selected
  // blocks meet instead of leaving an untappable gap between them. The local
  // selection uses this; tight range decorations (find highlights, remote
  // carets) leave it false so they hug the matched glyphs. See `selectionRects`.
  continuous = false,
  // When true, the rects feed the point-in-selection hit-test
  // (`isPointWithinSelectionRects`), not the painter. A selection covering a whole
  // inline-math chip then reports the chip's full atomic box as touchable, so a tap
  // anywhere on the selected chip — including its inflated padding, which the
  // glyph-hugging rows don't cover — counts as touching the selection (and opens
  // the context menu instead of collapsing). Painting leaves this false so a
  // selected sub-part of a formula still lights up just that part.
  hitTest = false,
): Rect[] {
  const start = selection.isForward ? selection.anchor : selection.focus;
  const end = selection.isForward ? selection.focus : selection.anchor;

  const {
    isRTL,
    textStyle,
    fontFamily,
    fonts,
    marks,
    codePadding,
    chars,
    formats,
    insetY,
    height: blockHeight,
  } = layout;

  // Whether the selection arrives from / departs into a neighbouring block.
  // Used to fill this block's top/bottom box so consecutive blocks form one
  // gapless ribbon (block boxes are laid out contiguously, so each block
  // filling its own half closes the inter-block gap).
  const enteredFromAbove = start.blockIndex < blockIndex;
  const exitsBelow = end.blockIndex > blockIndex;
  // `blockTopY` is the content top (caller already added `insetY`); recover the
  // block's box edges from the layout's own metrics.
  const blockTopEdge = blockTopY - insetY;
  const blockBottomEdge = blockTopEdge + blockHeight;

  const rects: Rect[] = [];

  if (
    !(
      (start.blockIndex === blockIndex && end.blockIndex === blockIndex) ||
      (start.blockIndex <= blockIndex && end.blockIndex >= blockIndex)
    )
  ) {
    return rects;
  }

  const contentLength = getVisibleTextFromChars(chars).length;

  // Empty block: a small caret-width sliver. In a continuous selection it keeps
  // that narrow width (an empty line shows no full-width fill) but extends to
  // this block's box edges so it connects to the selected blocks above/below.
  if (contentLength === 0 && layout.lines.length === 1) {
    const emptyBlockHeight = textStyle.fontSize * textStyle.lineHeight;
    const minSelectionWidth = textStyle.fontSize * 0.5;
    const top = continuous && enteredFromAbove ? blockTopEdge : blockTopY;
    const bottom =
      continuous && exitsBelow ? blockBottomEdge : blockTopY + emptyBlockHeight;
    rects.push({
      x: baseX,
      y: top,
      width: minSelectionWidth,
      height: bottom - top,
    });
    return rects;
  }

  // Selection confined ENTIRELY within one replacement chip that paints its own
  // per-row selection rects (inline math): highlight the selected glyphs' own
  // rows instead of filling the chip's full (inflated) line box — so selecting a
  // fraction's denominator lights up just the denominator, not the whole formula.
  // A selection that also covers surrounding text falls through to the normal
  // line-box fill below. LTR only; RTL chips fall through, matching the caret.
  if (
    !isRTL &&
    marks &&
    start.blockIndex === blockIndex &&
    end.blockIndex === blockIndex &&
    end.textIndex > start.textIndex
  ) {
    const confiningRun = replacementRuns(chars, formats, marks).find(
      (r) =>
        r.replacement.selectionRects &&
        start.textIndex >= r.start &&
        end.textIndex <= r.end,
    );
    // Hit-testing a fully-selected chip (endpoints on the chip's atomic
    // boundaries): skip the tight per-glyph rows so the point-in-selection test
    // falls through to the line-box fill below, which spans the chip's full
    // advance at full line height — a tap anywhere on the selected chip
    // (including its inflated padding, which the glyph rows don't cover) then
    // registers as touching the selection. Painting, and partial sub-range
    // selections, keep the tight rows so a selected fraction lights up just it.
    const skipTightChipRows =
      confiningRun != null &&
      hitTest &&
      start.textIndex <= confiningRun.start &&
      end.textIndex >= confiningRun.end;
    if (confiningRun && !skipTightChipRows) {
      const chipRects: Rect[] = [];
      for (const line of layout.lines) {
        // Selection ∩ line, then clip to the chip's fragment on this line (the
        // chip may have wrapped across lines — work per fragment, like caretRect).
        const selStart = Math.max(start.textIndex, line.startIndex);
        const selEnd = Math.min(end.textIndex, line.endIndex);
        if (selEnd <= selStart) continue;
        const fragStart = Math.max(confiningRun.start, line.startIndex);
        const fragEnd = Math.min(confiningRun.end, line.endIndex);
        const fragText = confiningRun.text.slice(
          fragStart - confiningRun.start,
          fragEnd - confiningRun.start,
        );
        const rowRects = confiningRun.replacement.selectionRects?.(
          fragText,
          textStyle.fontSize,
          selStart - fragStart,
          selEnd - fragStart,
          { caretOffset: selStart - fragStart, editing: false },
        );
        if (!rowRects || rowRects.length === 0) continue;
        const chipLeft = measureLineWidth(
          chars,
          formats,
          line.startIndex,
          fragStart,
          textStyle,
          fontFamily,
          fonts,
          codePadding,
          marks,
          layout.replCharWidths,
        );
        const baselineY =
          blockTopY +
          line.y +
          (line.baselineOffset ?? layout.fontMetrics.ascent);
        for (const rr of rowRects) {
          chipRects.push({
            x: baseX + chipLeft + rr.x,
            y: baselineY + rr.top,
            width: rr.width,
            height: rr.bottom - rr.top,
          });
        }
      }
      if (chipRects.length > 0) return chipRects;
    }
  }

  // LTR distance from a line's start to a selection boundary `index`, descending
  // INTO an inline replacement chip when the boundary falls strictly inside it —
  // mirroring `caretRect`, so a selection edge inside a chip lands at the same
  // glyph-accurate x the caret would instead of snapping to the chip's atomic
  // edge (the cause of inline-math selections rendering with the wrong width).
  // RTL chips fall through to the atomic measure, same as the caret.
  const boundaryWidth = (
    line: (typeof layout.lines)[number],
    index: number,
  ): number => {
    if (!isRTL && marks) {
      const run = enclosingReplacementRun(
        replacementRuns(chars, formats, marks),
        index,
      );
      // Descend into the chip's FRAGMENT on this line (run clipped to the line),
      // matching the reflowed slice — see `caretRect`.
      const fragStart = run ? Math.max(run.start, line.startIndex) : 0;
      const fragEnd = run ? Math.min(run.end, line.endIndex) : 0;
      const fragText = run
        ? run.text.slice(fragStart - run.start, fragEnd - run.start)
        : "";
      const localOffset = run ? index - fragStart : 0;
      const replCaret = run?.replacement.caretRect?.(
        fragText,
        textStyle.fontSize,
        localOffset,
        {
          caretOffset: localOffset,
          editing: false,
        },
      );
      if (run && replCaret) {
        const chipLeft = measureLineWidth(
          chars,
          formats,
          line.startIndex,
          fragStart,
          textStyle,
          fontFamily,
          fonts,
          codePadding,
          marks,
          layout.replCharWidths,
        );
        return chipLeft + replCaret.x;
      }
    }
    return measureLineWidth(
      chars,
      formats,
      line.startIndex,
      index,
      textStyle,
      fontFamily,
      fonts,
      codePadding,
      marks,
      layout.replCharWidths,
    );
  };

  // Plain line-start-to-index width (no inline-chip descent), block indices.
  const plainWidth = (fromIndex: number, toIndex: number): number =>
    measureLineWidth(
      chars,
      formats,
      fromIndex,
      toIndex,
      textStyle,
      fontFamily,
      fonts,
      codePadding,
      marks,
      layout.replCharWidths,
    );

  layout.lines.forEach((line) => {
    const lineY = blockTopY + line.y;

    // The logical block-index range of THIS line that the selection covers.
    // A selection that starts/ends outside this block contributes the whole
    // line edge on that side (multi-block ribbon).
    const startsHere = start.blockIndex === blockIndex;
    const endsHere = end.blockIndex === blockIndex;
    const lineSelStart = startsHere
      ? Math.max(line.startIndex, start.textIndex)
      : line.startIndex;
    const lineSelEnd = endsHere
      ? Math.min(line.endIndex, end.textIndex)
      : line.endIndex;
    if (lineSelStart >= lineSelEnd) return;

    // Resolve the line's bidi structure. A line whose only run is at the base
    // level needs no reordering — take the fast monotonic path, which also
    // keeps the inline-math chip glyph-descent (`boundaryWidth`) behaviour.
    const { runs, visual } = analyzeLineBidi(line.text, isRTL ? "rtl" : "ltr");
    const baseLevel = isRTL ? 1 : 0;
    const isPureLine =
      runs.length === 0 || (runs.length === 1 && runs[0].level === baseLevel);

    if (isPureLine) {
      let selectionStartX = baseX;
      let selectionEndX = baseX + line.width;
      if (isRTL) {
        selectionEndX =
          baseX + maxWidth - plainWidth(line.startIndex, lineSelStart);
        selectionStartX =
          baseX + maxWidth - plainWidth(line.startIndex, lineSelEnd);
      } else {
        if (lineSelStart > line.startIndex) {
          selectionStartX = baseX + boundaryWidth(line, lineSelStart);
        }
        if (lineSelEnd < line.endIndex) {
          selectionEndX = baseX + boundaryWidth(line, lineSelEnd);
        }
      }
      rects.push({
        x: selectionStartX,
        y: lineY,
        width: selectionEndX - selectionStartX,
        height: line.height,
      });
      return;
    }

    // Mixed-direction (bidi) line: lay runs out in visual order, then emit one
    // rect per selected run — a logical range that spans an embedded run of the
    // opposite direction is not visually contiguous, so a single span would
    // land on the wrong glyphs.
    let totalWidth = 0;
    for (const r of runs) {
      totalWidth += plainWidth(
        line.startIndex + r.start,
        line.startIndex + r.end,
      );
    }
    // LTR lines are left-aligned (origin 0); RTL lines are right-aligned so the
    // last visual run ends flush at maxWidth.
    const origin = isRTL ? maxWidth - totalWidth : 0;
    const runLeft = new Map<(typeof runs)[number], number>();
    let cursorX = origin;
    for (const r of visual) {
      runLeft.set(r, cursorX);
      cursorX += plainWidth(line.startIndex + r.start, line.startIndex + r.end);
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
        xLeft = rx + plainWidth(runStartIdx, selA);
        xRight = rx + plainWidth(runStartIdx, selB);
      } else {
        // RTL run: reversed — the visually-left edge is the logically-later end.
        xLeft = rx + plainWidth(selB, runEndIdx);
        xRight = rx + plainWidth(selA, runEndIdx);
      }
      rects.push({
        x: baseX + xLeft,
        y: lineY,
        width: xRight - xLeft,
        height: line.height,
      });
    }
  });

  // Vertical box fill: extend the top/bottom rect into this block's own
  // inter-block spacing where the selection crosses a block boundary, so
  // adjacent selected blocks meet with no gap. Lines within a block are already
  // contiguous (each rect's height is its full line box).
  if (continuous && rects.length > 0) {
    if (enteredFromAbove) {
      const first = rects[0];
      first.height = first.y + first.height - blockTopEdge;
      first.y = blockTopEdge;
    }
    if (exitsBelow) {
      const last = rects[rects.length - 1];
      last.height = blockBottomEdge - last.y;
    }
  }

  return rects;
}

// ---------------------------------------------------------------------------
// Serialization tables (folded in from the former textCodec)
// ---------------------------------------------------------------------------

const MARKDOWN_PREFIX: Record<string, string> = {
  heading1: "# ",
  heading2: "## ",
  heading3: "### ",
  paragraph: "",
};

const HTML_TAG_NAME: Record<string, string> = {
  heading1: "h1",
  heading2: "h2",
  heading3: "h3",
  paragraph: "p",
};

function headingLevel(ctx: InputCtx): number {
  if (ctx.match(HEADING_1)) return 1;
  if (ctx.match(HEADING_2)) return 2;
  if (ctx.match(HEADING_3)) return 3;
  return 0;
}

// ---------------------------------------------------------------------------
// TextNode
// ---------------------------------------------------------------------------

export class TextNode extends Node<TextualBlock> {
  // Representative type; the view is registered under every `types` key. Typed
  // wide (not the "paragraph" literal) so ListNode can override both.
  readonly type: TextualBlock["type"] = "paragraph";
  readonly types: readonly string[] = TEXT_BLOCK_TYPES;

  /**
   * Cheap pre-layout height. The estimate is deliberately owned by the text
   * node so custom text families inherit it and can override the same geometry
   * hooks (`textStyle`, `leadingInset`, `contentInsetY`) as exact layout.
   */
  estimateHeight(c: NodeLayoutCtx): number {
    const block = c.block as TextualBlock;
    const textStyle = mergeBlockStyle(
      this.textStyle(c.styles, block.type),
      block.style,
    );
    const layoutMaxWidth = this.estimateLayoutMaxWidth(
      block,
      c.maxWidth,
      c.styles,
    );
    const { indentOffset, markerWidth } = this.leadingInset(block, c.styles);
    const usableWidth = Math.max(
      1,
      layoutMaxWidth - indentOffset - markerWidth,
    );
    const averageGlyphWidth = textStyle.fontSize * 0.55;
    const charsPerLine = Math.max(
      1,
      Math.floor(usableWidth / averageGlyphWidth),
    );
    const text = getVisibleTextFromRuns(block.charRuns);
    const hardLines = text.split("\n");
    let estimatedLines = 0;
    for (const line of hardLines) {
      estimatedLines += Math.max(1, Math.ceil(line.length / charsPerLine));
    }
    return (
      this.contentInsetY(block, c.styles) +
      estimatedLines * textStyle.fontSize * textStyle.lineHeight +
      this.contentPaddingBottom(block, c.styles, textStyle)
    );
  }

  /**
   * Width handed to the shared text layout before leading insets are removed.
   * CodeNode overrides this because its right-side container padding is applied
   * before TextNode's left-side leading inset.
   */
  protected estimateLayoutMaxWidth(
    _block: TextualBlock,
    maxWidth: number,
    _styles: EditorStyles,
  ): number {
    return maxWidth;
  }

  /**
   * The canonical text layout. Plain block content (no composition) — that is
   * what the height/caret/hit-test/selection passes use.
   */
  layout(c: NodeLayoutCtx): TextNodeLayout {
    // Memoized (see memoizeNodeLayout): the same unchanged block is laid out many
    // times per frame and per pointer move — height pass, paint, hit-testing,
    // caret/selection — and each layout does ~O(n²) text measurement for a large
    // block. Composition (IME) goes through computeLayout directly with a content
    // override, so it never reads or pollutes this canonical cache.
    return memoizeNodeLayout(c.block, c.maxWidth, () =>
      this.computeLayout(
        c.block as TextualBlock,
        c.maxWidth,
        c.styles,
        undefined,
        c.marks,
      ),
    );
  }

  /**
   * Shared layout computation. `content` overrides the characters (used by the
   * paint pass to fold in IME composition). RTL is always derived from the
   * persisted runs, matching the previous render/caret/hit-test behavior.
   */
  computeLayout(
    block: TextualBlock,
    maxWidth: number,
    styles: EditorStyles,
    content?: {
      chars: Char[];
      formats: MarkSpan[];
      compositionRange: { start: number; end: number } | null;
    },
    marks?: MarkRegistry,
  ): TextNodeLayout {
    const textStyle = mergeBlockStyle(
      this.textStyle(styles, block.type),
      block.style,
    );
    const fontFamily = this.resolveFontFamily(styles);
    const fonts = styles.fonts;
    const codePadding = styles.textFormats.code.padding;

    const isRTL =
      getTextDirection(getVisibleTextFromRuns(block.charRuns)) === "rtl";

    // Leading inset (list indent + marker gutter) is a per-type hook: zero for
    // headings/paragraph, computed from `indent` for list blocks. Baking it into
    // the layout here means every downstream pass (caret, selection, hit-test)
    // gets correct geometry without re-checking the block type.
    const { indentOffset, markerWidth } = this.leadingInset(block, styles);
    const adjustedMaxWidth = maxWidth - indentOffset - markerWidth;
    const insetY = this.contentInsetY(block, styles);

    const chars = content?.chars ?? charRunsToChars(block.charRuns);
    const formats = content?.formats ?? block.formats;
    const compositionRange = content?.compositionRange ?? null;

    const wrapped = this.wrapLines(
      chars,
      formats,
      adjustedMaxWidth,
      textStyle,
      fontFamily,
      fonts,
      codePadding,
      compositionRange,
      marks,
      // RTL lines keep an inline-math chip atomic (no operator split), matching
      // the RTL caret/selection/paint paths, which treat a chip atomically.
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
    const replacements = marks ? replacementRuns(chars, formats, marks) : [];

    // Build line boxes with the exact startIndex/endIndex accounting (including
    // consumed wrap spaces) used by every downstream pass. x/y are relative.
    // Line boxes carry x/y relative to the block content origin; absolute
    // positioning is added by each consumer (it differs between the scroll-space
    // paint pass and the document-space caret pass), so x stays 0 here.
    const lines: RenderedLine[] = [];
    // Per-line replacement-chip fragment advances (see TextNodeLayout). Filled as
    // each line resolves its chip fragments, then threaded into every width
    // measurement so a chip that wrapped across lines is measured per slice.
    const replCharWidths = new Map<number, number>();
    let textIndex = 0;
    let lineY = 0;
    for (let i = 0; i < wrapped.length; i++) {
      const wl = wrapped[i];
      const lineStartIndex = textIndex;
      const lineEndIndex = textIndex + wl.text.length;
      let ascent = textAscent;
      let descent = textDescent;
      // Replacement fragments on THIS line — a chip clipped to the line. Record
      // each fragment's first-char advance (rest → 0) so measurement attributes
      // the slice its own width, and grow the line box around the chip. A chip
      // that wrapped contributes one fragment per line it spans; an unwrapped chip
      // is its whole self on one line (fragment == run, identical to before).
      for (const run of replacements) {
        const fragStart = Math.max(run.start, lineStartIndex);
        const fragEnd = Math.min(run.end, lineEndIndex);
        if (fragEnd <= fragStart) continue;
        const fragText = run.text.slice(
          fragStart - run.start,
          fragEnd - run.start,
        );
        const dims = run.replacement.measure(fragText, textStyle.fontSize);
        if (!dims) continue;
        replCharWidths.set(fragStart, dims.width);
        for (let v = fragStart + 1; v < fragEnd; v++) replCharWidths.set(v, 0);
        ascent = Math.max(ascent, dims.height - dims.depthBelowBaseline);
        descent = Math.max(descent, dims.depthBelowBaseline);
      }
      const width = measureLineWidth(
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
        width,
        height: actualLineHeight,
        baselineOffset: ascent,
        startIndex: lineStartIndex,
        endIndex: lineEndIndex,
      });
      lineY += actualLineHeight;
      textIndex += wl.text.length;
      if (wl.consumedSpace) textIndex += 1;
    }

    const height =
      insetY + lineY + this.contentPaddingBottom(block, styles, textStyle);

    return {
      height,
      lines,
      maxWidth,
      isRTL,
      textStyle,
      fontFamily,
      fonts,
      marks,
      codePadding,
      fontMetrics,
      lineHeight,
      indentOffset,
      markerWidth,
      insetY,
      adjustedMaxWidth,
      chars,
      formats,
      compositionRange,
      wrapped,
      replCharWidths,
    };
  }

  /** Base text x (left edge of the text area) given the block's left origin. */
  private baseX(layout: TextNodeLayout, originX: number): number {
    if (layout.indentOffset === 0 && layout.markerWidth === 0) return originX;
    return layout.isRTL
      ? originX + layout.indentOffset
      : originX + layout.indentOffset + layout.markerWidth;
  }

  /**
   * Caret screen rectangle for a text index. `originX` is the block's left edge
   * (canvas paddingLeft), `blockTopY` the block's top in the caller's space.
   * Ported verbatim from getCursorDocumentCoords.
   *
   * `exact: true` means `y`/`height` are the *precise* caret box (a caret inside
   * a math chip, sized to its row) and must be drawn as-is. Without it `height`
   * is the line height and the renderer draws a text-height caret from `y` (the
   * line top) — the normal text caret.
   *
   * `state`/`blockId` are optional and only used to detect an in-progress edit
   * (a replacement mark's caret-anchored scratch) at this caret, so the run's
   * caret tracks the literal source; callers without them (e.g. during
   * composition) just get the resolved caret.
   */
  caretRect(
    layout: TextNodeLayout,
    textIndex: number,
    originX: number,
    blockTopY: number,
    state?: EditorState,
    blockId?: string,
    // Which end of a selection this caret is (see MathNode.caretRect). Plain text
    // maps an offset to a single x, so there is no tie to break here — the param
    // exists for the shared signature and math's override consumes it.
    _edge?: "start" | "end",
  ): { x: number; y: number; height: number; exact?: boolean } {
    const editing =
      state != null && blockId != null
        ? isCaretScratchActive(state, blockId, textIndex)
        : false;
    const {
      isRTL,
      textStyle,
      fontFamily,
      fonts,
      codePadding,
      lineHeight,
      chars,
      formats,
      adjustedMaxWidth,
      insetY,
    } = layout;
    const baseX = this.baseX(layout, originX);
    const textAscent = Number.isFinite(layout.fontMetrics.ascent)
      ? layout.fontMetrics.ascent
      : textStyle.fontSize * 0.8;

    for (const line of layout.lines) {
      if (textIndex >= line.startIndex && textIndex <= line.endIndex) {
        const currentY = blockTopY + insetY + line.y;
        // Caret *inside* a replacement run (e.g. an inline-math chip): the run
        // measures as one atomic advance (interior indices all collapse to its
        // right edge), so place AND size the caret by asking the replacement
        // instead. Width up to the run's left edge + the glyph-accurate offset/
        // extent from the replacement. LTR only for now; RTL runs fall through to
        // the boundary measure below. Needs the registry (on the layout) to find runs.
        const run =
          isRTL || !layout.marks
            ? null
            : enclosingReplacementRun(
                replacementRuns(chars, formats, layout.marks),
                textIndex,
              );
        // A chip may have wrapped across lines: work against its FRAGMENT on the
        // line the caret sits on (run clipped to the line), so the caret maps to
        // the reflowed slice that line paints, not the whole formula. For an
        // unwrapped chip the fragment IS the whole run.
        const fragStart = run ? Math.max(run.start, line.startIndex) : 0;
        const fragEnd = run ? Math.min(run.end, line.endIndex) : 0;
        const fragText = run
          ? run.text.slice(fragStart - run.start, fragEnd - run.start)
          : "";
        // While an edit is in progress inside this run, read the caret off the
        // same `edit` the run paints with (a command kept literal, `\in` not ∈)
        // so it tracks the source the user is entering.
        const localOffset = run ? textIndex - fragStart : 0;
        const edit: MarkReplacementEdit = { caretOffset: localOffset, editing };
        const replCaret =
          run &&
          run.replacement.caretRect?.(
            fragText,
            textStyle.fontSize,
            localOffset,
            edit,
          );
        if (run && replCaret) {
          const chipLeft = measureTextUpToIndex(
            chars,
            formats,
            line.startIndex,
            fragStart,
            textStyle.fontSize,
            textStyle.fontWeight,
            fontFamily,
            fonts,
            codePadding,
            layout.marks,
            layout.replCharWidths,
          );
          // Anchor the replacement's caret extent at the run baseline so the
          // caret hugs the row it sits on (short in a subscript, tall across a
          // numerator) rather than spanning the whole text line. A small pad
          // keeps it from going razor-thin on short glyphs.
          const baselineY =
            currentY + (line.baselineOffset ?? layout.fontMetrics.ascent);
          const pad = textStyle.fontSize * 0.08;
          return {
            x: baseX + chipLeft + replCaret.x,
            y: baselineY + replCaret.top - pad,
            height: replCaret.bottom - replCaret.top + pad * 2,
            exact: true,
          };
        }

        const caretY =
          currentY + (line.baselineOffset ?? textAscent) - textAscent;

        // Mixed-direction (bidi) line: place the caret through the visual run
        // order so it sits at the right glyph boundary in an embedded run.
        const width = (from: number, to: number): number =>
          measureTextUpToIndex(
            chars,
            formats,
            from,
            to,
            textStyle.fontSize,
            textStyle.fontWeight,
            fontFamily,
            fonts,
            codePadding,
            layout.marks,
            layout.replCharWidths,
          );
        const { runs: cRuns, visual: cVisual } = analyzeLineBidi(
          line.text,
          isRTL ? "rtl" : "ltr",
        );
        const cBaseLevel = isRTL ? 1 : 0;
        const pureCaretLine =
          cRuns.length === 0 ||
          (cRuns.length === 1 && cRuns[0].level === cBaseLevel);
        if (!pureCaretLine) {
          const lineLen = line.text.length;
          const i0 = Math.max(
            0,
            Math.min(lineLen, textIndex - line.startIndex),
          );
          let totalW = 0;
          for (const r of cRuns) {
            totalW += width(line.startIndex + r.start, line.startIndex + r.end);
          }
          const origin = isRTL ? adjustedMaxWidth - totalW : 0;
          const runLeftX = new Map<(typeof cRuns)[number], number>();
          let cx = origin;
          for (const r of cVisual) {
            runLeftX.set(r, cx);
            cx += width(line.startIndex + r.start, line.startIndex + r.end);
          }
          // The run owning this boundary: the one that contains i0 as an
          // interior/left edge, or the last run when the caret is at line end.
          let owner = cRuns[cRuns.length - 1];
          for (const r of cRuns) {
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
          return {
            x: baseX + l + localX,
            y: caretY,
            height: line.height,
          };
        }

        const widthFromStart = width(line.startIndex, textIndex);
        return {
          x: isRTL
            ? baseX + adjustedMaxWidth - widthFromStart
            : baseX + widthFromStart,
          y: caretY,
          height: line.height,
        };
      }
    }

    // Empty block or caret at the very end.
    const lastLine = layout.lines[layout.lines.length - 1];
    const currentY = lastLine
      ? blockTopY + insetY + lastLine.y
      : blockTopY + insetY;
    return {
      x: isRTL ? baseX + adjustedMaxWidth : baseX,
      y: lastLine
        ? currentY + (lastLine.baselineOffset ?? textAscent) - textAscent
        : currentY,
      height: lastLine?.height ?? lineHeight,
    };
  }

  /**
   * Click → caret text index within the block. `x`/`y` are absolute in the
   * caller's coordinate space; `blockTopY` the block's top; `originX` the left
   * edge (canvas paddingLeft). A click can descend into a replacement run (e.g.
   * an inline-math chip) via its `hitTest`, using the layout's mark registry.
   * Ported from getPositionWithinBlock + Line.
   */
  /**
   * The word/token RANGE a double-tap at a point selects, resolved from the POINT
   * rather than a caret offset. Plain prose has no point-specific word model — its
   * offset-based word selection is fine — but an inline-math chip does: a point
   * lands the selection on the exact atom/construct under the finger, and for an
   * ATOMIC command chip (`\det`, `\sin`) it is the ONLY way to select it at all
   * (the command has caret stops only at its edges, so a resolved offset lands on a
   * chip boundary that the offset word-select can't see). We dispatch to the
   * replacement's own {@link MarkReplacement.wordRangeFromPoint} and re-base its
   * run-local range onto block indices; a block with no such chip under the point
   * returns null and the caller falls back to the offset path. Only an UNWRAPPED
   * chip on a non-bidi line is resolved by point — a wrapped fragment or a chip on
   * a mixed-direction line falls back too. See {@link getWordRangeFromViewport}.
   */
  wordRangeFromPoint(
    layout: TextNodeLayout,
    x: number,
    y: number,
    originX: number,
    blockTopY: number,
  ): { start: number; end: number } | null {
    if (!layout.marks) return null;
    const runs = replacementRuns(
      layout.chars,
      layout.formats,
      layout.marks,
    ).filter((r) => r.replacement.wordRangeFromPoint);
    if (runs.length === 0) return null;

    const {
      isRTL,
      textStyle,
      fontFamily,
      fonts,
      chars,
      formats,
      adjustedMaxWidth,
    } = layout;
    const baseX = this.baseX(layout, originX);
    const relativeX = x - baseX;

    for (const line of layout.lines) {
      const lineTopY = blockTopY + layout.insetY + line.y;
      if (y < lineTopY || y >= lineTopY + line.height) continue;

      // Point resolution is handled only for a pure (non-bidi) line — a chip
      // reordered inside a mixed-direction line falls back to the offset path.
      const { runs: bidiRuns } = analyzeLineBidi(
        line.text,
        isRTL ? "rtl" : "ltr",
      );
      const baseLvl = isRTL ? 1 : 0;
      const pureLine =
        bidiRuns.length === 0 ||
        (bidiRuns.length === 1 && bidiRuns[0].level === baseLvl);
      if (!pureLine) return null;

      const lineStartIndex = line.startIndex;
      const lineEndIndex = line.endIndex;
      const positionWidths = measureCRDTPositions(
        chars,
        formats,
        lineStartIndex,
        lineEndIndex,
        textStyle.fontSize,
        textStyle.fontWeight,
        fontFamily,
        fonts,
        layout.marks,
        layout.replCharWidths,
      );
      const lineWidth = positionWidths[positionWidths.length - 1];
      const origin = isRTL ? adjustedMaxWidth - lineWidth : 0;
      const baselineY =
        lineTopY + (line.baselineOffset ?? layout.fontMetrics.ascent);

      for (const run of runs) {
        // Only a whole, unwrapped chip on this line: the replacement resolves the
        // point against its ENTIRE LaTeX, so a fragment clipped by a wrap would
        // mis-map the coordinates.
        if (run.start < lineStartIndex || run.end > lineEndIndex) continue;
        const startLocal = run.start - lineStartIndex;
        if (startLocal + 1 >= positionWidths.length) continue;
        // The chip is one advance; its two boundary widths give its visual edges
        // (RTL grows the visual x from the right).
        const eA = isRTL
          ? origin + (lineWidth - positionWidths[startLocal])
          : origin + positionWidths[startLocal];
        const eB = isRTL
          ? origin + (lineWidth - positionWidths[startLocal + 1])
          : origin + positionWidths[startLocal + 1];
        const chipLeftX = Math.min(eA, eB);
        const chipRightX = Math.max(eA, eB);
        if (relativeX < chipLeftX || relativeX > chipRightX) continue;
        // The formula is always laid out LTR, so run-local x is the distance from
        // its visual left edge; run-local y is the click below the baseline.
        const local = run.replacement.wordRangeFromPoint!(
          run.text,
          textStyle.fontSize,
          relativeX - chipLeftX,
          y - baselineY,
        );
        if (!local) return null;
        return { start: run.start + local.start, end: run.start + local.end };
      }
      return null;
    }
    return null;
  }

  positionFromPoint(
    _block: TextualBlock,
    layout: TextNodeLayout,
    x: number,
    y: number,
    originX: number,
    blockTopY: number,
    // Finger-drag (magnifier) resolution — inside an inline-math chip, follow the
    // finger to its nearest caret stop through the chip's stacked rows (a
    // fraction's numerator/denominator) with row hysteresis, rather than the tap
    // path's exact per-row descent. A precise tap leaves this off.
    drag = false,
    // The caret's CURRENT block-text index, the hysteresis anchor for drag mode
    // (null when there is no current caret in this block).
    prevIndex: number | null = null,
  ): number {
    const baseX = this.baseX(layout, originX);

    for (const line of layout.lines) {
      const currentLineY = blockTopY + layout.insetY + line.y;
      const lineBottom = currentLineY + line.height;
      if (y >= currentLineY && y < lineBottom) {
        return this.positionWithinLine(
          layout,
          x,
          y,
          currentLineY,
          line,
          baseX,
          drag,
          prevIndex,
        );
      }
    }

    // Below the last line (padding area): use the last line.
    if (layout.lines.length > 0) {
      const last = layout.lines[layout.lines.length - 1];
      return this.positionWithinLine(
        layout,
        x,
        y,
        blockTopY + layout.insetY + last.y,
        last,
        baseX,
        drag,
        prevIndex,
      );
    }

    return 0;
  }

  // Ported from getPositionWithinLine. A click within a replacement run (e.g. an
  // inline-math chip) descends into the rendered content via the replacement's
  // hitTest (boundary snap kept for clicks outside a run). `clickY`/`lineTopY`
  // give the run-local vertical coordinate the hit-test needs to pick the right
  // row (a fraction's numerator vs denominator).
  private positionWithinLine(
    layout: TextNodeLayout,
    x: number,
    clickY: number,
    lineTopY: number,
    line: RenderedLine,
    baseX: number,
    drag = false,
    prevIndex: number | null = null,
  ): number {
    const {
      isRTL,
      textStyle,
      fontFamily,
      fonts,
      chars,
      formats,
      adjustedMaxWidth,
    } = layout;
    const lineStartIndex = line.startIndex;
    const lineEndIndex = line.endIndex;
    const lineText = line.text;
    const relativeX = x - baseX;

    const positionWidths = measureCRDTPositions(
      chars,
      formats,
      lineStartIndex,
      lineEndIndex,
      textStyle.fontSize,
      textStyle.fontWeight,
      fontFamily,
      fonts,
      layout.marks,
      layout.replCharWidths,
    );

    const lineWidth = positionWidths[positionWidths.length - 1];

    // Bidi (mixed-direction) line: map the click through the visual run order.
    // `positionWidths[i]` is the cumulative logical width to line-relative index
    // i, so run/segment widths come straight from it (no extra measurement).
    const { runs: bidiRunsList, visual: bidiVisual } = analyzeLineBidi(
      lineText,
      isRTL ? "rtl" : "ltr",
    );
    const baseLvl = isRTL ? 1 : 0;
    const pureHitLine =
      bidiRunsList.length === 0 ||
      (bidiRunsList.length === 1 && bidiRunsList[0].level === baseLvl);
    if (!pureHitLine) {
      const origin = isRTL ? adjustedMaxWidth - lineWidth : 0;
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

      // Inline-math chips on a bidi line: descend into the chip's rendered
      // formula exactly as the monotonic path below does, but locate the chip by
      // its VISUAL x — its run is reordered away from its logical position. All
      // of a chip's chars share one embedding level, so the chip is a sub-range
      // of a single bidi run; take that run's geometry. Without this a click on a
      // math chip embedded in an RTL line never enters the formula (it snaps to a
      // run boundary), so the chip cannot be selected or edited.
      for (const run of layout.marks
        ? replacementRuns(chars, formats, layout.marks)
        : []) {
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
        // advance (interior chip indices are zero-width, so they collapse onto
        // one of these). The chip glyph box is between them, whatever the run's
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
        // RTL run), so a click just outside the chip snaps to the near boundary.
        const leftEdge = owner.level % 2 === 0 ? fragStart : fragEnd;
        const rightEdge = owner.level % 2 === 0 ? fragEnd : fragStart;
        // The caret's current chip-local offset — the drag hysteresis anchor.
        // Null when the caret is not already inside this fragment.
        const chipPrev =
          drag &&
          prevIndex != null &&
          prevIndex >= fragStart &&
          prevIndex <= fragEnd
            ? prevIndex - fragStart
            : null;
        // A finger drag holding a caret STRICTLY inside the chip keeps the tex
        // hit-test in charge even just past the chip's x-extent, mirroring a
        // math BLOCK: tex's drag resolution owns the interior↔edge transition
        // (2-D nearest stop + row hysteresis), instead of this x-range gate
        // hard-flipping between resolutions at the chip's exact pixel edge.
        const dragHeldInside =
          chipPrev != null && chipPrev > 0 && chipPrev < fragEnd - fragStart;
        if (
          (relativeX <= chipLeftX || relativeX >= chipRightX) &&
          !dragHeldInside
        ) {
          const bestIdx = lineStartIndex + best;
          if (bestIdx > fragStart && bestIdx < fragEnd) {
            best =
              (relativeX <= chipLeftX ? leftEdge : rightEdge) - lineStartIndex;
          }
          continue;
        }
        // The chip's formula is always laid out LTR, so the run-local x is the
        // distance from its visual left edge regardless of surrounding direction.
        const fragText = run.text.slice(
          fragStart - run.start,
          fragEnd - run.start,
        );
        const baselineY =
          lineTopY + (line.baselineOffset ?? layout.fontMetrics.ascent);
        const offset = run.replacement.hitTest(
          fragText,
          textStyle.fontSize,
          relativeX - chipLeftX,
          clickY - baselineY,
          drag,
          chipPrev,
        );
        // Finger drag: tex may resolve to the chip's outer boundary (offset 0 /
        // length) — the caret rests BESIDE the chip, exactly like a math
        // block's construct edge — so no interior clamp; the tex hysteresis owns
        // that transition. A tap keeps the interior clamp: clicking the chip's
        // body always lands inside the formula. The formula is laid out LTR, so
        // its boundary offsets are VISUAL edges — map them through leftEdge/
        // rightEdge, which fold in the owning run's direction.
        if (drag) {
          if (offset <= 0) return leftEdge;
          if (offset >= fragEnd - fragStart) return rightEdge;
          return fragStart + offset;
        }
        const lastInterior = fragText.length - 1;
        if (lastInterior < 1) return fragStart;
        return fragStart + Math.max(1, Math.min(offset, lastInterior));
      }

      return lineStartIndex + best;
    }

    if (isRTL) {
      const maxWidth = adjustedMaxWidth;
      const lineVisualStart = maxWidth - lineWidth;
      const lineVisualEnd = maxWidth;

      if (relativeX < lineVisualStart) {
        return lineEndIndex;
      }
      if (relativeX > lineVisualEnd) {
        return lineStartIndex;
      }

      let bestPosition = lineStartIndex;
      let minDistance = Infinity;

      for (let i = 0; i <= lineText.length; i++) {
        const widthFromStart = positionWidths[i];
        const charVisualX = maxWidth - widthFromStart;
        const distance = Math.abs(relativeX - charVisualX);

        if (distance < minDistance) {
          minDistance = distance;
          bestPosition = lineStartIndex + i;
        }
      }

      return bestPosition;
    } else {
      if (relativeX <= 0) {
        return lineStartIndex;
      }

      let bestPosition = lineStartIndex;
      let minDistance = Math.abs(relativeX);

      for (let i = 0; i <= lineText.length; i++) {
        const currentX = positionWidths[i];
        const distance = Math.abs(relativeX - currentX);

        if (distance < minDistance) {
          minDistance = distance;
          bestPosition = lineStartIndex + i;
        }
      }

      // Replacement runs (e.g. an inline-math chip): a click within the run's
      // x-range descends into the rendered content via the replacement's
      // hitTest — the run's visible chars map straight to a block index
      // (`run.start + offset`). A click outside the run keeps the atomic boundary
      // snap: the run is one advance, so the nearest-stop loop above can land on
      // an interior index (they all collapse to the right edge); pull it back to
      // the near edge. Needs the registry to find runs / their replacements.
      for (const run of layout.marks
        ? replacementRuns(chars, formats, layout.marks)
        : []) {
        if (!run.replacement.hitTest) continue;
        // Hit-test against the chip's FRAGMENT on this line (the run clipped to
        // the line) so a click on a continuation row of a wrapped chip still
        // descends into the formula. For an unwrapped chip the fragment is the
        // whole run.
        const fragStart = Math.max(run.start, lineStartIndex);
        const fragEnd = Math.min(run.end, lineEndIndex);
        if (fragEnd <= fragStart) continue;
        const startLocal = fragStart - lineStartIndex;
        if (startLocal + 1 >= positionWidths.length) continue;
        const fragText = run.text.slice(
          fragStart - run.start,
          fragEnd - run.start,
        );
        // The fragment's first char carries its whole on-line width (the override
        // map), so its left/right edges are the adjacent position widths.
        const chipLeftX = positionWidths[startLocal];
        const chipRightX = positionWidths[startLocal + 1];
        // The caret's current chip-local offset, so a finger DRAG descends into
        // the fraction with row hysteresis (no flip on wobble). Null when the
        // caret is not already inside this fragment.
        const chipPrev =
          drag &&
          prevIndex != null &&
          prevIndex >= fragStart &&
          prevIndex <= fragEnd
            ? prevIndex - fragStart
            : null;
        // A finger drag holding a caret STRICTLY inside the chip keeps the tex
        // hit-test in charge even just past the chip's x-extent, mirroring a
        // math BLOCK: tex's drag resolution owns the interior↔edge transition
        // (2-D nearest stop + row hysteresis), instead of this x-range gate
        // hard-flipping between resolutions at the chip's exact pixel edge.
        const dragHeldInside =
          chipPrev != null && chipPrev > 0 && chipPrev < fragEnd - fragStart;
        if (
          (relativeX <= chipLeftX || relativeX >= chipRightX) &&
          !dragHeldInside
        ) {
          if (bestPosition > fragStart && bestPosition < fragEnd) {
            bestPosition = relativeX <= chipLeftX ? fragStart : fragEnd;
          }
          continue;
        }
        // Run-local y: distance of the click below the run's baseline (the line
        // baseline = line top + ascent). Lets the hit-test pick a stacked row —
        // e.g. a click low in a fraction lands in the denominator.
        const baselineY =
          lineTopY + (line.baselineOffset ?? layout.fontMetrics.ascent);
        const offset = run.replacement.hitTest(
          fragText,
          textStyle.fontSize,
          relativeX - chipLeftX,
          clickY - baselineY,
          drag,
          chipPrev,
        );
        // Finger drag: tex may resolve to the chip's outer boundary (offset 0 /
        // length) — the caret rests BESIDE the chip, exactly like a math
        // block's construct edge — so no interior clamp; the tex hysteresis owns
        // that transition.
        if (drag) {
          return fragStart + Math.max(0, Math.min(offset, fragEnd - fragStart));
        }
        // A click on the chip places the caret INSIDE the formula. The extreme
        // stops (offset 0 / the full length) collapse onto the fragment's boundary
        // index — shared with the surrounding text/adjacent fragment, so they
        // render as an outside caret. Clamp to a strictly-interior stop so clicking
        // anywhere on the slice lands inside it. A single-char fragment has no
        // interior, so fall back to its near edge.
        const lastInterior = fragText.length - 1;
        if (lastInterior < 1) return fragStart;
        return fragStart + Math.max(1, Math.min(offset, lastInterior));
      }

      return bestPosition;
    }
  }

  /**
   * Selection highlight rectangles for this block. `originX` is the block left
   * edge, `blockTopY` the block top in the caller's space.
   */
  selectionRects(
    layout: TextNodeLayout,
    selection: { anchor: Position; focus: Position; isForward: boolean },
    blockIndex: number,
    originX: number,
    blockTopY: number,
    // The local selection passes `true` to render as one continuous ribbon;
    // tight range decorations (find highlights, remote carets) leave it `false`.
    continuous = false,
    // The point-in-selection hit-test passes `true` so a whole selected
    // inline-math chip reports its full atomic box as touchable. See
    // `computeSelectionRects`.
    hitTest = false,
  ): Rect[] {
    return computeSelectionRects(
      layout,
      this.baseX(layout, originX),
      blockTopY + layout.insetY,
      layout.adjustedMaxWidth,
      selection,
      blockIndex,
      continuous,
      hitTest,
    );
  }

  /**
   * Full text render. Ported from renderBlock's text path. Draws markers, lines
   * (with composition underline), search highlights, remote + local selection
   * overlays, and the placeholder. Returns absolute line boxes.
   */
  paint(passedLayout: NodeLayout, c: NodePaintCtx): RenderedBlock {
    const block = c.block as TextualBlock;
    const { ctx, state, styles, blockIndex, maxWidth } = c;
    const x = c.origin.x;
    const y = c.origin.y;

    // Resolve composition content. When no IME composition is active in this
    // block, the registry-provided layout (plain content) is exactly what we
    // need — reuse it to avoid a second wrap. Only re-layout when composition
    // text must be folded in.
    const content = getContentWithComposition(block, state, blockIndex);
    const layout =
      content.compositionRange === null
        ? (passedLayout as TextNodeLayout)
        : this.computeLayout(block, maxWidth, styles, content, state.marks);
    const {
      isRTL,
      textStyle,
      fontFamily,
      fonts,
      fontMetrics,
      codePadding,
      indentOffset,
      markerWidth,
      insetY,
      adjustedMaxWidth,
      chars: renderChars,
      formats: renderFormats,
      compositionRange,
    } = layout;

    // Marker / text-area x positions. For non-list blocks indentOffset and
    // markerWidth are 0, so adjustedX === x and markerX is unused (no marker is
    // painted) — the same result the old isListBlock branch produced.
    let adjustedX: number;
    let markerX: number;
    if (isRTL) {
      adjustedX = x;
      markerX = x + adjustedMaxWidth;
    } else {
      markerX = x + indentOffset;
      adjustedX = x + indentOffset + markerWidth;
    }

    const renderedLines: RenderedLine[] = [];
    const fullContent = getBlockTextContent(block);

    // Highlight the hovered chip, or the one being edited — both are recorded in
    // `inlineMathHover` (the open path sets it to the edited run's range).
    const hoveredInlineMath =
      state.ui.inlineMathHover &&
      state.ui.inlineMathHover.blockIndex === blockIndex
        ? {
            startIndex: state.ui.inlineMathHover.startIndex,
            endIndex: state.ui.inlineMathHover.endIndex,
          }
        : null;

    // The collapsed caret's text index when it sits in this block — lets a
    // replacement run keep in-progress source (a half-typed math command) neutral
    // until the caret leaves.
    const cursor = state.document.cursor;
    const sel = state.document.selection;
    const caretIndex =
      cursor &&
      cursor.position.blockIndex === blockIndex &&
      (!sel || sel.isCollapsed)
        ? cursor.position.textIndex
        : null;
    // Caret-anchored scratch is armed here (an edit in progress) — a replacement
    // run renders its in-progress source literally (`\in`, not ∈) until the caret
    // commits it.
    const commandEntryActive =
      caretIndex !== null && isCaretScratchActive(state, block.id, caretIndex);

    for (let lineIndex = 0; lineIndex < layout.lines.length; lineIndex++) {
      const lyt = layout.lines[lineIndex];
      const lineStartIndex = lyt.startIndex;
      const lineEndIndex = lyt.endIndex;
      const currentY = y + insetY + lyt.y;
      const baselineY = currentY + (lyt.baselineOffset ?? fontMetrics.ascent);
      const renderX = isRTL ? adjustedX + adjustedMaxWidth : adjustedX;

      if (lineIndex === 0) {
        // Per-type marker hook: no-op for headings/paragraph, draws the
        // bullet/number/checkbox for list blocks (ListNode).
        this.paintMarker(
          ctx,
          block,
          markerX,
          baselineY - fontMetrics.ascent,
          layout,
          styles,
          state,
          blockIndex,
        );
      }

      this.renderLineText({
        block,
        ctx,
        chars: renderChars,
        formats: renderFormats,
        lineStartIndex,
        lineEndIndex,
        lineText: lyt.text,
        x: renderX,
        baselineY,
        textStyle,
        fontFamily,
        styles,
        marks: state.marks,
        isRTL,
        requestRedraw: c.requestRedraw,
        hoveredInlineMath,
        caretIndex,
        commandEntryActive,
      });

      if (compositionRange) {
        const lineContainsComposition =
          lineStartIndex < compositionRange.end &&
          lineEndIndex > compositionRange.start;
        if (lineContainsComposition) {
          renderCompositionUnderline(
            ctx,
            renderChars,
            renderFormats,
            lineStartIndex,
            lineEndIndex,
            compositionRange.start,
            compositionRange.end,
            renderX,
            baselineY - fontMetrics.ascent,
            textStyle,
            fontFamily,
            fonts,
            fontMetrics,
            codePadding,
            isRTL,
            maxWidth,
            state.marks,
          );
        }
      }

      renderedLines.push({
        text: lyt.text,
        x: adjustedX,
        y: currentY,
        width: lyt.width,
        height: lyt.height,
        baselineOffset: lyt.baselineOffset,
        startIndex: lineStartIndex,
        endIndex: lineEndIndex,
      });
    }

    // Range decorations (find highlights, etc. — behind the local selection).
    // Generic, host-supplied overlays; the engine paints them with the same
    // selection-rect machinery it uses for the local selection, and knows
    // nothing about what produced them.
    for (const deco of allDecorations(state.ui.decorations)) {
      if (deco.kind !== "range") continue;
      const sel = rangeDecorationToSelection(deco.range, state.document.page);
      if (!sel || sel.isCollapsed) continue;
      const rects = this.selectionRects(layout, sel, blockIndex, x, y);
      if (rects.length === 0) continue;
      this.fillRects(
        ctx,
        rects,
        deco.color,
        deco.opacity ?? styles.selection.remoteOpacity,
        styles.selection.cornerRadius,
      );
    }

    // (Remote selections are now range decorations, painted above with all
    // other range decorations — no peer-specific path here.)

    // Local selection — rendered as one continuous ribbon. A node selection (a
    // whole preformatted/visual block held as an atom — what Backspace from the
    // following block produces) collapses to a single position, so highlight the
    // entire block instead of a zero-width slice, mirroring the math node.
    const localSel = state.document.selection;
    if (localSel && !localSel.isCollapsed) {
      // The node-selection sentinel collapses anchor and focus onto one position
      // while staying non-collapsed (see `isNodeSelection` / the whole-block
      // branch of `deleteSelectedText`). Highlight the whole block in that case.
      const nodeSelected =
        localSel.anchor.blockIndex === blockIndex &&
        localSel.focus.blockIndex === blockIndex &&
        localSel.anchor.textIndex === localSel.focus.textIndex;
      const sel = nodeSelected
        ? {
            anchor: { blockIndex, textIndex: 0 },
            focus: { blockIndex, textIndex: fullContent.length },
            isForward: true,
          }
        : localSel;
      const rects = this.selectionRects(layout, sel, blockIndex, x, y, true);
      this.fillRects(
        ctx,
        rects,
        styles.selection.backgroundColor,
        styles.selection.opacity,
        styles.selection.cornerRadius,
      );
    }

    // Placeholder (empty block, in edit mode, not composing/selecting). Shown
    // in the caret's block by default; `placeholder.showUnfocused` extends it to
    // every empty block.
    const hasActiveSelection =
      state.document.selection && !state.document.selection.isCollapsed;
    const cursorInThisBlock =
      state.document.cursor?.position.blockIndex === blockIndex;
    if (
      (styles.placeholder.showUnfocused || cursorInThisBlock) &&
      fullContent.length === 0 &&
      !state.ui.composition &&
      !hasActiveSelection &&
      state.ui.mode === "edit"
    ) {
      this.paintPlaceholder(
        ctx,
        adjustedX,
        y + insetY + fontMetrics.ascent,
        styles,
        textStyle,
        this.placeholderText(block, styles, state),
        isRTL,
        adjustedMaxWidth,
      );
    }

    const bounds: BlockBounds = {
      x: adjustedX,
      y,
      width: adjustedMaxWidth,
      height: layout.height - insetY - textStyle.paddingBottom,
    };

    return { block, bounds, lines: renderedLines };
  }

  protected fillRects(
    ctx: CanvasRenderingContext2D,
    rects: Rect[],
    fillStyle: string,
    opacity: number,
    cornerRadius = 0,
  ): void {
    if (rects.length === 0) return;
    ctx.save();
    ctx.fillStyle = fillStyle;
    ctx.globalAlpha = opacity;
    for (const r of rects) {
      if (cornerRadius > 0) {
        ctx.beginPath();
        ctx.roundRect(r.x, r.y, r.width, r.height, cornerRadius);
        ctx.fill();
      } else {
        ctx.fillRect(r.x, r.y, r.width, r.height);
      }
    }
    ctx.restore();
  }

  /** Map a click to a caret position (Node contract; unused for text — the
   * renderer/selection call positionFromPoint directly with the y coordinate). */
  hitTest(): Position {
    return { blockIndex: 0, textIndex: 0 };
  }

  // -------------------------------------------------------------------------
  // Serialization (folded in from the former textCodec). The codec's
  // markdown/html/text round-trip is now expressed as methods adapted into a
  // BlockCodec by the schema. This block is also the parser's paragraph
  // fallback for any unclaimed block-start token.
  // -------------------------------------------------------------------------

  readonly codec: NodeCodec = {
    markdown: {
      tokens: [HEADING_1, HEADING_2, HEADING_3],
      output: (block, ctx) => {
        const b = block as TextualBlock;
        const prefix = MARKDOWN_PREFIX[b.type] ?? "";
        return prefix + ctx.inline(b.charRuns, b.formats);
      },
      input: (ctx) => {
        const level = headingLevel(ctx);
        const { charRuns, formats } = ctx.inlineText();

        if (level > 0) {
          const heading: Heading = {
            id: ctx.nextBlockId(),
            type: `heading${level}` as Heading["type"],
            charRuns,
            formats,
          };
          ctx.match(NEWLINE);
          return heading;
        }

        const paragraph: Paragraph = {
          id: ctx.nextBlockId(),
          type: "paragraph",
          charRuns,
          formats,
        };
        return paragraph;
      },
    },
    html: {
      output: (block, ctx) => {
        const b = block as TextualBlock;
        const tag = HTML_TAG_NAME[b.type] ?? "p";
        const inner = ctx.inline(b.charRuns, b.formats);
        return `<${tag}>${inner}</${tag}>`;
      },
    },
    text: {
      output: (block, ctx) => {
        const b = block as TextualBlock;
        return ctx.inline(b.charRuns, b.formats);
      },
    },
  };

  // -------------------------------------------------------------------------
  // Per-type hooks. The base (headings/paragraph) adds nothing; ListNode
  // overrides these to layer list behavior on top of the shared text geometry.
  // Keeping them here — rather than `isListBlock` branches inline — is what lets
  // a host drop list support entirely by not registering ListNode.
  // -------------------------------------------------------------------------

  /**
   * Horizontal space reserved before the text area: a list indent plus a marker
   * gutter. Zero for headings/paragraph. Consumed by `computeLayout`, so the
   * value flows into every downstream geometry pass (caret, selection, hit-test)
   * without any of them re-checking the block type.
   */
  protected leadingInset(
    _block: TextualBlock,
    _styles: EditorStyles,
  ): { indentOffset: number; markerWidth: number } {
    return { indentOffset: 0, markerWidth: 0 };
  }

  /**
   * The font family this block's text is measured and rendered with. Defaults to
   * the instance's selected family; CodeNode overrides it to monospace. Resolved
   * once in `computeLayout` and threaded onto the layout, so every downstream
   * pass (caret, selection, hit-test, paint) stays in sync.
   */
  protected resolveFontFamily(styles: EditorStyles): FontFamily {
    return currentFontFamily(styles);
  }

  /**
   * Draw one wrapped line's text at the given baseline. The default applies the
   * full CRDT mark-aware renderer (`renderLine`). CodeNode overrides this to
   * paint syntax-highlighted tokens instead (code has no marks). Selection,
   * search, composition underline, and placeholder are still drawn by `paint`
   * around this call, so an override only controls the glyph fill.
   */
  protected renderLineText(p: RenderLineTextArgs): void {
    renderLine(
      p.ctx,
      p.chars,
      p.formats,
      p.lineStartIndex,
      p.lineEndIndex,
      p.x,
      p.baselineY,
      p.textStyle,
      p.fontFamily,
      p.styles,
      p.marks,
      p.isRTL,
      p.requestRedraw,
      p.hoveredInlineMath,
      p.caretIndex,
      p.commandEntryActive,
    );
  }

  /**
   * Vertical inset before the first line. Zero for every built-in text block;
   * CodeNode returns its top padding so text sits inside the background box.
   * Baked into the layout (and its height), so caret/hit-test/selection/paint
   * all start from `blockTop + insetY` without re-checking the block type.
   */
  protected contentInsetY(_block: TextualBlock, _styles: EditorStyles): number {
    return 0;
  }

  /**
   * Trailing vertical space after the last line, baked into the layout height.
   * Defaults to the resolved style's `paddingBottom`; the bottom-edge analogue
   * of {@link contentInsetY}. A node overrides it to vary that space by context
   * (QuoteNode shrinks it where it joins the next quote), with the block's
   * neighbour hints (`block.nextType`) available for the decision.
   */
  protected contentPaddingBottom(
    _block: TextualBlock,
    _styles: EditorStyles,
    textStyle: TextStyle,
  ): number {
    return textStyle.paddingBottom;
  }

  /**
   * Wrap this block's characters into display lines. The default is plain
   * width-based wrapping (`wrapText`), which has no concept of hard line breaks —
   * textual blocks are single logical lines and Enter splits the block. CodeNode
   * overrides this to break on literal "\n" characters (treating each as a
   * consumed, non-rendered break, exactly like a wrap space) so one code block
   * can span many lines. The returned `consumedSpace` flag on each line is what
   * `computeLayout` uses to advance the visible-index accounting, so an override
   * only has to mark consumed breaks correctly for caret/selection to follow.
   */
  protected wrapLines(
    chars: Char[],
    formats: MarkSpan[],
    maxWidth: number,
    textStyle: TextStyle,
    fontFamily: FontFamily,
    fonts: FontStyles,
    codePadding: number,
    compositionRange: { start: number; end: number } | null,
    marks?: MarkRegistry,
    // LTR-only: split a wide inline-math chip at its operators (false in RTL,
    // where a formula stays an atomic LTR box — see `wrapText`).
    allowReplacementBreaks: boolean = true,
  ): WrappedLine[] {
    return wrapText(
      chars,
      formats,
      maxWidth,
      textStyle.fontSize,
      textStyle.fontWeight,
      fontFamily,
      fonts,
      codePadding,
      compositionRange,
      marks,
      allowReplacementBreaks,
    );
  }

  /**
   * Paint the block's marker on its first line (bullet / number / checkbox).
   * No-op for headings/paragraph; ListNode draws the list marker.
   */
  protected paintMarker(
    _ctx: CanvasRenderingContext2D,
    _block: TextualBlock,
    _markerX: number,
    _lineTopY: number,
    _layout: TextNodeLayout,
    _styles: EditorStyles,
    _state: EditorState,
    _blockIndex: number,
  ): void {}

  /** Draw placeholder ghost text using the editor's shared placeholder style. */
  protected paintPlaceholder(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    styles: EditorStyles,
    textStyle: TextStyle,
    text: string,
    isRTL: boolean,
    maxWidth: number,
  ): void {
    renderPlaceholder(ctx, x, y, styles, textStyle, text, isRTL, maxWidth);
  }

  /** Placeholder text shown when the block is empty and focused. */
  protected placeholderText(
    block: TextualBlock,
    styles: EditorStyles,
    _state: EditorState,
  ): string {
    if (block.type === "paragraph") {
      const isTouchOnly = isTouchDevice();
      return isTouchOnly
        ? styles.placeholder.paragraph.touchCompatiableText
        : styles.placeholder.paragraph.keyboardCompatibleText;
    }
    // Narrow to heading types before indexing PlaceholderStyles (the list family
    // is handled by ListNode, never reaching this base implementation).
    if (
      block.type === "heading1" ||
      block.type === "heading2" ||
      block.type === "heading3"
    ) {
      const config = styles.placeholder[block.type];
      return "text" in config ? config.text : "";
    }
    return "";
  }
}
