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
import {
  getBlockTextContent,
  isTouchDevice,
  memoizeNodeLayout,
} from "../node-shared";
import type {
  MarkChipStyle,
  MarkRegistry,
  MarkReplacement,
  MarkReplacementEdit,
  MarkUnderlineStyle,
} from "../rendering/marks";
import {
  allDecorations,
  rangeDecorationToSelection,
} from "../rendering/decorations";
import {
  type BlockRuntimeState,
  Node,
  type NodeLayout,
  type NodeLayoutCtx,
  type NodePaintCtx,
} from "../rendering/nodes/Node";
import { getTextDirection } from "../rtl";
import type { InputCtx, OutputCtx } from "../serlization/codecs/types";
import type {
  Block,
  Char,
  CharRun,
  Mark,
  MarkSpan,
} from "../serlization/loadPage";
import type { TokenType } from "../serlization/tokenizer";
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
import { isCaretScratchActive } from "../state-utils";
import { isTextualBlock } from "../sync/block-registry";
import {
  charRunsToChars,
  getVisibleTextFromChars,
  getVisibleTextFromRuns,
  iterateVisibleChars,
} from "../sync/char-runs";
import type { CodeBlock } from "./CodeNode";
import type { ListBlock } from "./ListNode";
import type { MathBlock } from "./MathNode";

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

/** Replacement-mark runs in a resolved char view, as visible-index runs. */
function replacementRuns(
  chars: Char[],
  formats: MarkSpan[],
  marks: MarkRegistry,
): ReplacementRun[] {
  if (!formats.some((f) => marks.get(f.format.type)?.replacement)) return [];
  const idToVis = new Map<string, number>();
  const visChars: string[] = [];
  let v = 0;
  for (const c of chars) {
    if (c.deleted) continue;
    idToVis.set(c.id, v);
    visChars.push(c.char);
    v++;
  }
  const runs: ReplacementRun[] = [];
  for (const f of formats) {
    const replacement = marks.get(f.format.type)?.replacement;
    if (!replacement) continue;
    const s = idToVis.get(f.startCharId);
    const e = idToVis.get(f.endCharId);
    if (s === undefined || e === undefined) continue;
    runs.push({
      start: s,
      end: e + 1,
      text: visChars.slice(s, e + 1).join(""),
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
export type TextualBlock = TextBlock | ListBlock | CodeBlock | MathBlock;

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

  const cursorTextIndex = state.document.cursor.position.textIndex;

  // Create temporary composition chars (without IDs since they're not persisted)
  const compositionChars: Char[] = Array.from(compositionText).map(
    (char, i) => ({
      id: `composition-${i}`,
      char,
      deleted: false,
    }),
  );

  // Insert composition chars at cursor position (visible index)
  const modifiedChars: Char[] = [];
  let visibleIndex = 0;
  let insertionDone = false;

  // Convert charRuns to chars and insert composition
  for (const { id, char } of iterateVisibleChars(block.charRuns)) {
    if (visibleIndex === cursorTextIndex && !insertionDone) {
      // Insert composition chars here
      modifiedChars.push(...compositionChars);
      insertionDone = true;
    }

    modifiedChars.push({ id, char, deleted: false });
    visibleIndex++;
  }

  // If cursor is at the end, append composition
  if (!insertionDone) {
    modifiedChars.push(...compositionChars);
  }

  return {
    chars: modifiedChars,
    formats: block.formats, // Keep formats as-is
    compositionRange: {
      start: cursorTextIndex,
      end: cursorTextIndex + compositionText.length,
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
  ctx.save();
  ctx.fillStyle = styles.placeholder.color;
  ctx.font = `${textStyle.fontWeight} ${textStyle.fontSize}px ${getFontStack(
    currentFontFamily(styles),
    styles.fonts,
  )}`;
  ctx.textBaseline = "alphabetic";
  ctx.direction = isRTL ? "rtl" : "ltr";

  const textX = isRTL ? x + maxWidth : x;
  ctx.fillText(text, textX, y);
  ctx.restore();
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
  italic: boolean;
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
 * wins over a plain color (link); italic / strike / underline are additive; a
 * replacement mark (math) wins the run and contributes no inline channels.
 */
function composeMarkStyle(
  formats: Mark[],
  marks: MarkRegistry,
  styles: EditorStyles,
): ComposedMarkStyle {
  let italic = false;
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
    if (s.italic) italic = true;
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
    italic,
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
    const effectiveFontWeight = batch.isBold ? "bold" : textStyle.fontWeight;
    const fontStyle = style.italic ? "italic" : "normal";

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
    lineHeight,
    chars,
    formats,
  } = layout;

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

  // Empty block: a small caret-width highlight.
  if (contentLength === 0 && layout.lines.length === 1) {
    const emptyBlockHeight = textStyle.fontSize * textStyle.lineHeight;
    const minSelectionWidth = textStyle.fontSize * 0.5;
    rects.push({
      x: baseX,
      y: blockTopY,
      width: minSelectionWidth,
      height: emptyBlockHeight,
    });
    return rects;
  }

  layout.lines.forEach((line, lineIndex) => {
    const lineY = blockTopY + lineIndex * lineHeight;
    let selectionStartX = baseX;
    let selectionEndX = baseX + line.width;
    let shouldRender = false;

    if (start.blockIndex === blockIndex && end.blockIndex === blockIndex) {
      if (
        start.textIndex <= line.endIndex &&
        end.textIndex >= line.startIndex
      ) {
        shouldRender = true;

        if (isRTL) {
          const selStartTextIndex = Math.max(line.startIndex, start.textIndex);
          const selEndTextIndex = Math.min(line.endIndex, end.textIndex);

          const widthToSelStart = measureLineWidth(
            chars,
            formats,
            line.startIndex,
            selStartTextIndex,
            textStyle,
            fontFamily,
            fonts,
            codePadding,
            marks,
          );
          const widthToSelEnd = measureLineWidth(
            chars,
            formats,
            line.startIndex,
            selEndTextIndex,
            textStyle,
            fontFamily,
            fonts,
            codePadding,
            marks,
          );

          selectionEndX = baseX + maxWidth - widthToSelStart;
          selectionStartX = baseX + maxWidth - widthToSelEnd;
        } else {
          if (start.textIndex > line.startIndex) {
            selectionStartX += measureLineWidth(
              chars,
              formats,
              line.startIndex,
              start.textIndex,
              textStyle,
              fontFamily,
              fonts,
              codePadding,
              marks,
            );
          }
          if (end.textIndex < line.endIndex) {
            const selectedWidth = measureLineWidth(
              chars,
              formats,
              Math.max(line.startIndex, start.textIndex),
              Math.min(line.endIndex, end.textIndex),
              textStyle,
              fontFamily,
              fonts,
              codePadding,
              marks,
            );
            selectionEndX = selectionStartX + selectedWidth;
          }
        }
      }
    } else if (start.blockIndex < blockIndex && end.blockIndex > blockIndex) {
      shouldRender = true;
      if (isRTL) {
        const lineStartX = baseX + maxWidth - line.width;
        selectionStartX = lineStartX;
        selectionEndX = lineStartX + line.width;
      }
    } else if (start.blockIndex === blockIndex && end.blockIndex > blockIndex) {
      if (start.textIndex <= line.endIndex) {
        shouldRender = true;

        if (isRTL) {
          const selStartTextIndex = Math.max(line.startIndex, start.textIndex);
          const widthToSelStart = measureLineWidth(
            chars,
            formats,
            line.startIndex,
            selStartTextIndex,
            textStyle,
            fontFamily,
            fonts,
            codePadding,
            marks,
          );

          selectionEndX = baseX + maxWidth - widthToSelStart;
          selectionStartX = baseX + maxWidth - line.width;
        } else {
          if (start.textIndex > line.startIndex) {
            selectionStartX += measureLineWidth(
              chars,
              formats,
              line.startIndex,
              start.textIndex,
              textStyle,
              fontFamily,
              fonts,
              codePadding,
              marks,
            );
          }
        }
      }
    } else if (start.blockIndex < blockIndex && end.blockIndex === blockIndex) {
      if (end.textIndex >= line.startIndex) {
        shouldRender = true;

        if (isRTL) {
          const selEndTextIndex = Math.min(line.endIndex, end.textIndex);
          const widthToSelEnd = measureLineWidth(
            chars,
            formats,
            line.startIndex,
            selEndTextIndex,
            textStyle,
            fontFamily,
            fonts,
            codePadding,
            marks,
          );

          selectionEndX = baseX + maxWidth;
          selectionStartX = baseX + maxWidth - widthToSelEnd;
        } else {
          if (end.textIndex < line.endIndex) {
            selectionEndX =
              baseX +
              measureLineWidth(
                chars,
                formats,
                line.startIndex,
                end.textIndex,
                textStyle,
                fontFamily,
                fonts,
                codePadding,
                marks,
              );
          }
        }
      }
    }

    if (shouldRender) {
      rects.push({
        x: selectionStartX,
        y: lineY,
        width: selectionEndX - selectionStartX,
        height: lineHeight,
      });
    }
  });

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
    const textStyle = this.textStyle(styles, block.type);
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
    );

    const fontMetrics = getFontMetrics(
      textStyle.fontSize,
      textStyle.fontWeight,
      fontFamily,
      fonts,
    );
    const lineHeight = fontMetrics.fontSize * textStyle.lineHeight;
    const textHeight = fontMetrics.ascent + fontMetrics.descent;

    // Build line boxes with the exact startIndex/endIndex accounting (including
    // consumed wrap spaces) used by every downstream pass. x/y are relative.
    // Line boxes carry x/y relative to the block content origin; absolute
    // positioning is added by each consumer (it differs between the scroll-space
    // paint pass and the document-space caret pass), so x stays 0 here.
    const lines: RenderedLine[] = [];
    let textIndex = 0;
    for (let i = 0; i < wrapped.length; i++) {
      const wl = wrapped[i];
      const lineStartIndex = textIndex;
      const lineEndIndex = textIndex + wl.text.length;
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
      );
      lines.push({
        text: wl.text,
        x: 0,
        y: i * lineHeight,
        width,
        height: textHeight,
        startIndex: lineStartIndex,
        endIndex: lineEndIndex,
      });
      textIndex += wl.text.length;
      if (wl.consumedSpace) textIndex += 1;
    }

    const height =
      insetY + wrapped.length * lineHeight + textStyle.paddingBottom;

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

    let currentY = blockTopY + insetY;
    for (const line of layout.lines) {
      if (textIndex >= line.startIndex && textIndex <= line.endIndex) {
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
        // While an edit is in progress inside this run, read the caret off the
        // same `edit` the run paints with (a command kept literal, `\in` not ∈)
        // so it tracks the source the user is entering.
        const localOffset = run ? textIndex - run.start : 0;
        const edit: MarkReplacementEdit = { caretOffset: localOffset, editing };
        const replCaret =
          run &&
          run.replacement.caretRect?.(
            run.text,
            textStyle.fontSize,
            localOffset,
            edit,
          );
        if (run && replCaret) {
          const chipLeft = measureTextUpToIndex(
            chars,
            formats,
            line.startIndex,
            run.start,
            textStyle.fontSize,
            textStyle.fontWeight,
            fontFamily,
            fonts,
            codePadding,
            layout.marks,
          );
          // Anchor the replacement's caret extent at the run baseline so the
          // caret hugs the row it sits on (short in a subscript, tall across a
          // numerator) rather than spanning the whole text line. A small pad
          // keeps it from going razor-thin on short glyphs.
          const baselineY = currentY + layout.fontMetrics.ascent;
          const pad = textStyle.fontSize * 0.08;
          return {
            x: baseX + chipLeft + replCaret.x,
            y: baselineY + replCaret.top - pad,
            height: replCaret.bottom - replCaret.top + pad * 2,
            exact: true,
          };
        }

        const widthFromStart = measureTextUpToIndex(
          chars,
          formats,
          line.startIndex,
          textIndex,
          textStyle.fontSize,
          textStyle.fontWeight,
          fontFamily,
          fonts,
          codePadding,
          layout.marks,
        );
        return {
          x: isRTL
            ? baseX + adjustedMaxWidth - widthFromStart
            : baseX + widthFromStart,
          y: currentY,
          height: lineHeight,
        };
      }
      currentY += lineHeight;
    }

    // Empty block or caret at the very end.
    return {
      x: isRTL ? baseX + adjustedMaxWidth : baseX,
      y: currentY,
      height: lineHeight,
    };
  }

  /**
   * Click → caret text index within the block. `x`/`y` are absolute in the
   * caller's coordinate space; `blockTopY` the block's top; `originX` the left
   * edge (canvas paddingLeft). A click can descend into a replacement run (e.g.
   * an inline-math chip) via its `hitTest`, using the layout's mark registry.
   * Ported from getPositionWithinBlock + Line.
   */
  positionFromPoint(
    _block: TextualBlock,
    layout: TextNodeLayout,
    x: number,
    y: number,
    originX: number,
    blockTopY: number,
  ): number {
    const { lineHeight } = layout;
    const baseX = this.baseX(layout, originX);

    let currentLineY = blockTopY + layout.insetY;
    for (const line of layout.lines) {
      const lineBottom = currentLineY + lineHeight;
      if (y >= currentLineY && y < lineBottom) {
        return this.positionWithinLine(layout, x, y, currentLineY, line, baseX);
      }
      currentLineY += lineHeight;
    }

    // Below the last line (padding area): use the last line.
    if (layout.lines.length > 0) {
      const last = layout.lines[layout.lines.length - 1];
      return this.positionWithinLine(
        layout,
        x,
        y,
        currentLineY - lineHeight,
        last,
        baseX,
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
    );

    const lineWidth = positionWidths[positionWidths.length - 1];

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
        const startLocal = run.start - lineStartIndex;
        if (startLocal < 0 || startLocal + 1 >= positionWidths.length) continue;
        const chipLeftX = positionWidths[startLocal];
        const chipRightX = positionWidths[startLocal + 1];
        if (relativeX <= chipLeftX || relativeX >= chipRightX) {
          if (bestPosition > run.start && bestPosition < run.end) {
            bestPosition = relativeX <= chipLeftX ? run.start : run.end;
          }
          continue;
        }
        // Run-local y: distance of the click below the run's baseline (the line
        // baseline = line top + ascent). Lets the hit-test pick a stacked row —
        // e.g. a click low in a fraction lands in the denominator.
        const baselineY = lineTopY + layout.fontMetrics.ascent;
        const offset = run.replacement.hitTest(
          run.text,
          textStyle.fontSize,
          relativeX - chipLeftX,
          clickY - baselineY,
        );
        return run.start + Math.max(0, Math.min(offset, run.text.length));
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
  ): Rect[] {
    return computeSelectionRects(
      layout,
      this.baseX(layout, originX),
      blockTopY + layout.insetY,
      layout.adjustedMaxWidth,
      selection,
      blockIndex,
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
      lineHeight,
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
      const currentY = y + insetY + lineIndex * lineHeight;
      const renderX = isRTL ? adjustedX + adjustedMaxWidth : adjustedX;

      if (lineIndex === 0) {
        // Per-type marker hook: no-op for headings/paragraph, draws the
        // bullet/number/checkbox for list blocks (ListNode).
        this.paintMarker(
          ctx,
          block,
          markerX,
          currentY,
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
        baselineY: currentY + fontMetrics.ascent,
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
            currentY,
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
      );
    }

    // (Remote selections are now range decorations, painted above with all
    // other range decorations — no peer-specific path here.)

    // Local selection.
    if (state.document.selection && !state.document.selection.isCollapsed) {
      const rects = this.selectionRects(
        layout,
        state.document.selection,
        blockIndex,
        x,
        y,
      );
      this.fillRects(
        ctx,
        rects,
        styles.selection.backgroundColor,
        styles.selection.opacity,
      );
    }

    // Placeholder (when empty + cursor here + not composing/selecting).
    const hasActiveSelection =
      state.document.selection && !state.document.selection.isCollapsed;
    if (
      state.document.cursor &&
      state.document.cursor.position.blockIndex === blockIndex &&
      fullContent.length === 0 &&
      !state.ui.composition &&
      !hasActiveSelection &&
      state.ui.mode === "edit"
    ) {
      renderPlaceholder(
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
      height: layout.wrapped.length * lineHeight,
    };

    return { block, bounds, lines: renderedLines };
  }

  private fillRects(
    ctx: CanvasRenderingContext2D,
    rects: Rect[],
    fillStyle: string,
    opacity: number,
  ): void {
    if (rects.length === 0) return;
    ctx.save();
    ctx.fillStyle = fillStyle;
    ctx.globalAlpha = opacity;
    for (const r of rects) {
      ctx.fillRect(r.x, r.y, r.width, r.height);
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

  readonly markdownTokens: readonly TokenType[] = [
    HEADING_1,
    HEADING_2,
    HEADING_3,
  ];

  outputMarkdown(block: TextualBlock, ctx: OutputCtx): string {
    const prefix = MARKDOWN_PREFIX[block.type] ?? "";
    return prefix + ctx.inline(block.charRuns, block.formats);
  }

  inputMarkdown(ctx: InputCtx): Block {
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
  }

  outputHTML(block: TextualBlock, ctx: OutputCtx): string {
    const tag = HTML_TAG_NAME[block.type] ?? "p";
    const inner = ctx.inline(block.charRuns, block.formats);
    return `<${tag}>${inner}</${tag}>`;
  }

  outputText(block: TextualBlock, ctx: OutputCtx): string {
    return ctx.inline(block.charRuns, block.formats);
  }

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
