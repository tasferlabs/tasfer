/**
 * TextNode — the on-canvas behavior for every textual block (headings,
 * paragraph, and the bullet/numbered/todo list family).
 *
 * The text itself — wrap, caret, click → offset, selection rects — is laid out
 * and measured by the shared text engine (`../text-layout`), the same one a
 * table cell uses. This node owns what only a block knows: where the text area
 * sits (list indent and marker, quote/code padding, a heading's space above),
 * the empty-block and cross-block selection shapes, markers, placeholders,
 * nested replacement-run geometry, and painting.
 *
 *   layout()       — one canonical TextNodeLayout (engine layout + block insets)
 *   paint()        — draw from a layout (never re-wraps)
 *   caretRect()    — caret screen rect from a layout (used by selection.ts)
 *   positionFromPoint() — click→caret index from a layout (hit-testing)
 *   selectionRects()    — highlight rectangles from a layout
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
  getFontStack,
  measureTextUpToIndex,
  type TextBatch,
  type WrappedLine,
  wrapText,
} from "../fonts";
import {
  getBlockTextContent,
  memoizeNodeLayout,
  mergeBlockStyle,
  shouldUseKeyboardPlaceholder,
} from "../node-shared";
import {
  decorationsForBlock,
  paintDecorationRects,
  rangeDecorationToContentSelection,
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
  type NodeContentHitCtx,
  type NodeContentHitOptions,
  type NodeLayout,
  type NodeLayoutCtx,
  type NodePaintCtx,
  type Point,
} from "../rendering/nodes/Node";
import { getBlockDirection } from "../rtl";
import type { InputCtx, NodeCodec } from "../serlization/codecs/types";
import type {
  Block,
  Char,
  CharRun,
  Mark,
  MarkRange,
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
import {
  type ContentSelection,
  isContentSelectionCollapsed,
} from "../structured-selection";
import { isTextualBlock } from "../sync/block-registry";
import { charRunsToChars, getVisibleTextFromRuns } from "../sync/char-runs";
import type { StructuredContentMap } from "../sync/structured-content";
import {
  foldComposition,
  layoutReplacementRuns,
  layoutText,
  type LineSlices,
  measureTextRange,
  replacementFragmentGeometry,
  replacementRangeAtPoint,
  type ReplacementRun,
  replacementRuns,
  textCaretRect,
  type TextLayout,
  textLength,
  textOffsetAtPoint,
  textRangeRects,
  type TextRect,
} from "../text-layout";
import type { CodeBlock } from "./code-block";
import type { ListBlock } from "./ListNode";
import type { QuoteBlock } from "./QuoteNode";

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
 * The canonical text layout of a textual block: the shared {@link TextLayout}
 * of its text area (wrap, line boxes, measurement inputs), plus where that area
 * sits inside the block. Every pass — height, paint, caret, hit-test, selection
 * — reads this one result instead of re-deriving any of it.
 *
 * Line boxes are relative to the text area, as in {@link TextLayout}: absolute
 * positioning differs between the scroll-space render pass and the
 * document-space caret pass, so callers add the block origin, the leading
 * inset and `insetY` themselves.
 */
export interface TextNodeLayout extends NodeLayout, TextLayout {
  readonly lines: readonly RenderedLine[];
  readonly textStyle: TextStyle;
  readonly formats: MarkSpan[];
  readonly indentOffset: number;
  readonly markerWidth: number;
  /**
   * Vertical inset before the first line (and mirrored after the last via the
   * style's paddingBottom). Resolved from the style's `paddingTop` — headings
   * carry space-above, CodeNode pads text down from the top of its background
   * box, body blocks use 0. Every Y-positioned pass (paint, caret, hit-test,
   * selection) starts from `blockTop + insetY`.
   */
  readonly insetY: number;
  /** Content width available to text (maxWidth minus list indent + marker). */
  readonly adjustedMaxWidth: number;
}

/**
 * Arguments to {@link paintTextRun} — the reusable marked-text line painter.
 *
 * `chars`/`formats` are one text field's document-order characters and its mark
 * ranges; `startIndex`/`endIndex` are the visible-offset range of the line to
 * draw. The block's own line-wrapping is NOT implied — a caller that owns its
 * own line boxes (a table cell) supplies one range per line it laid out.
 */
export interface PaintTextRunArgs {
  readonly ctx: CanvasRenderingContext2D;
  readonly chars: Char[];
  readonly formats: readonly MarkRange[];
  readonly startIndex: number;
  readonly endIndex: number;
  /** Start edge of the run: its left edge in LTR text, its right edge in RTL. */
  readonly x: number;
  readonly baselineY: number;
  /** Base metrics; a mark's own channels (bold, color, chip) layer over these. */
  readonly textStyle: TextStyle;
  readonly fontFamily: FontFamily;
  readonly styles: EditorStyles;
  readonly marks: MarkRegistry;
  readonly isRTL: boolean;
  readonly requestRedraw: () => void;
}

/**
 * Paint one line of mark-formatted CRDT text.
 *
 * This is the engine's own line renderer — the one every prose block draws
 * through — exposed for nodes that lay out text somewhere the block-level text
 * pipeline does not reach (a table cell). Painting a cell any other way would
 * mean a second implementation of mark resolution, batching for Arabic
 * ligatures, and replacement runs, and the two would drift.
 */
export function paintTextRun(args: PaintTextRunArgs): void {
  renderLine(
    args.ctx,
    args.chars,
    args.formats,
    args.startIndex,
    args.endIndex,
    args.x,
    args.baselineY,
    args.textStyle,
    args.fontFamily,
    args.styles,
    args.marks,
    args.isRTL,
    args.requestRedraw,
  );
}

/** Arguments to the {@link TextNode.renderLineText} glyph-drawing hook. */
export interface RenderLineTextArgs<B extends TextualBlockBase = TextualBlock> {
  readonly block: B;
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
  /**
   * The replacement slices this line renders. Carries the continuation row of a
   * reflowing run, which owns none of the line's characters and so cannot be
   * discovered from `lineStartIndex`/`lineEndIndex`.
   */
  readonly slices?: LineSlices;
}

/** Structural text-bearing block accepted by the reusable TextNode base. */
export interface TextualBlockBase extends BlockRuntimeState {
  type: string;
  charRuns: CharRun[];
  formats: MarkSpan[];
}

export interface Heading extends TextualBlockBase {
  type: "heading1" | "heading2" | "heading3";
}
export interface Paragraph extends TextualBlockBase {
  type: "paragraph";
}

export type TextBlock = Heading | Paragraph;
export type TextualBlock = TextBlock | ListBlock | CodeBlock | QuoteBlock;

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

  // Fold the preview in at `insertAt` (a VISIBLE index), keeping tombstoned
  // chars in document order — see `foldComposition`.
  const folded = foldComposition(
    charRunsToChars(block.charRuns),
    insertAt,
    previewText,
  );
  return {
    chars: folded.chars,
    formats: block.formats, // Keep formats as-is
    compositionRange: folded.compositionRange,
  };
}

// ---------------------------------------------------------------------------
// Measurement / drawing helpers (moved verbatim from renderer.ts)
// ---------------------------------------------------------------------------

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
        const rects = run.replacement.selectionRects(
          run.text,
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

  const offsetToStart = measureTextRange(
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

  const underlineWidth = measureTextRange(
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
  /** Stored mark that owns `replacement`, including its attachment attrs. */
  replacementMark?: Mark;
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
  let replacementMark: Mark | undefined;

  for (const format of formats) {
    const mark = marks.get(format.type);
    if (!mark) continue;
    if (mark.replacement) {
      replacement = mark.replacement;
      replacementMark = format;
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
    replacementMark,
  };
}

// Render a single line with CRDT formatting (batched to preserve ligatures).
// Per-mark visual style is resolved through the editor's MarkRegistry, so the
// renderer no longer special-cases individual mark types.
function renderLine(
  ctx: CanvasRenderingContext2D,
  chars: Char[],
  formats: readonly MarkRange[],
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
  attachments?: StructuredContentMap,
  slices?: LineSlices,
) {
  ctx.direction = isRTL ? "rtl" : "ltr";

  // Resolve canonical replacement sources from the COMPLETE marked runs once,
  // so a paint batch maps back to its run and paints the run's whole source
  // exactly once.
  const resolvedReplacements = replacementRuns(
    chars,
    formats,
    marks,
    attachments,
  );

  const batches: TextBatch[] = batchChars(
    chars,
    formats,
    lineStartIndex,
    lineEndIndex,
    marks,
  );

  const isHovered = (run: ReplacementRun): boolean =>
    hoveredInlineMath !== null &&
    run.start >= hoveredInlineMath.startIndex &&
    run.end <= hoveredInlineMath.endIndex;

  let currentX = x;

  // A continuation row of a reflowing run opens the line and owns none of its
  // characters, so no batch can carry it: paint it here, before the line's own
  // text, which starts past it.
  const lead = slices?.lead;
  const leadRun = lead
    ? resolvedReplacements.find((run) => run.start === lead.index)
    : undefined;
  if (lead && leadRun) {
    const text = leadRun.text.slice(lead.sourceStart, lead.sourceEnd);
    const dims = leadRun.replacement.measure(text, textStyle.fontSize);
    if (dims) {
      leadRun.replacement.paint({
        ctx,
        text,
        x: currentX,
        y,
        fontSize: textStyle.fontSize,
        isRTL,
        hovered: isHovered(leadRun),
        dims,
        styles,
        requestRedraw,
      });
      currentX += isRTL ? -dims.width : dims.width;
    }
  }

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
      const owner = resolvedReplacements.find(
        (run) =>
          run.replacement === style.replacement &&
          batchVisibleStart >= run.start &&
          batchVisibleEnd <= run.end,
      );
      // The run's slice on THIS line — the whole source unless the run reflows,
      // in which case the anchor char carries only its first slice and the rest
      // paint as the continuation rows above.
      const anchored = owner ? slices?.anchored.get(owner.start) : undefined;
      const partial =
        anchored !== undefined &&
        !(
          anchored.sourceStart === 0 &&
          anchored.sourceEnd === owner?.text.length
        );
      const replacementText = owner
        ? anchored
          ? owner.text.slice(anchored.sourceStart, anchored.sourceEnd)
          : owner.text
        : style.replacementMark
          ? (style.replacement.source?.(batch.text, {
              mark: style.replacementMark,
              attachments,
            }) ?? batch.text)
          : batch.text;
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
      // A partial slice indexes its own substring, so a caret offset into the
      // whole source would point at the wrong character — an in-progress command
      // renders resolved rather than literal until the formula stops reflowing.
      const edit: MarkReplacementEdit | undefined = partial
        ? undefined
        : {
            caretOffset,
            editing: commandEntryActive,
          };
      const dims = style.replacement.measure(
        replacementText,
        textStyle.fontSize,
        edit,
      );
      if (dims) {
        style.replacement.paint({
          ctx,
          text: replacementText,
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

type Rect = TextRect;

/**
 * Highlight rectangles for a selection within one text block.
 *
 * The engine measures this block's share of the selection
 * ({@link textRangeRects}); this places those rects at the block's text origin
 * and adds what only a block knows about: an empty block's sliver, and the
 * continuous ribbon a selection crossing blocks forms. Both the painter and the
 * hit-test (isPointWithinSelectionRects) read it.
 */
function computeSelectionRects(
  layout: TextNodeLayout,
  baseX: number,
  blockTopY: number,
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
  // (`isPointWithinSelectionRects`), not the painter. See `textRangeRects`.
  hitTest = false,
): Rect[] {
  const start = selection.isForward ? selection.anchor : selection.focus;
  const end = selection.isForward ? selection.focus : selection.anchor;
  const { textStyle, insetY, height: blockHeight } = layout;

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

  if (start.blockIndex > blockIndex || end.blockIndex < blockIndex) return [];

  // Empty block: a small caret-width sliver. In a continuous selection it keeps
  // that narrow width (an empty line shows no full-width fill) but extends to
  // this block's box edges so it connects to the selected blocks above/below.
  if (textLength(layout) === 0 && layout.lines.length === 1) {
    const emptyBlockHeight = textStyle.fontSize * textStyle.lineHeight;
    const minSelectionWidth = textStyle.fontSize * 0.5;
    const top = continuous && enteredFromAbove ? blockTopEdge : blockTopY;
    const bottom =
      continuous && exitsBelow ? blockBottomEdge : blockTopY + emptyBlockHeight;
    const emptyLine = layout.lines[0];
    return [
      {
        x: baseX,
        y: top,
        width: minSelectionWidth,
        height: bottom - top,
        baseline:
          blockTopY +
          emptyLine.y +
          (emptyLine.baselineOffset ?? layout.fontMetrics.ascent),
      },
    ];
  }

  const rects: Rect[] = textRangeRects(
    layout,
    start.blockIndex === blockIndex ? start.textIndex : null,
    end.blockIndex === blockIndex ? end.textIndex : null,
    { hitTest },
  ).map((rect) => ({
    ...rect,
    x: baseX + rect.x,
    y: blockTopY + rect.y,
    ...(rect.baseline === undefined
      ? {}
      : { baseline: blockTopY + rect.baseline }),
  }));

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

export class TextNode<
  B extends TextualBlockBase = TextualBlock,
> extends Node<B> {
  // Representative type; the view is registered under every `types` key. Typed
  // wide (not the "paragraph" literal) so ListNode can override both.
  readonly type: B["type"] = "paragraph" as B["type"];
  readonly types: readonly string[] = TEXT_BLOCK_TYPES;

  /**
   * Cheap pre-layout height. The estimate is deliberately owned by the text
   * node so custom text families inherit it and can override the same geometry
   * hooks (`textStyle`, `leadingInset`, `contentInsetY`) as exact layout.
   */
  estimateHeight(c: NodeLayoutCtx): number {
    const block = c.block as unknown as B;
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
      this.contentInsetY(block, c.styles, textStyle) +
      estimatedLines * textStyle.fontSize * textStyle.lineHeight +
      this.contentPaddingBottom(block, c.styles, textStyle)
    );
  }

  /**
   * Center the gutter drag grip on the first text line, past any leading inset
   * (a heading's space-above, a card's outer margin + top padding) — not on the
   * block's box top, which would float the grip in the empty inset.
   */
  override gutterAnchorY(c: NodeLayoutCtx): number {
    const layout = this.layout(c);
    const first = layout.lines[0];
    return layout.insetY + (first ? first.y + first.height / 2 : 0);
  }

  /**
   * Width handed to the shared text layout before leading insets are removed.
   * CodeNode overrides this because its right-side container padding is applied
   * before TextNode's left-side leading inset.
   */
  protected estimateLayoutMaxWidth(
    _block: B,
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
        c.block as unknown as B,
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
    block: B,
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

    // Source characters an inline-math chip renders over must not count toward
    // the block's direction, so this reads marks, not just the raw runs.
    const isRTL = getBlockDirection(block, marks) === "rtl";

    // Leading inset (list indent + marker gutter) is a per-type hook: zero for
    // headings/paragraph, computed from `indent` for list blocks. Baking it into
    // the layout here means every downstream pass (caret, selection, hit-test)
    // gets correct geometry without re-checking the block type.
    const { indentOffset, markerWidth } = this.leadingInset(block, styles);
    const adjustedMaxWidth = maxWidth - indentOffset - markerWidth;
    const insetY = this.contentInsetY(block, styles, textStyle);

    const chars = content?.chars ?? charRunsToChars(block.charRuns);
    const formats = content?.formats ?? block.formats;
    const compositionRange = content?.compositionRange ?? null;

    const text = layoutText({
      chars,
      formats,
      width: adjustedMaxWidth,
      textStyle,
      fontFamily,
      fonts,
      direction: isRTL ? "rtl" : "ltr",
      codePadding,
      marks,
      structuredContent: block.structuredContent,
      compositionRange,
      wrapped: this.wrapLines(
        chars,
        formats,
        adjustedMaxWidth,
        textStyle,
        fontFamily,
        fonts,
        codePadding,
        compositionRange,
        marks,
        block.structuredContent,
        !isRTL,
      ),
    });

    return {
      ...text,
      textStyle,
      formats,
      height:
        insetY +
        text.contentHeight +
        this.contentPaddingBottom(block, styles, textStyle),
      maxWidth,
      indentOffset,
      markerWidth,
      insetY,
      adjustedMaxWidth,
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
    const { textStyle, insetY } = layout;
    const baseX = this.baseX(layout, originX);

    const nestedPoint = state?.document.contentSelection?.focus;
    if (blockId && nestedPoint?.blockId === blockId) {
      const run = layoutReplacementRuns(layout).find(
        (candidate) =>
          candidate.mark.attrs?.contentId === nestedPoint.contentId &&
          candidate.replacement.contentCaretRect,
      );
      if (run) {
        for (const [lineIndex, line] of layout.lines.entries()) {
          const fragment = replacementFragmentGeometry(
            layout,
            lineIndex,
            line,
            run,
          );
          if (!fragment) continue;
          const nestedCaret = run.replacement.contentCaretRect?.(
            fragment.text,
            textStyle.fontSize,
            nestedPoint,
            {
              blockId,
              mark: run.mark,
              attachments: layout.structuredContent,
              sourceRange: fragment.sourceRange,
            },
          );
          if (!nestedCaret) continue;
          const baselineY =
            blockTopY +
            insetY +
            line.y +
            (line.baselineOffset ?? layout.fontMetrics.ascent);
          return {
            x: baseX + fragment.left + nestedCaret.x,
            y: baselineY + nestedCaret.top,
            height: nestedCaret.bottom - nestedCaret.top,
            exact: true,
          };
        }
      }
    }

    const caret = textCaretRect(layout, textIndex);
    return {
      x: baseX + caret.x,
      y: blockTopY + insetY + caret.y,
      height: caret.height,
    };
  }

  /**
   * The flat bounds of the replacement run holding the nested caret, or null
   * when no nested caret sits in this block. The run is painted with the same
   * emphasis a hover gives it (`MarkReplacement.paint`'s `hovered`), so an
   * inline formula being edited reads as active the way a math block does.
   */
  private activeReplacementRange(
    layout: TextNodeLayout,
    state: EditorState,
    blockId: string,
  ): { startIndex: number; endIndex: number } | null {
    const point = state.document.contentSelection?.focus;
    if (!point || point.blockId !== blockId || !layout.marks) return null;
    const run = replacementRuns(
      layout.chars,
      layout.formats,
      layout.marks,
      layout.structuredContent,
    ).find((candidate) => candidate.mark.attrs?.contentId === point.contentId);
    return run ? { startIndex: run.start, endIndex: run.end } : null;
  }

  /** Direct nested hit-test for replacement marks with structured content. */
  override contentSelectionFromPoint(
    layoutValue: NodeLayout,
    local: Point,
    c: NodeContentHitCtx<B>,
    options: NodeContentHitOptions,
  ): ContentSelection | null {
    const layout = layoutValue as TextNodeLayout;
    if (!layout.marks) return null;
    const runs = replacementRuns(
      layout.chars,
      layout.formats,
      layout.marks,
      layout.structuredContent,
    ).filter((run) => run.replacement.contentSelectionFromPoint);
    if (runs.length === 0) return null;

    const baseX = this.baseX(layout, 0);
    const pointX = local.x - baseX;
    for (const [lineIndex, line] of layout.lines.entries()) {
      const lineTop = layout.insetY + line.y;
      if (local.y < lineTop || local.y >= lineTop + line.height) continue;
      const baseline =
        lineTop + (line.baselineOffset ?? layout.fontMetrics.ascent);
      for (const run of runs) {
        const fragment = replacementFragmentGeometry(
          layout,
          lineIndex,
          line,
          run,
        );
        if (!fragment) continue;
        const previousOwnedByRun =
          options.drag &&
          options.previousPoint?.contentId === run.mark.attrs?.contentId;
        if (
          !previousOwnedByRun &&
          (pointX < fragment.left || pointX > fragment.right)
        ) {
          continue;
        }
        const selection = run.replacement.contentSelectionFromPoint?.(
          fragment.text,
          layout.textStyle.fontSize,
          pointX - fragment.left,
          local.y - baseline,
          {
            blockId: c.block.id,
            mark: run.mark,
            attachments: layout.structuredContent,
            sourceRange: fragment.sourceRange,
            pointerType: options.pointerType,
            drag: options.drag,
            previousPoint: options.previousPoint,
          },
        );
        if (selection) return selection;
      }
    }
    return null;
  }

  /**
   * The word/token RANGE a double-tap at a point selects, resolved from the
   * POINT rather than a caret offset. Plain prose has no point-specific word
   * model — its offset-based word selection is fine — but a replacement run
   * does: a point landing on its glyph box selects the run whole (the run's
   * only flat positions are its two edges, so a resolved offset can miss it —
   * e.g. a double-click past the end of a line ending in a chip). Returns null
   * off any run; the caller falls back to the offset path. See
   * {@link getWordRangeFromViewport}.
   */
  wordRangeFromPoint(
    layout: TextNodeLayout,
    x: number,
    y: number,
    originX: number,
    blockTopY: number,
  ): { start: number; end: number } | null {
    return replacementRangeAtPoint(
      layout,
      x - this.baseX(layout, originX),
      y - blockTopY - layout.insetY,
    );
  }

  /**
   * Click → caret text index within the block. `x`/`y` are absolute in the
   * caller's coordinate space; `blockTopY` the block's top; `originX` the left
   * edge (canvas paddingLeft). A replacement run (an inline-math chip) is one
   * atomic anchor char: clicks snap to its near edge, and interior resolution
   * belongs to the nested-selection hit-test.
   */
  positionFromPoint(
    _block: B,
    layout: TextNodeLayout,
    x: number,
    y: number,
    originX: number,
    blockTopY: number,
    // Finger-drag (magnifier) resolution and its hysteresis anchor (the caret's
    // current index in this block). Plain text resolves a point the same way
    // either way; the params exist for the shared signature and math's override
    // consumes them.
    _drag = false,
    _prevIndex: number | null = null,
  ): number {
    return textOffsetAtPoint(
      layout,
      x - this.baseX(layout, originX),
      y - blockTopY - layout.insetY,
    );
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
    const block = c.block as unknown as B;
    // Page storage keeps a closed core union for discriminated narrowing;
    // schema-installed text blocks cross that representation boundary here.
    const runtimeBlock = block as unknown as Block;
    const { ctx, state, styles, blockIndex, maxWidth } = c;
    const x = c.origin.x;
    const y = c.origin.y;

    // Resolve composition content. When no IME composition is active in this
    // block, the registry-provided layout (plain content) is exactly what we
    // need — reuse it to avoid a second wrap. Only re-layout when composition
    // text must be folded in.
    const content = getContentWithComposition(runtimeBlock, state, blockIndex);
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
    const fullContent = getBlockTextContent(runtimeBlock);

    // Highlight the hovered chip, or the one being edited: a replacement run
    // holding the nested caret reads as active exactly like a math block does
    // while the caret is in it, so the formula you are typing in stays lit once
    // the pointer moves away.
    const hover =
      state.ui.inlineMathHover?.blockIndex === blockIndex
        ? state.ui.inlineMathHover
        : null;
    const hoveredInlineMath = hover
      ? { startIndex: hover.startIndex, endIndex: hover.endIndex }
      : this.activeReplacementRange(layout, state, block.id);

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
      // `renderX` is the line's start edge — renderLine draws any continuation
      // row there first and advances past it; everything else starts at the text
      // origin, which is that row's far side.
      const renderX = isRTL ? adjustedX + adjustedMaxWidth : adjustedX;
      const lead = lyt.leadOffset ?? 0;
      const textX = isRTL ? renderX - lead : renderX + lead;

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
        slices: layout.lineSlices[lineIndex],
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
            textX,
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
        ...(lead > 0 ? { leadOffset: lead } : {}),
      });
    }

    const nestedSelectionRects = (selection: ContentSelection): Rect[] => {
      if (
        isContentSelectionCollapsed(selection) ||
        selection.focus.blockId !== block.id ||
        !layout.marks
      ) {
        return [];
      }
      const run = replacementRuns(
        renderChars,
        renderFormats,
        layout.marks,
        layout.structuredContent,
      ).find(
        (candidate) =>
          candidate.mark.attrs?.contentId === selection.focus.contentId &&
          candidate.replacement.contentSelectionRects,
      );
      if (!run) return [];

      const baseX = this.baseX(layout, x);
      const rects: Rect[] = [];
      for (const [lineIndex, line] of layout.lines.entries()) {
        const fragment = replacementFragmentGeometry(
          layout,
          lineIndex,
          line,
          run,
        );
        if (!fragment) continue;
        const fragmentRects = run.replacement.contentSelectionRects?.(
          fragment.text,
          textStyle.fontSize,
          selection,
          {
            blockId: block.id,
            mark: run.mark,
            attachments: layout.structuredContent,
            sourceRange: fragment.sourceRange,
          },
        );
        if (!fragmentRects) continue;
        const baselineY =
          y + insetY + line.y + (line.baselineOffset ?? fontMetrics.ascent);
        for (const rect of fragmentRects) {
          rects.push({
            x: baseX + fragment.left + rect.x,
            y: baselineY + rect.top,
            width: rect.width,
            height: rect.bottom - rect.top,
            baseline: baselineY,
          });
        }
      }
      return rects;
    };

    // Range decorations (find highlights, etc. — behind the local selection).
    // Generic, host-supplied overlays; the engine paints them with the same
    // selection-rect machinery it uses for the local selection, and knows
    // nothing about what produced them. Only this block's share of the store
    // is walked (plus ranges spanning blocks, which `selectionRects` clips).
    const blockDecorations = decorationsForBlock(
      state.ui.decorations,
      c.block.id,
    );
    for (const deco of blockDecorations) {
      if (deco.kind !== "block" || deco.block !== c.block.id) continue;
      const rects = this.selectionRects(
        layout,
        {
          anchor: { blockIndex, textIndex: 0 },
          focus: { blockIndex, textIndex: fullContent.length },
          isForward: true,
        },
        blockIndex,
        x,
        y,
        true,
      );
      this.fillRects(
        ctx,
        rects,
        deco.color,
        deco.opacity ?? styles.selection.remoteOpacity,
        styles.selection.cornerRadius,
      );
    }

    for (const deco of blockDecorations) {
      if (deco.kind !== "range") continue;
      const sel = rangeDecorationToSelection(deco.range, state.document.page);
      if (!sel || sel.isCollapsed) continue;
      const rects = this.selectionRects(layout, sel, blockIndex, x, y);
      if (rects.length === 0) continue;
      paintDecorationRects(ctx, rects, deco, styles);
    }

    // Structured range decorations use the replacement's own geometry. This is
    // the remote-selection counterpart to the local nested selection below.
    for (const deco of blockDecorations) {
      if (deco.kind !== "range") continue;
      const selection = rangeDecorationToContentSelection(deco.range);
      if (!selection) continue;
      const rects = nestedSelectionRects(selection);
      if (rects.length === 0) continue;
      paintDecorationRects(ctx, rects, deco, styles);
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

    // Nested selection held inside a replacement run (an inline chip's
    // construct-before-delete highlight, a tree range selection). Entering
    // structured content deliberately clears the flat cursor/range, so the
    // local-selection ribbon above never fires — paint the highlight through
    // the run's own geometry instead, mirroring the display equation
    // (MathNode's contentSelection path).
    const nestedSel = state.document.contentSelection;
    if (nestedSel) {
      this.fillRects(
        ctx,
        nestedSelectionRects(nestedSel),
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
      // Trailing space via the hook, not the raw style: quote/code vary it by
      // neighbour context (joined edges, outer card margins).
      height:
        layout.height -
        insetY -
        this.contentPaddingBottom(block, styles, textStyle),
    };

    return { block: runtimeBlock, bounds, lines: renderedLines };
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
        const { charRuns, formats, structuredContent } = ctx.inlineText();

        if (level > 0) {
          const heading: Heading = {
            id: ctx.nextBlockId(),
            type: `heading${level}` as Heading["type"],
            charRuns,
            formats,
            ...(structuredContent ? { structuredContent } : {}),
          };
          ctx.match(NEWLINE);
          return heading;
        }

        const paragraph: Paragraph = {
          id: ctx.nextBlockId(),
          type: "paragraph",
          charRuns,
          formats,
          ...(structuredContent ? { structuredContent } : {}),
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
    _block: B,
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
  protected renderLineText(p: RenderLineTextArgs<B>): void {
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
      p.block.structuredContent,
      p.slices,
    );
  }

  /**
   * Vertical inset before the first line. Defaults to the resolved style's
   * `paddingTop` (headings carry space-above for prose rhythm; code's style
   * reuses it as the top inset of its background box; body blocks use 0).
   * QuoteNode overrides it to vary the inset by neighbour context. Baked into
   * the layout (and its height), so caret/hit-test/selection/paint all start
   * from `blockTop + insetY` without re-checking the block type.
   *
   * Space-above binds a heading to the section it opens, so it collapses where
   * there is no section above: when the block opens the document, or sits
   * directly under a document-opening image (the cover). The page title then
   * hugs the top chrome / cover, Notion-style, instead of floating a heading's
   * worth of air below it. Both checks are the cache-safe neighbour hints
   * stamped by `getVisibleBlocks` — an image that merely ends the previous
   * section (`prevIsFirst` unset) keeps the heading's full space-above.
   */
  protected contentInsetY(
    block: B,
    _styles: EditorStyles,
    textStyle: TextStyle,
  ): number {
    if (block.prevType === undefined) return 0;
    if (block.prevIsFirst && block.prevType === "image") return 0;
    return textStyle.paddingTop ?? 0;
  }

  /**
   * Trailing vertical space after the last line, baked into the layout height.
   * Defaults to the resolved style's `paddingBottom`; the bottom-edge analogue
   * of {@link contentInsetY}. A node overrides it to vary that space by context
   * (QuoteNode shrinks it where it joins the next quote), with the block's
   * neighbour hints (`block.nextType`) available for the decision.
   */
  protected contentPaddingBottom(
    _block: B,
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
    attachments?: StructuredContentMap,
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
      attachments,
      allowReplacementBreaks,
    );
  }

  /**
   * Paint the block's marker on its first line (bullet / number / checkbox).
   * No-op for headings/paragraph; ListNode draws the list marker.
   */
  protected paintMarker(
    _ctx: CanvasRenderingContext2D,
    _block: B,
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
    block: B,
    styles: EditorStyles,
    state: EditorState,
  ): string {
    if (block.type === "paragraph") {
      const useKeyboardPlaceholder = shouldUseKeyboardPlaceholder(
        state.ui.hasHardwareKeyboard,
      );
      return useKeyboardPlaceholder
        ? styles.placeholder.paragraph.keyboardCompatibleText
        : styles.placeholder.paragraph.touchCompatiableText;
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
