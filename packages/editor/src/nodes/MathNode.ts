/**
 * MathNode — the `math` (display LaTeX equation) block.
 *
 * Unlike its former atomic self (a void block whose `latex` was an attribute,
 * edited through a DOM overlay), the math block is canvas-native. Legacy
 * char-run LaTeX remains as an interchange/rollout bridge, while opt-in tree
 * editing lazily migrates display equations to a structured attachment whose
 * identities own selection and CRDT edits. Once present, that tree is the
 * authority and LaTeX is derived for rendering and interchange. The node still
 * extends {@link TextNode} for compatible block behavior, while overriding the
 * equation layout, caret geometry, and tree-owned edit actions.
 *
 * Rendering is synchronous and exact (metrics are a data table), so the height
 * pass and paint always agree with no async round-trip and no font-load reflow.
 *
 * The serialization methods are this node's markdown/HTML/text round-trip,
 * adapted into a BlockCodec by the schema.
 */

import {
  type ActionBus,
  CONTENT_DELETED,
  stateAction,
  type StateHandler,
  type StateResult,
  TEXT_INPUTTED,
} from "../action-bus";
import {
  DELETE_BACKWARD,
  DELETE_FORWARD,
  DELETE_WORD_BACKWARD,
  DELETE_WORD_FORWARD,
  SELECT_ALL,
  SPLIT_BLOCK,
} from "../actions/edit-actions";
import {
  EXTEND_SELECTION_DOWN,
  EXTEND_SELECTION_LEFT,
  EXTEND_SELECTION_RIGHT,
  EXTEND_SELECTION_UP,
  MOVE_CONTENT_TAB,
  MOVE_CURSOR_DOWN,
  MOVE_CURSOR_LEFT,
  MOVE_CURSOR_RIGHT,
  MOVE_CURSOR_UP,
} from "../actions/keyboard-actions";
import { SELECT_WORD_AT_POINT } from "../actions/mouse-actions";
import { POINTER_MOVE } from "../actions/pointer-actions";
import { rangeIntersectsStructuredMark } from "../actions/structured-marks";
import { TAP_SELECT_WORD } from "../actions/touch-actions";
import { measureCtxText } from "../fonts";
import { getInlineMathAtPosition } from "../inline-math";
import { INSERT_MATH_COMMAND, RESIZE_MATH_MATRIX } from "../math/actions";
import { mathBlockNodeCodec } from "../math/data";
import {
  getMathDocumentForBlock,
  getMathStructuredDocument,
  getStructuredMathSource,
} from "../math/structured";
import {
  contentPointToMathDocumentPosition,
  contentPointToMathTreeCaret,
  mathContentSelectionFromSourceOffset,
  mathDocumentPositionToContentPoint,
  mathSourceRangeFromContentSelection,
  mathTreeCaretToContentSelection,
} from "../math/tree-selection";
import {
  backspaceActiveMathTree,
  deleteForwardActiveMathTree,
  exitActiveMathTreeHorizontally,
  exitActiveMathTreeVertically,
  extendActiveMathTreeSelectionHorizontally,
  extendActiveMathTreeSelectionVertically,
  hasActiveMathTreeCaret,
  insertActiveMathTreeCommand,
  moveActiveMathTreeCaret,
  moveActiveMathTreeCaretVertically,
  ownsMathTreeMutation,
  resizeActiveMathTreeMatrix,
  selectActiveMathTree,
} from "../math/tree-state";
import {
  allDecorations,
  rangeDecorationToSelection,
} from "../rendering/decorations";
import type { MarkRegistry } from "../rendering/marks";
import type { CaretModel } from "../rendering/nodes/caret-model";
import type {
  BlockRuntimeState,
  NodeContentHitCtx,
  NodeContentHitOptions,
  NodeLayout,
  NodeLayoutCtx,
  NodePaintCtx,
  Point,
} from "../rendering/nodes/Node";
import { invalidateBlockCache } from "../rendering/renderer";
import {
  clearSelection,
  isNodeSelection,
  moveCursorLeft,
  moveCursorRight,
  moveCursorToPosition,
} from "../selection";
import type {
  Block,
  Char,
  CharRun,
  Mark,
  MarkSpan,
} from "../serlization/loadPage";
import type {
  ContentMaterialization,
  EditorState,
  EditorStyles,
  Operation,
  Position,
  RenderedBlock,
  RenderedLine,
  SelectionState,
  TextStyle,
} from "../state-types";
import {
  closeActiveMenu,
  isCaretScratchActive,
  isTouchDevice,
  updateMode,
} from "../state-utils";
import {
  contentPointsEqual,
  type ContentSelection,
  isContentSelectionCollapsed,
} from "../structured-selection";
import { getEditorStyles } from "../styles";
import { findBlockIndex } from "../sync/block-lookup";
import {
  getVisibleTextFromChars,
  getVisibleTextFromRuns,
} from "../sync/char-runs";
import {
  deleteCharsInRange,
  insertCharsAtPosition,
  markCharsInRange,
  orderKeyAfter,
} from "../sync/crdt-utils";
import { applyOps, cardJoinFlags } from "../sync/reducer";
import type { StructuredDocument } from "../sync/structured-content";
import {
  mathAbsorbNumericPunctuationAfterInput,
  mathArmScratch,
  mathCaretMove,
  mathCommandRanges,
  mathDeleteUnit,
  mathHealAfterInput,
  mathJoinAtEdgeAfterInput,
  mathMaterializeAfterInput,
  mathMergeAfterDelete,
  mathRedundantSeparatorAfterInput,
  mathRedundantSpaceAfterInput,
  mathSelectionRange,
  mathSeparatorAfterDelete,
  mathSplitAfterInput,
  mathTransformTypedInput,
  mathUnitAt,
} from "./math";
// Host-wired layout so `\text{…}` CJK/unsupported glyphs typeset (see tex-host).
import {
  layoutMathDocumentHost,
  layoutMathHost as layoutMath,
} from "./tex-host";
import {
  getContentWithComposition,
  TextNode,
  type TextNodeLayout,
} from "./TextNode";
import {
  caretRect as texCaretRect,
  hitTest as texHitTest,
  hitTestMathDocument,
  type MathDocumentCaretPosition,
  type MathDocumentCaretStop,
  mathDocumentCaretStop,
  type MathDocumentLayout,
  type MathLayout,
  paintMath,
  selectionRects as texSelectionRects,
  spanAtPoint as texSpanAtPoint,
} from "@cypherkit/tex";

// Math block — a display LaTeX equation. `charRuns` is the legacy/interchange
// source until a structured attachment exists, after which it is only a
// compatibility shadow. Named `MathBlock` to avoid shadowing global `Math`.
export interface MathBlock extends BlockRuntimeState {
  type: "math";
  charRuns: CharRun[];
  /** Always empty — math carries no inline marks — but kept for the textual shape. */
  formats: MarkSpan[];
  displayMode: boolean; // always true for a block equation; kept for the codec
}

/** Host command-palette insertion claimed by an active structured equation. */
export { INSERT_MATH_COMMAND, RESIZE_MATH_MATRIX } from "../math/actions";

// Display-math base font size, in CSS pixels (block equations render a touch
// larger than body text).
const BLOCK_MATH_FONT_SIZE = 22;

// Wrapping geometry for a too-wide equation (see `layoutEquation`). The width
// budget is inset from the block edges so wrapped rows don't touch the rounded
// surface; continuation rows are indented and the stacked rows get a little
// extra leading so a broken equation reads as a connected, multi-line whole.
const BLOCK_MATH_PADDING_X = 16;
const BLOCK_MATH_WRAP_INDENT = 24;
const BLOCK_MATH_LINE_GAP = 8;

/** TextNodeLayout augmented with the rendered equation + its placement. */
interface MathNodeLayout extends TextNodeLayout {
  /** The laid-out equation, or null when the block is empty. */
  readonly mathLayout: MathLayout | null;
  /** Stable-id geometry when this block's structured tree is authoritative. */
  readonly mathDocumentLayout: MathDocumentLayout | null;
  /** Horizontal inset (px from the block's content-left) that centers the math. */
  readonly mathOffsetX: number;
  /** Vertical inset (px from the block top) to the math's top edge. */
  readonly mathTop: number;
  /** Width of the centered empty-block placeholder, used to align the caret. */
  readonly placeholderWidth: number;
}

// IME composition underline: a thin solid line under the string being composed,
// mirroring the operating system's own composition marker. Shared visual weight
// with the prose composition underline (see TextNode `renderCompositionUnderline`).
const IME_UNDERLINE_THICKNESS = 1.5;

/**
 * Draw the IME composition underline beneath a set of tex selection rects (the
 * composing sub-range's glyphs), one segment per visual row. `rects` are in the
 * equation's layout space: `x` from `drawX` (the math's left edge) and `y` from
 * `baselineY` (the row baseline, +y down), so the underline sits just under each
 * row's glyphs including their depth.
 */
function drawMathCompositionUnderline(
  ctx: CanvasRenderingContext2D,
  rects: readonly { x: number; y: number; width: number; height: number }[],
  drawX: number,
  baselineY: number,
  color: string,
): void {
  if (rects.length === 0) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = IME_UNDERLINE_THICKNESS;
  for (const r of rects) {
    const underlineY = baselineY + r.y + r.height + 1;
    ctx.beginPath();
    ctx.moveTo(drawX + r.x, underlineY);
    ctx.lineTo(drawX + r.x + r.width, underlineY);
    ctx.stroke();
  }
  ctx.restore();
}

/** Transient characters used only by the shared TextNode geometry shell. */
function sourceChars(source: string): Char[] {
  const chars: Char[] = [];
  for (let offset = 0; offset < source.length; offset++) {
    chars.push({ id: `math-tree-layout:${offset}`, char: source[offset] });
  }
  return chars;
}

/**
 * Legacy source-offset helpers may still answer a click before it is promoted
 * to a stable nested selection. Feed them a derived, in-memory source view;
 * tree edits never write this projection back to the block.
 */
function mathSourceView(block: MathBlock): MathBlock {
  const structured = getStructuredMathSource(block);
  return structured === undefined
    ? block
    : {
        ...block,
        charRuns: structured
          ? [{ peerId: "math-tree-layout", startCounter: 0, text: structured }]
          : [],
        formats: [],
      };
}

function mathBlockSource(block: MathBlock): string {
  return (
    getStructuredMathSource(block) ?? getVisibleTextFromRuns(block.charRuns)
  );
}

/** Resolve an optional feature block across the page's closed core union. */
function mathBlockAt(state: EditorState, blockIndex: number): MathBlock | null {
  const block = state.document.page.blocks[blockIndex] as
    | Block
    | MathBlock
    | undefined;
  return block && !block.deleted && block.type === "math" ? block : null;
}

/** Losslessly reuse a display tree as the supplemental tree of an inline mark. */
function demoteActiveStructuredMathBlock(
  state: EditorState,
): { state: EditorState; ops: Operation[]; handled: true } | undefined {
  if (state.ui.composition) return undefined;
  const selection = state.document.contentSelection;
  if (!selection || !isContentSelectionCollapsed(selection)) return undefined;
  const blockIndex = findBlockIndex(
    state.document.page,
    selection.focus.blockId,
  );
  if (blockIndex < 0) return undefined;
  const block = mathBlockAt(state, blockIndex);
  const document = block ? getMathStructuredDocument(block) : undefined;
  if (!block || !document || selection.focus.contentId !== document.rootId) {
    return undefined;
  }
  const start = mathContentSelectionFromSourceOffset(
    block.id,
    document.rootId,
    document,
    0,
  );
  if (!start || !contentPointsEqual(selection.focus, start.focus)) {
    return undefined;
  }

  const source = mathBlockSource(block);
  const supplemental =
    source.length > 0
      ? state.schema.features.cloneStructuredContent({
          document: {
            version: document.version,
            kind: document.kind,
            rootId: document.rootId,
            nodes: document.nodes,
          },
          sourceBlockId: block.id,
          targetBlockId: block.id,
          sourceContentId: document.rootId,
          identities: state.CRDTbinding,
        })
      : undefined;
  if (source.length > 0 && !supplemental) return undefined;
  const ops: Operation[] = [];
  let page = state.document.page;
  const operationBase = () => ({
    id: state.CRDTbinding.nextId(),
    clock: state.CRDTbinding.getClock(),
    pageId: state.CRDTbinding.pageId,
  });

  // Remove block authority before morphing. Generic block morphs correctly
  // reject blocks that still own structured content, so emitting `block_set`
  // first made remote replay retain a math block while the originating editor
  // manually showed a paragraph.
  const removeAuthority: Operation = {
    op: "content_edit",
    ...operationBase(),
    blockId: block.id,
    contentId: document.rootId,
    edit: { kind: "document_delete" },
  };
  ops.push(removeAuthority);
  page = applyOps(page, [removeAuthority], state.schema);

  // A lazily-migrated tree may still carry compatibility characters. They are
  // only a projection and can be stale. Reusing them and then inserting the
  // canonical source produced a short marked copy followed by raw LaTeX.
  const compatibilityLength = getVisibleTextFromRuns(block.charRuns).length;
  if (compatibilityLength > 0) {
    const deleted = deleteCharsInRange(
      page,
      block.id,
      0,
      compatibilityLength,
      state.CRDTbinding,
    );
    ops.push(deleted.op);
    page = deleted.newPage;
  }

  const setParagraph: Operation = {
    op: "block_set",
    ...operationBase(),
    blockId: block.id,
    field: "type",
    value: "paragraph",
  };
  ops.push(setParagraph);
  page = applyOps(page, [setParagraph], state.schema);

  if (source.length > 0 && supplemental) {
    const reattach: Operation = {
      op: "content_edit",
      ...operationBase(),
      blockId: block.id,
      contentId: supplemental.contentId,
      edit: { kind: "document_init", document: supplemental.document },
    };
    ops.push(reattach);
    page = applyOps(page, [reattach], state.schema);

    const inserted = insertCharsAtPosition(
      page,
      block.id,
      0,
      source,
      state.CRDTbinding,
    );
    page = inserted.newPage;
    ops.push(inserted.op);
    const marked = markCharsInRange(
      page,
      block.id,
      0,
      source.length,
      { type: "math", attrs: { contentId: supplemental.contentId } },
      true,
      state.CRDTbinding,
    );
    page = marked.newPage;
    ops.push(marked.op);
  }

  const converted = page.blocks[findBlockIndex(page, block.id)];
  if (converted) invalidateBlockCache(converted);
  let next: EditorState = {
    ...state,
    document: { ...state.document, page },
  };
  next = clearSelection(next);
  next = moveCursorToPosition(next, blockIndex, source.length);
  return { state: next, ops, handled: true };
}

/**
 * Keep a click editable: field aliases win when the pure tree controller owns
 * them, otherwise a structural row gap wins. Semantic fields that are not yet
 * controller-supported are deliberately skipped instead of creating a nested
 * caret where the next keystroke would have no effect.
 */
function editableSelectionAtMathStop(
  blockId: string,
  contentId: string,
  document: StructuredDocument,
  stop: MathDocumentCaretStop,
  lastUpdate: number,
): ContentSelection | null {
  const positions = [...stop.positions].sort((left, right) =>
    left.kind === right.kind ? 0 : left.kind === "field" ? -1 : 1,
  );
  for (const position of positions) {
    const point = mathDocumentPositionToContentPoint(
      blockId,
      contentId,
      document,
      position,
    );
    if (!point) continue;
    const caret = contentPointToMathTreeCaret(document, point);
    if (!caret) continue;
    const selection = mathTreeCaretToContentSelection(
      blockId,
      contentId,
      document,
      caret,
      lastUpdate,
    );
    if (selection) return selection;
  }
  return null;
}

/** Nearest visually-editable stop when the exact glyph field is read-only. */
function nearestEditableMathSelection(
  blockId: string,
  contentId: string,
  document: StructuredDocument,
  layout: MathDocumentLayout,
  x: number,
  y: number,
  exact: MathDocumentCaretStop,
  lastUpdate: number,
): ContentSelection | null {
  const direct = editableSelectionAtMathStop(
    blockId,
    contentId,
    document,
    exact,
    lastUpdate,
  );
  if (direct) return direct;

  let nearest:
    | {
        readonly distance: number;
        readonly sourceDistance: number;
        readonly selection: ContentSelection;
      }
    | undefined;
  for (const stop of layout.caretStops) {
    const selection = editableSelectionAtMathStop(
      blockId,
      contentId,
      document,
      stop,
      lastUpdate,
    );
    if (!selection) continue;
    const targetLeft = stop.placeholder?.left ?? stop.x;
    const targetRight = stop.placeholder?.right ?? stop.x;
    const dx =
      x < targetLeft ? targetLeft - x : x > targetRight ? x - targetRight : 0;
    const dy =
      y < stop.top ? stop.top - y : y > stop.bottom ? y - stop.bottom : 0;
    const distance = dx * dx + dy * dy;
    const sourceDistance = Math.abs(stop.sourceOffset - exact.sourceOffset);
    if (
      !nearest ||
      distance < nearest.distance ||
      (distance === nearest.distance && sourceDistance < nearest.sourceDistance)
    ) {
      nearest = { distance, sourceDistance, selection };
    }
  }
  return nearest?.selection ?? null;
}

export class MathNode extends TextNode<MathBlock> {
  readonly type = "math" as const;
  readonly types: readonly string[] = ["math"];
  // All card blocks (code, math, quote) tile together when stacked.
  readonly joinGroup = "card";

  /**
   * The visible equation renders through the tex bridge, not as wrapped text.
   * The inherited compatibility layout still needs a valid TextStyle, so
   * borrow the paragraph's (there is no dedicated text style for `math`).
   */
  override textStyle(styles: EditorStyles): TextStyle {
    return styles.blocks.paragraph;
  }

  estimateHeight(c: NodeLayoutCtx): number {
    const m = c.styles.blocks.math;
    return m.minHeight + m.paddingTop + m.paddingBottom;
  }

  /**
   * Lay out the equation as display math constrained to the block's content
   * width: it line-breaks at binary operators / relations to fit, stacking onto
   * extra rows rather than overflowing the block (a single unbreakable construct
   * still overflows — there is nothing to break). One helper so `computeLayout`,
   * `paint`, and `caretRect` all lay out with identical geometry; `literalRange`
   * keeps a command still being typed (`\in`) literal, matching what paint draws.
   */
  private layoutEquation(
    latex: string,
    contentWidth: number,
    literalRange?: { start: number; end: number },
  ): MathLayout {
    return layoutMath(latex, {
      fontSize: BLOCK_MATH_FONT_SIZE,
      displayMode: true,
      maxWidth: Math.max(0, contentWidth - 2 * BLOCK_MATH_PADDING_X),
      wrapIndent: BLOCK_MATH_WRAP_INDENT,
      wrapLineGap: BLOCK_MATH_LINE_GAP,
      literalRange,
    });
  }

  /** Lay out the authoritative tree while keeping stable ids on every caret. */
  private layoutDocumentEquation(
    block: MathBlock,
    contentWidth: number,
  ): MathDocumentLayout | null {
    const document = getMathDocumentForBlock(block);
    if (!document) return null;
    return layoutMathDocumentHost(document, {
      fontSize: BLOCK_MATH_FONT_SIZE,
      displayMode: true,
      maxWidth: Math.max(0, contentWidth - 2 * BLOCK_MATH_PADDING_X),
      wrapIndent: BLOCK_MATH_WRAP_INDENT,
      wrapLineGap: BLOCK_MATH_LINE_GAP,
    });
  }

  // ── Layout ───────────────────────────────────────────────────────────────

  /**
   * Reuse TextNode's layout to get a valid `TextNodeLayout` (chars, textStyle,
   * fonts — everything the editing/caret stack reads), then lay the text out as
   * an equation and override the block height + record where to center it.
   */
  computeLayout(
    block: MathBlock,
    maxWidth: number,
    styles: EditorStyles,
    content?: {
      chars: Char[];
      formats: MarkSpan[];
      compositionRange: { start: number; end: number } | null;
    },
    marks?: MarkRegistry,
  ): MathNodeLayout {
    const structuredSource = getStructuredMathSource(block);
    // A tree-backed block keeps no editable LaTeX char runs. Supply an
    // in-memory canonical projection solely to the mature TextNode geometry
    // shell; these identities are never persisted or edited.
    const projectedContent =
      structuredSource === undefined
        ? content
        : {
            chars: sourceChars(structuredSource),
            formats: [],
            compositionRange: null,
          };
    const base = super.computeLayout(
      block,
      maxWidth,
      styles,
      projectedContent,
      marks,
    );
    const latex =
      structuredSource === undefined
        ? getVisibleTextFromChars(base.chars)
        : structuredSource;
    const m = styles.blocks.math;
    const mathDocumentLayout = this.layoutDocumentEquation(block, maxWidth);
    // An empty authoritative row still has real placeholder/caret geometry;
    // only a legacy empty block falls back to the prose-style prompt.
    const mathLayout =
      mathDocumentLayout ??
      (latex ? this.layoutEquation(latex, maxWidth) : null);
    const mh = mathLayout ? mathLayout.height + mathLayout.depth : 0;
    const contentH = Math.max(m.minHeight, mh);
    const height = contentH + m.paddingTop + m.paddingBottom;
    const mathOffsetX = mathLayout
      ? Math.max(0, (maxWidth - mathLayout.width) / 2)
      : 0;
    const mathTop = m.paddingTop + Math.max(0, (contentH - mh) / 2);
    const placeholderWidth = measureCtxText(
      styles.placeholder.math.text,
      m.placeholder.fontSize,
      m.placeholder.fontWeight,
      base.fontFamily,
      base.fonts,
    );
    // An equation is a single logical line for the caret/selection stack: its
    // internal rows (a fraction's halves, a wrapped display line) are stacked
    // math geometry navigated by the tex caret model (see `caret` / `caretRect`),
    // NOT the text-wrapped lines TextNode measures from the raw LaTeX string.
    // Those base lines are meaningless here — worse, when the LaTeX is long enough
    // to text-wrap, the generic vertical-nav fall-through (`moveCursorDown`, once
    // `caretVerticalStep` reports no math row beyond the edge) would step between
    // them and trap the caret inside the block. Collapse to one line spanning the
    // whole equation, mirroring what `paint` emits, so exhausting the math rows
    // exits the block. Empty (no `mathLayout`) still yields one line so the block
    // reports a bottom/top edge to the escape logic.
    const line: RenderedLine = {
      text: latex,
      x: mathOffsetX,
      y: mathTop,
      width: mathLayout ? mathLayout.width : 0,
      height: mh,
      startIndex: 0,
      endIndex: latex.length,
    };
    // LaTeX is always laid out left-to-right. The base layout derives direction
    // from the content (TextNode → getTextDirection), which falls back to the UI
    // default — so in an RTL locale an empty or symbol-only equation would come
    // back RTL and mirror the caret/geometry. Pin it LTR.
    return {
      ...base,
      isRTL: false,
      lines: [line],
      height,
      mathLayout,
      mathDocumentLayout,
      mathOffsetX,
      mathTop,
      placeholderWidth,
    };
  }

  // ── Paint ────────────────────────────────────────────────────────────────

  paint(passedLayout: NodeLayout, c: NodePaintCtx): RenderedBlock {
    const { ctx, origin, styles, state, blockIndex } = c;
    const m = styles.blocks.math;
    const x = origin.x;
    const y = origin.y;
    const width = c.maxWidth;

    // Fold an active IME composition into the equation so the composing string
    // shows a live typeset preview (the same `\text{…}`-wrapped transform the
    // commit uses — see `getContentWithComposition`), instead of the equation
    // painting only its committed source. The canonical (no-composition) layout
    // from `layout()` is reused at rest; only while composing here do we re-lay
    // the equation out with the preview chars. `compositionRange` is the preview's
    // source range (== LaTeX offsets in a block equation), underlined below like
    // the OS IME marks the string being composed.
    const canonicalLayout = passedLayout as MathNodeLayout;
    const treeBacked = canonicalLayout.mathDocumentLayout !== null;
    const composed = getContentWithComposition(c.block, state, blockIndex);
    const layout =
      treeBacked || composed.compositionRange === null
        ? canonicalLayout
        : (this.computeLayout(
            c.block as unknown as MathBlock,
            width,
            styles,
            composed,
            c.marks,
          ) as MathNodeLayout);
    // Tree input commits through structured edits. The legacy IME preview is a
    // synthetic LaTeX char-run overlay and must never replace the tree on paint;
    // a document-native preview is a follow-up once composition carries a
    // nested caret.
    const compositionRange = treeBacked ? null : composed.compositionRange;

    const lines: RenderedLine[] = [];

    // `paintMath` is isolated in save/restore so none of its canvas-state
    // mutations leak to the next block (the shared render context is not saved
    // per block).
    ctx.save();

    // Keep the same full-block surface as a code block at rest so an equation
    // reads as a distinct editable block. Hover and active states use the
    // stronger math interaction color.
    // A readonly document shows no hover/active emphasis — the equation reads as
    // static, keeping its resting code-block surface. Gate on `isReadonlyBase`
    // (not `mode === "readonly"`) so a readonly editor in `select` mode, used for
    // copy, stays un-emphasized when a selection overlaps the block too.
    const emphasized =
      !state.ui.isReadonlyBase &&
      (state.ui.hoveredMathBlockIndex === blockIndex ||
        this.isBlockActive(state, blockIndex));
    ctx.fillStyle = emphasized
      ? m.hoverBackgroundColor
      : styles.blocks.code.backgroundColor;
    ctx.beginPath();
    // Adjacent math/code blocks (one shared card surface) square off the shared
    // edge so their backgrounds tile into one continuous card, not a rounded seam.
    const { joinTop, joinBottom } = cardJoinFlags(
      state.nodes,
      state.document.page.blocks,
      blockIndex,
    );
    const topRadius = joinTop ? 0 : m.hoverBorderRadius;
    const bottomRadius = joinBottom ? 0 : m.hoverBorderRadius;
    // roundRect radii order: [topLeft, topRight, bottomRight, bottomLeft].
    ctx.roundRect(x, y, width, layout.height, [
      topRadius,
      topRadius,
      bottomRadius,
      bottomRadius,
    ]);
    ctx.fill();

    if (!layout.mathLayout) {
      const selection = state.document.selection;
      const cursorInThisBlock =
        state.document.cursor?.position.blockIndex === blockIndex ||
        state.document.contentSelection?.focus.blockId === c.block.id;
      const showPlaceholder =
        (styles.placeholder.showUnfocused || cursorInThisBlock) &&
        (!selection || selection.isCollapsed) &&
        !state.ui.composition &&
        state.ui.mode === "edit";
      if (showPlaceholder) {
        const mathPlaceholder = styles.blocks.math.placeholder;
        const textStyle: TextStyle = {
          ...this.textStyle(styles),
          fontSize: mathPlaceholder.fontSize,
          fontWeight: mathPlaceholder.fontWeight,
          // Absolute size — clear any inherited scale so a host-set block
          // placeholder fontScale can't re-scale the math ghost text.
          placeholder: undefined,
        };
        ctx.save();
        ctx.textAlign = "center";
        this.paintPlaceholder(
          ctx,
          x + width / 2,
          y + layout.height / 2 + textStyle.fontSize * 0.35,
          styles,
          textStyle,
          styles.placeholder.math.text,
          false,
          width,
        );
        ctx.restore();
      }
    } else {
      const latex = getVisibleTextFromChars(layout.chars);

      // Keep a half-typed command (`\al`) in normal color until the caret moves
      // on (the source index IS the LaTeX offset for a math block). Only while
      // the collapsed caret is in this block. While that command is actively
      // being typed (command-entry scratch armed at this exact caret), the layout
      // is re-laid out below with the in-progress command kept literal — so the
      // geometry the caret reads matches what's painted (`\in`, not ∈).
      const sel = state.document.selection;
      const cursor = state.document.cursor;
      const caretIndex =
        cursor &&
        cursor.position.blockIndex === blockIndex &&
        (!sel || sel.isCollapsed)
          ? cursor.position.textIndex
          : null;
      const commandEntryActive =
        caretIndex !== null &&
        isCaretScratchActive(state, c.block.id, caretIndex);
      const { literalRange } = mathCommandRanges(
        latex,
        caretIndex,
        commandEntryActive,
      );
      const mathLayout = literalRange
        ? this.layoutEquation(latex, width, literalRange)
        : layout.mathLayout;
      const mathOffsetX = literalRange
        ? Math.max(0, (width - mathLayout.width) / 2)
        : layout.mathOffsetX;

      const drawX = x + mathOffsetX;
      const drawTop = y + layout.mathTop;
      const baselineY = drawTop + mathLayout.height;

      // Range decorations (find highlights, remote-peer selections) UNDER the
      // glyphs and behind the local selection — the same generic overlay every
      // other node paints (see TextNode.paint / AtomicNode.paintRangeDecorations).
      // A block equation renders its source as a typeset formula, so a peer's
      // selection is mapped to the tex selection rects via this node's own
      // `selectionRects`, not the raw-LaTeX text band. Without this a peer's
      // selection over an equation is invisible while their caret (drawn centrally
      // in the renderer, node-independently) still shows.
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

      // Selection highlight UNDER the glyphs — the "select-first" construct
      // deletion (and any range selection) draws over the rendered formula via
      // the tex selection rects (x from the math's left edge, y from baseline).
      const contentSelection = state.document.contentSelection;
      const document = getMathStructuredDocument(c.block);
      const range =
        contentSelection &&
        contentSelection.focus.blockId === c.block.id &&
        document &&
        layout.mathDocumentLayout
          ? mathSourceRangeFromContentSelection(
              document,
              contentSelection,
              layout.mathDocumentLayout,
            )
          : this.localSelectionRange(
              state.document.selection,
              blockIndex,
              layout.chars.length,
            );
      if (range) {
        // Reuse the base selection fill so math honors the themed
        // `selection.cornerRadius` (and color) like text/atomic blocks — but with
        // a math-specific opacity: the highlight is composited over the equation's
        // own filled card surface, not the plain document background, so the
        // shared 0.2 (tuned for text) washes out. See `MathStyles.selectionOpacity`.
        const rects = texSelectionRects(mathLayout, range.from, range.to).map(
          (r) => ({
            x: drawX + r.x,
            y: baselineY + r.y,
            width: r.width,
            height: r.height,
          }),
        );
        this.fillRects(
          ctx,
          rects,
          styles.selection.backgroundColor,
          styles.blocks.math.selectionOpacity,
          styles.selection.cornerRadius,
        );
      }

      paintMath(ctx, mathLayout, drawX, baselineY, {
        color: styles.blocks.paragraph.color,
      });

      // Underline the composing (IME) sub-range like the OS marks a string being
      // composed. The preview renders as typeset glyphs (a `\text{…}` run), so the
      // underline hugs those glyphs via the tex selection rects for the range —
      // per visual row, so a wrapped equation underlines each row's slice.
      if (compositionRange) {
        drawMathCompositionUnderline(
          ctx,
          texSelectionRects(
            mathLayout,
            compositionRange.start,
            compositionRange.end,
          ),
          drawX,
          baselineY,
          styles.blocks.paragraph.color,
        );
      }

      lines.push({
        text: latex,
        x: drawX,
        y: drawTop,
        width: mathLayout.width,
        height: mathLayout.height + mathLayout.depth,
        startIndex: 0,
        endIndex: latex.length,
      });
    }

    ctx.restore();

    return {
      block: c.block,
      bounds: { x, y, width, height: layout.height },
      lines,
    };
  }

  /**
   * Whether this block is "active" — it holds the caret, or a (possibly
   * multi-block) selection overlaps it. Keeps the full-block backdrop lit while
   * the equation is being edited, mirroring the hover highlight.
   */
  private isBlockActive(state: EditorState, blockIndex: number): boolean {
    const block = state.document.page.blocks[blockIndex];
    if (block && state.document.contentSelection?.focus.blockId === block.id) {
      return true;
    }
    const sel = state.document.selection;
    if (sel) {
      const lo = Math.min(sel.anchor.blockIndex, sel.focus.blockIndex);
      const hi = Math.max(sel.anchor.blockIndex, sel.focus.blockIndex);
      if (blockIndex >= lo && blockIndex <= hi) return true;
    }
    return state.document.cursor?.position.blockIndex === blockIndex;
  }

  /**
   * The portion of the document selection that falls within THIS block, as a
   * source range `[from, to)` into the equation's LaTeX (or null when the block
   * isn't selected). Handles cross-block selections: a block fully spanned maps
   * to `[0, len]`; an endpoint in another block clamps to this block's edge.
   */
  private localSelectionRange(
    sel: SelectionState | null,
    blockIndex: number,
    len: number,
  ): { from: number; to: number } | null {
    if (!sel || sel.isCollapsed) return null;
    const lo = Math.min(sel.anchor.blockIndex, sel.focus.blockIndex);
    const hi = Math.max(sel.anchor.blockIndex, sel.focus.blockIndex);
    if (blockIndex < lo || blockIndex > hi) return null;
    // A node selection of this whole equation (the math/code sentinel: a
    // non-collapsed selection whose endpoints share one position — what
    // Backspace from the following block produces) highlights the entire LaTeX,
    // not a zero-width slice. Without this the block would read as a stray caret.
    if (isNodeSelection(sel) && sel.anchor.blockIndex === blockIndex) {
      return len > 0 ? { from: 0, to: len } : null;
    }
    const at = (p: Position) =>
      p.blockIndex < blockIndex
        ? 0
        : p.blockIndex > blockIndex
          ? len
          : p.textIndex;
    const a = at(sel.anchor);
    const b = at(sel.focus);
    const from = Math.max(0, Math.min(a, b));
    const to = Math.min(len, Math.max(a, b));
    return from < to ? { from, to } : null;
  }

  /**
   * Selection highlight rectangles in the tex-rendered formula's geometry — the
   * SAME rects {@link paint} fills (via {@link localSelectionRange} +
   * `texSelectionRects`), NOT the base {@link TextNode.selectionRects} band
   * derived from laying the raw LaTeX source out as prose. The generic selection
   * hit-test (`isPointWithinSelectionRects`) keys off this, so a point only counts
   * as "inside the selection" when it lands on the highlight the reader actually
   * sees. Without the override the whole block's source-text band reads as
   * selected, so a tap anywhere on the equation — well outside the lit range —
   * spuriously opens the context menu instead of collapsing the selection and
   * moving the caret. `continuous` (the base's one-ribbon flag) is irrelevant:
   * `texSelectionRects` already returns per-row rects matching the paint.
   */
  selectionRects(
    layout: TextNodeLayout,
    selection: { anchor: Position; focus: Position; isForward: boolean },
    blockIndex: number,
    originX: number,
    blockTopY: number,
  ): { x: number; y: number; width: number; height: number }[] {
    const l = layout as MathNodeLayout;
    if (!l.mathLayout) return [];
    const len = getVisibleTextFromChars(l.chars).length;
    const range = this.localSelectionRange(
      selection as SelectionState,
      blockIndex,
      len,
    );
    if (!range) return [];
    const drawX = originX + l.mathOffsetX;
    const baselineY = blockTopY + l.mathTop + l.mathLayout.height;
    return texSelectionRects(l.mathLayout, range.from, range.to).map((r) => ({
      x: drawX + r.x,
      y: baselineY + r.y,
      width: r.width,
      height: r.height,
    }));
  }

  // ── Caret geometry (via the tex bridge, not text lines) ────────────────────

  /** Resolve either a stable tree caret or its transient source-offset bridge. */
  caretRect(
    layout: TextNodeLayout,
    textIndex: number,
    originX: number,
    blockTopY: number,
    state?: EditorState,
    blockId?: string,
    edge?: "start" | "end",
  ): { x: number; y: number; height: number; exact?: boolean } {
    const commandEntryActive =
      state != null && blockId != null
        ? isCaretScratchActive(state, blockId, textIndex)
        : false;
    const l = layout as MathNodeLayout;
    const contentPoint = state?.document.contentSelection?.focus;
    if (
      l.mathLayout &&
      l.mathDocumentLayout &&
      state &&
      blockId &&
      contentPoint?.blockId === blockId
    ) {
      const block = state.document.page.blocks.find(
        (candidate) => candidate.id === blockId && !candidate.deleted,
      );
      const document = block ? getMathStructuredDocument(block) : undefined;
      const position = document
        ? contentPointToMathDocumentPosition(document, contentPoint)
        : null;
      const stop = position
        ? mathDocumentCaretStop(l.mathDocumentLayout, position)
        : null;
      if (stop) {
        const baseX = originX + l.mathOffsetX;
        const baselineY = blockTopY + l.mathTop + l.mathDocumentLayout.height;
        return {
          x: baseX + stop.x,
          y: baselineY + stop.top,
          height: stop.bottom - stop.top,
          exact: true,
        };
      }
    }
    if (!l.mathLayout) {
      // The placeholder remains centered, while the caret sits at its leading
      // edge like a normal empty input.
      return {
        x: originX + Math.max(0, (l.adjustedMaxWidth - l.placeholderWidth) / 2),
        y: blockTopY + l.mathTop - BLOCK_MATH_FONT_SIZE / 2,
        height: BLOCK_MATH_FONT_SIZE,
        exact: true,
      };
    }

    // While a command is actively being typed here, read the caret off a layout
    // with that command kept literal (`\in`, not ∈) — matching what paint draws
    // — so the caret tracks the source text the user is entering. Otherwise the
    // cached (resolved) layout is exact.
    const latex = getVisibleTextFromChars(l.chars);
    const { literalRange } = mathCommandRanges(
      latex,
      textIndex,
      commandEntryActive,
    );
    const mathLayout = literalRange
      ? this.layoutEquation(latex, l.adjustedMaxWidth, literalRange)
      : l.mathLayout;
    const mathOffsetX = literalRange
      ? Math.max(0, (l.adjustedMaxWidth - mathLayout.width) / 2)
      : l.mathOffsetX;

    const baseX = originX + mathOffsetX;
    const baselineY = blockTopY + l.mathTop + mathLayout.height;
    const r = texCaretRect(mathLayout, textIndex, edge);
    if (!r) {
      return {
        x: baseX,
        y: blockTopY + l.mathTop,
        height: mathLayout.height + mathLayout.depth,
        exact: true,
      };
    }
    return {
      x: baseX + r.x,
      y: baselineY + r.top,
      height: r.bottom - r.top,
      exact: true,
    };
  }

  /** Pixels → stable nested caret for an authoritative structured equation. */
  override contentSelectionFromPoint(
    layout: NodeLayout,
    local: Point,
    c: NodeContentHitCtx<MathBlock>,
    options: NodeContentHitOptions,
  ): ContentSelection | null {
    if (c.block.type !== "math") return null;
    const block = c.block;
    const document = getMathStructuredDocument(block);
    const mathLayout = (layout as MathNodeLayout).mathDocumentLayout;
    if (!document || !mathLayout) return null;

    const previousPoint = options.previousPoint;
    const previousPosition: MathDocumentCaretPosition | null =
      previousPoint?.blockId === block.id &&
      previousPoint.contentId === document.rootId
        ? contentPointToMathDocumentPosition(document, previousPoint)
        : null;
    const l = layout as MathNodeLayout;
    const x = local.x - l.mathOffsetX;
    const y = local.y - (l.mathTop + mathLayout.height);
    const stop = hitTestMathDocument(mathLayout, x, y, {
      placeholderTargetSize: options.pointerType === "touch" ? 44 : 24,
      ...(options.drag ? { drag: true } : {}),
      ...(options.drag && previousPosition
        ? { dragPrevPosition: previousPosition }
        : {}),
    });
    if (!stop) return null;
    return nearestEditableMathSelection(
      block.id,
      document.rootId,
      document,
      mathLayout,
      x,
      y,
      stop,
      Date.now(),
    );
  }

  /** Legacy display-math click → LaTeX offset via the tex hit-test. */
  positionFromPoint(
    _block: MathBlock,
    layout: TextNodeLayout,
    x: number,
    y: number,
    originX: number,
    blockTopY: number,
    // Finger-drag (magnifier) resolution follows the finger to the equation's
    // nearest caret stop with row hysteresis, instead of the tap path's exact
    // per-row descent (see {@link TextNode.positionFromPoint}).
    drag = false,
    // The caret's current block-text index. A block equation's text IS the LaTeX,
    // so the block index is the source offset the tex hysteresis anchors on.
    prevIndex: number | null = null,
  ): number {
    const l = layout as MathNodeLayout;
    if (!l.mathLayout) return 0;
    const baseX = originX + l.mathOffsetX;
    const baselineY = blockTopY + l.mathTop + l.mathLayout.height;
    return texHitTest(l.mathLayout, x - baseX, y - baselineY, {
      placeholderTargetSize: isTouchDevice() ? 44 : 24,
      drag,
      dragPrevOffset: drag ? prevIndex : null,
    });
  }

  /**
   * Double-tap / double-click → the LaTeX range to select, resolved from the tap
   * POINT (not a caret offset). Selecting math by point is what makes a small
   * operator reachable: a `+`/`-`/`=` wedged between two constructs is impossible
   * to hit through the offset path (the tap maps to a shared boundary and
   * `mathUnitAt` prefers the neighbouring construct), but here the finger just
   * lands in the operator's own box. Uses a finger-sized target on touch. Returns
   * null for an empty block, so the caller falls back to the offset path.
   */
  wordRangeFromPoint(
    layout: TextNodeLayout,
    x: number,
    y: number,
    originX: number,
    blockTopY: number,
  ): { start: number; end: number } | null {
    const l = layout as MathNodeLayout;
    if (!l.mathLayout) return null;
    const baseX = originX + l.mathOffsetX;
    const baselineY = blockTopY + l.mathTop + l.mathLayout.height;
    return texSpanAtPoint(l.mathLayout, x - baseX, y - baselineY, {
      minTargetSize: isTouchDevice() ? 44 : 24,
    });
  }

  // ── Serialization ──────────────────────────────────────────────────────────

  readonly codec = mathBlockNodeCodec;

  // ── Caret model (block equation) ────────────────────────────────────────────
  // Flat block indices remain the legacy source-offset path. A structured
  // attachment instead hit-tests and stores stable row/node/character
  // identities, then resolves their geometry through MathDocumentLayout. The
  // legacy model still overrides `move`/`deleteUnit` (delegating to `./math`)
  // rather than declaring the equation atomic.
  readonly caret: CaretModel<MathBlock> = {
    move: (block, index, motion) =>
      mathCaretMove(mathSourceView(block), index, motion),
    deleteUnit: (block, index, dir) =>
      mathDeleteUnit(mathSourceView(block), index, dir),
    transformInput: (block, index, input) =>
      mathTransformTypedInput(mathSourceView(block), index, input),
    selectionRange: (block, anchor, focus, focusEdge) =>
      mathSelectionRange(mathSourceView(block), anchor, focus, focusEdge),
  };

  /**
   * Register the math node's pointer handler:
   *  - `POINTER_MOVE` (observe, priority 0) — highlight the whole math block
   *    under the pointer (full-block backdrop, `ui.hoveredMathBlockIndex` via
   *    {@link SET_MATH_BLOCK_HOVER}), and otherwise the inline-math chip under
   *    the pointer when over ordinary text (`ui.inlineMathHover` via
   *    {@link SET_INLINE_MATH_HOVER}).
   *
   * Legacy block math lands through {@link positionFromPoint}. Tree-backed
   * blocks instead use the node-agnostic structured-content hit-test contract,
   * so a click enters the exact stable row/field without storing a source
   * offset even transiently.
   */
  registerActions(bus: ActionBus): void {
    // At the leading edge, Backspace changes a display equation into the same
    // structured formula inline. This must run before the ordinary tree delete
    // handler, whose safe no-op at the root boundary would otherwise claim it.
    bus.registerState(
      DELETE_BACKWARD,
      (state) => demoteActiveStructuredMathBlock(state),
      120,
    );
    // Structured display equations claim editing/navigation before the legacy
    // LaTeX char-run handlers. All mutations are generic `content_edit` ops;
    // inline MathMark remains on the compatibility path in this slice.
    bus.registerState(
      DELETE_BACKWARD,
      (state) => {
        const edited = backspaceActiveMathTree(state);
        if (edited) return edited;
        return ownsMathTreeMutation(state)
          ? { state, ops: [], handled: true }
          : undefined;
      },
      100,
    );
    // Word deletion has no structural definition yet. Route it through the
    // same one-unit tree controller for now: this is conservative and, most
    // importantly, can never fall through to slice a LaTeX command or brace in
    // the compatibility source.
    bus.registerState(
      DELETE_WORD_BACKWARD,
      (state) => {
        const edited = backspaceActiveMathTree(state);
        if (edited) return edited;
        return ownsMathTreeMutation(state)
          ? { state, ops: [], handled: true }
          : undefined;
      },
      100,
    );
    bus.registerState(
      INSERT_MATH_COMMAND,
      (state, { text, caretOffset }) =>
        insertActiveMathTreeCommand(state, text, caretOffset) ?? undefined,
      100,
    );
    bus.registerState(
      RESIZE_MATH_MATRIX,
      (state, { rows, cols }) =>
        resizeActiveMathTreeMatrix(state, rows, cols) ?? undefined,
      100,
    );
    bus.registerState(
      MOVE_CURSOR_LEFT,
      (state) =>
        moveActiveMathTreeCaret(state, "arrow-left") ??
        (hasActiveMathTreeCaret(state)
          ? exitActiveMathTreeHorizontally(state, "left")
          : undefined),
      100,
    );
    bus.registerState(
      MOVE_CURSOR_RIGHT,
      (state) =>
        moveActiveMathTreeCaret(state, "arrow-right") ??
        (hasActiveMathTreeCaret(state)
          ? exitActiveMathTreeHorizontally(state, "right")
          : undefined),
      100,
    );
    bus.registerState(
      MOVE_CONTENT_TAB,
      (state, { backward }) =>
        moveActiveMathTreeCaret(state, backward ? "shift-tab" : "tab") ??
        (hasActiveMathTreeCaret(state)
          ? { state, ops: [], handled: true }
          : undefined),
      100,
    );
    const moveVertical = (direction: "up" | "down") => (state: EditorState) =>
      moveActiveMathTreeCaretVertically(state, direction) ??
      (hasActiveMathTreeCaret(state)
        ? exitActiveMathTreeVertically(state, direction)
        : undefined);
    bus.registerState(MOVE_CURSOR_UP, moveVertical("up"), 100);
    bus.registerState(MOVE_CURSOR_DOWN, moveVertical("down"), 100);
    const extendVertical = (direction: "up" | "down") => (state: EditorState) =>
      extendActiveMathTreeSelectionVertically(state, direction) ??
      (hasActiveMathTreeCaret(state)
        ? { state, ops: [], handled: true as const }
        : undefined);
    bus.registerState(EXTEND_SELECTION_UP, extendVertical("up"), 100);
    bus.registerState(EXTEND_SELECTION_DOWN, extendVertical("down"), 100);
    const extendHorizontal =
      (direction: "left" | "right") => (state: EditorState) =>
        extendActiveMathTreeSelectionHorizontally(state, direction) ??
        (hasActiveMathTreeCaret(state)
          ? { state, ops: [], handled: true as const }
          : undefined);
    bus.registerState(EXTEND_SELECTION_LEFT, extendHorizontal("left"), 100);
    bus.registerState(EXTEND_SELECTION_RIGHT, extendHorizontal("right"), 100);
    bus.registerState(
      DELETE_FORWARD,
      (state) => {
        const edited = deleteForwardActiveMathTree(state);
        if (edited) return edited;
        return ownsMathTreeMutation(state)
          ? { state, ops: [], handled: true }
          : undefined;
      },
      100,
    );
    bus.registerState(
      DELETE_WORD_FORWARD,
      (state) => {
        const edited = deleteForwardActiveMathTree(state);
        if (edited) return edited;
        return ownsMathTreeMutation(state)
          ? { state, ops: [], handled: true }
          : undefined;
      },
      100,
    );

    // Backspace at the start of a display equation demotes the same node to a
    // paragraph and preserves its LaTeX as inline math. Claim DELETE_BACKWARD
    // directly rather than the cross-block join action so this also works when
    // the equation is the first visible block.
    bus.registerState(
      DELETE_BACKWARD,
      (state) => {
        const cursor = state.document.cursor;
        if (!cursor || cursor.position.textIndex !== 0) return;
        if (state.ui.composition) return;
        if (state.document.selection && !state.document.selection.isCollapsed) {
          return;
        }

        const blockIndex = cursor.position.blockIndex;
        const block = mathBlockAt(state, blockIndex);
        if (!block) return;
        if (getMathStructuredDocument(block)) {
          // A tree cannot be demoted by reusing its intentionally-empty legacy
          // char runs. Keep it intact until structural block conversion owns a
          // lossless tree→inline transaction.
          return { state, ops: [], handled: true };
        }

        const paragraph: Block = {
          id: block.id,
          orderKey: block.orderKey,
          type: "paragraph",
          charRuns: block.charRuns,
          formats: [],
        };
        invalidateBlockCache(paragraph);

        const blocks = [...state.document.page.blocks];
        blocks[blockIndex] = paragraph;
        let page = { ...state.document.page, blocks };
        const ops: Operation[] = [
          {
            op: "block_set",
            id: state.CRDTbinding.nextId(),
            clock: state.CRDTbinding.getClock(),
            pageId: state.CRDTbinding.pageId,
            blockId: block.id,
            field: "type",
            value: "paragraph",
          },
        ];

        const latexLength = getVisibleTextFromRuns(block.charRuns).length;
        if (latexLength > 0) {
          const marked = markCharsInRange(
            page,
            block.id,
            0,
            latexLength,
            { type: "math" },
            true,
            state.CRDTbinding,
          );
          page = marked.newPage;
          ops.push(marked.op);
          invalidateBlockCache(page.blocks[blockIndex]);
        }

        return {
          state: {
            ...state,
            document: { ...state.document, page },
          },
          ops,
          handled: true,
        };
      },
      50,
    );

    // Scope the first Ctrl/Cmd+A to the active equation. Once that exact range
    // is already selected, leave the action unclaimed so its normal default
    // expands to the whole document on the second press.
    bus.registerState(
      SELECT_ALL,
      (state) => {
        const selectedTree = selectActiveMathTree(state);
        if (selectedTree) return selectedTree;
        if (hasActiveMathTreeCaret(state)) return;
        const cursor = state.document.cursor;
        if (!cursor) return;
        const blockIndex = cursor.position.blockIndex;
        const block = mathBlockAt(state, blockIndex);
        if (!block) return;

        const length = mathBlockSource(block).length;
        const selection = state.document.selection;
        const alreadySelected =
          selection !== null &&
          selection.anchor.blockIndex === blockIndex &&
          selection.focus.blockIndex === blockIndex &&
          Math.min(selection.anchor.textIndex, selection.focus.textIndex) ===
            0 &&
          Math.max(selection.anchor.textIndex, selection.focus.textIndex) ===
            length;
        if (alreadySelected) return;

        return {
          state: selectMathRange(state, blockIndex, 0, length),
          ops: [],
          handled: true,
        };
      },
      50,
    );

    // A pointer double-click (desktop) / double-tap (touch) normally selects a
    // prose "word". LaTeX source words are the wrong abstraction here (`frac`
    // without its slash/arguments, for example), so claim BOTH gestures for block
    // equations and select the construct under the pointer, whole, instead: any
    // glyph of a fraction's numerator highlights the entire `\frac`, a script base
    // the whole `x^{2}`, while a lone top-level token (`\alpha`, a bare `a`) selects
    // itself. `mathUnitAt` resolves both sides of the hit-test boundary and prefers
    // the construct, so clicking a numerator glyph never falls back to a single
    // source character. One handler, registered for the mouse and touch actions.
    const selectMathWord: StateHandler<{
      position: Position;
      range?: { start: number; end: number };
    }> = (state, { position, range }) => {
      const block = mathBlockAt(state, position.blockIndex);
      if (!block) return;
      // Prefer a range the caller resolved from the tap POINT — it lands on the
      // exact atom the finger is over, so a small operator (`+`/`-`/`=`) between
      // constructs is selectable at all. Fall back to the offset-based unit when
      // no point was resolved (e.g. a keyboard-driven word select).
      const latex = mathBlockSource(block);
      const unit = range ?? mathUnitAt(latex, position.textIndex);
      if (!unit) return { state, ops: [], handled: true };

      return {
        state: selectMathRange(
          state,
          position.blockIndex,
          unit.start,
          unit.end,
        ),
        ops: [],
        handled: true,
      };
    };
    bus.registerState(SELECT_WORD_AT_POINT, selectMathWord, 50);
    bus.registerState(TAP_SELECT_WORD, selectMathWord, 50);

    bus.registerState(
      POINTER_MOVE,
      (state, { textPosition, blockUnderPoint, canvasX, viewport }) => {
        // Readonly documents never highlight math on hover — neither the
        // full-block backdrop nor an inline chip (which would also flip the
        // pointer cursor). This handler is the sole writer of both hover slots,
        // so simply leaving them untouched keeps them null in a readonly editor.
        if (state.ui.isReadonlyBase) return { state, ops: [] };
        // Whole-block hover: the pointer is genuinely over a (now textual) math
        // block. Gate on `blockUnderPoint` (row-exact), NOT `textPosition`
        // (which clamps to the last block), so hovering the empty space below a
        // trailing equation doesn't light it. `blockUnderPoint` only resolves the
        // vertical band, so also require the pointer to be horizontally inside the
        // content column — the same rect the backdrop fills — so hovering the page
        // margins beside the equation doesn't light it either.
        const styles = getEditorStyles(state);
        const withinContentColumn =
          canvasX >= styles.canvas.paddingLeft &&
          canvasX < viewport.width - styles.canvas.paddingRight;
        const mathBlockIndex =
          withinContentColumn &&
          blockUnderPoint !== null &&
          mathBlockAt(state, blockUnderPoint) !== null
            ? blockUnderPoint
            : null;
        state = state.actionBus.dispatchState(SET_MATH_BLOCK_HOVER, state, {
          blockIndex: mathBlockIndex,
        }).state;

        // Inline-math chip hover — only when not over a block equation.
        let inlineMathHover: InlineMathHover | null = null;
        if (mathBlockIndex === null && textPosition) {
          const inlineMath = getInlineMathAtPosition(
            textPosition.blockIndex,
            textPosition.textIndex,
            state,
            "inside",
            { x: canvasX, viewport },
          );
          if (inlineMath) {
            inlineMathHover = {
              blockIndex: textPosition.blockIndex,
              startIndex: inlineMath.startIndex,
              endIndex: inlineMath.endIndex,
            };
          }
        }
        return {
          state: state.actionBus.dispatchState(SET_INLINE_MATH_HOVER, state, {
            hover: inlineMathHover,
          }).state,
          ops: [],
        };
      },
      0,
    );

    // Enter in a block equation must NOT split the LaTeX at the caret (that tears
    // the formula and reads as deleting it). Instead it finalizes the equation
    // and starts a fresh paragraph below — the same exit an image/line gives on
    // Enter. Claims SPLIT_BLOCK only for math blocks; else observes and passes
    // through to the default block-split (mirrors CodeNode claiming Enter).
    bus.registerState(
      SPLIT_BLOCK,
      (state) => {
        const cursor = state.document.cursor;
        const contentPoint = state.document.contentSelection?.focus;
        const blockIndex = cursor
          ? cursor.position.blockIndex
          : contentPoint
            ? findBlockIndex(state.document.page, contentPoint.blockId)
            : -1;
        if (blockIndex < 0) return;
        const block = mathBlockAt(state, blockIndex);
        if (!block) return;

        const page = state.document.page;
        const newParagraphId = state.CRDTbinding.nextId();
        const orderKey = orderKeyAfter(page.blocks, block.id);
        const ops: Operation[] = [
          {
            op: "block_insert",
            id: state.CRDTbinding.nextId(),
            clock: state.CRDTbinding.getClock(),
            pageId: state.CRDTbinding.pageId,
            orderKey,
            blockId: newParagraphId,
            blockType: "paragraph",
          },
        ];
        // Replay the op so the paragraph lands where every replica sorts it
        // (a tombstone tied on this block's orderKey shifts the position),
        // then place the caret by id instead of assuming blockIndex + 1.
        const newPage = applyOps(page, ops, state.schema);
        let next: EditorState = {
          ...state,
          document: { ...state.document, page: newPage },
        };
        next = clearSelection(next);
        const paragraphIndex = findBlockIndex(newPage, newParagraphId);
        next = moveCursorToPosition(
          next,
          paragraphIndex !== -1 ? paragraphIndex : blockIndex + 1,
          0,
        );
        return { state: next, ops, handled: true };
      },
      0,
    );

    // Post-insert normalization (the *effect* half of the caret/edit seam, the
    // counterpart to the pure queries on `edit`). After a keystroke settles, fill
    // an incomplete construct it just completed (`\frac` → `\frac{}{}`, caret to
    // the numerator) and arm caret scratch for an in-progress command (`\in`
    // rendered literally until the caret moves). One observer covers BOTH a block
    // equation and an inline chip — `normalizeMathInput` resolves which (or
    // neither) from the block + caret and no-ops on non-math content — so this is
    // the single home for what used to be split between this node's and MathMark's
    // `materializeAfterInput`/`armCaretScratch`. Observes (no `handled`) so it
    // composes with any other node/mark's normalizer.
    bus.registerState(TEXT_INPUTTED, (state, { blockIndex, textIndex }) =>
      normalizeMathInput(state, blockIndex, textIndex),
    );

    // The delete-side counterpart: after the plain text separating two inline
    // chips is removed, fuse the now-adjacent chips back into one formula. The
    // split half lives in `normalizeMathInput` above (TEXT_INPUTTED); both keep
    // inline math's "a space is a chip boundary" model consistent across edits.
    // A block equation has no chip spans, so it also gets the direct fusion guard
    // below: a delete that welds a command onto a following letter (`\int_{}a` →
    // `\inta`) gets its separator space back so it never renders as raw source.
    bus.registerState(CONTENT_DELETED, (state, { blockIndex, textIndex }) => {
      const merged = mergeInlineMath(state, blockIndex);
      const separated = separateBlockMath(merged.state, blockIndex, textIndex);
      let next = separated.state;
      const ops: Operation[] = [...merged.ops, ...separated.ops];
      // Auto-heal brace corruption the same way the input path does: a delete that
      // left an unclosed `{` (or one that landed in an already-imbalanced block)
      // regains the caret stop past the construct instead of trapping every
      // trailing offset inside the open group, and a committed stray `}` is escaped
      // to `\}` so a `$$}$$`-style dead cell becomes editable the moment it is
      // changed. Idempotent, so brace-clean content no-ops. Runs on the caret's own
      // position so a chip is resolved from it.
      const balanceBlock = next.document.page.blocks[blockIndex];
      const bal =
        balanceBlock && !balanceBlock.deleted
          ? mathHealAfterInput(balanceBlock, textIndex)
          : null;
      if (bal && bal.inserts.length > 0) {
        next = applyMathInserts(
          next,
          balanceBlock.id,
          blockIndex,
          bal,
          ops,
        ).state;
      }
      // Re-arm command-entry scratch when the delete backed into a command still
      // being typed (`\fr` ⌫ → `\f`) — the caret move cleared it. Editing a
      // command by deletion is still editing it: without the flag the residue
      // parses as committed source, and a residue left as a bare `\` merges with
      // a following structural char (`\frac{J\|}{K}` ⌫ → `\}` steals the frac's
      // closing brace and the whole formula de-structures). Mirrors the arming
      // in `normalizeMathInput`; a complete, non-growable command never arms.
      const block = next.document.page.blocks[blockIndex];
      const scratch =
        block && !block.deleted ? mathArmScratch(block, textIndex) : null;
      if (scratch) {
        next = { ...next, ui: { ...next.ui, caretScratch: scratch } };
      }
      return { state: next, ops };
    });
  }
}

/** The inline-math mark — applied to fuse chips, removed over a space to split. */
const INLINE_MATH_MARK: Mark = { type: "math" };

/** Select `[from, to)` within one math block and remember its gesture boundary. */
function selectMathRange(
  state: EditorState,
  blockIndex: number,
  from: number,
  to: number,
): EditorState {
  const start: Position = { blockIndex, textIndex: from };
  const end: Position = { blockIndex, textIndex: to };
  let next = moveCursorToPosition(state, blockIndex, to);
  next = {
    ...next,
    document: {
      ...next.document,
      selection: {
        anchor: start,
        focus: end,
        isForward: true,
        isCollapsed: false,
        lastUpdate: Date.now(),
        initialBoundary: { start, end },
      },
    },
  };
  return updateMode(next, "select");
}

/**
 * Apply a math content plan (`{ inserts, caret, markRange? }` from
 * {@link mathHealAfterInput} / {@link mathMaterializeAfterInput}) as real CRDT
 * ops: splice each insert in right-to-left (so an earlier `at` stays valid as
 * later inserts shift text), re-mark the grown chip when a `markRange` is given
 * (an inline chip's new braces land at its right edge, outside the math mark),
 * then move the caret to the plan's final position. Pushes the ops onto `ops` and
 * returns the updated state plus the settled caret. Shared by the balance and
 * materialize steps, which apply identically.
 */
function applyMathInserts(
  state: EditorState,
  blockId: string,
  blockIndex: number,
  plan: ContentMaterialization,
  ops: Operation[],
): { state: EditorState; caret: number } {
  let page = state.document.page;
  for (const ins of [...plan.inserts].sort((a, b) => b.at - a.at)) {
    if (ins.text.length === 0) continue; // empty placeholder = nothing to insert
    const { newPage, op } = insertCharsAtPosition(
      page,
      blockId,
      ins.at,
      ins.text,
      state.CRDTbinding,
    );
    page = newPage;
    ops.push(op);
  }
  if (plan.markRange) {
    const { newPage, op } = markCharsInRange(
      page,
      blockId,
      plan.markRange.from,
      plan.markRange.to,
      INLINE_MATH_MARK,
      true,
      state.CRDTbinding,
    );
    page = newPage;
    ops.push(op);
  }
  invalidateBlockCache(page.blocks[blockIndex]);
  let next: EditorState = { ...state, document: { ...state.document, page } };
  next = moveCursorToPosition(next, blockIndex, plan.caret, true);
  return { state: next, caret: plan.caret };
}

/**
 * Materialize an incomplete math construct, then arm caret-anchored scratch,
 * after an edit landed the caret at `(blockIndex, textIndex)` — the body of
 * MathNode's TEXT_INPUTTED observer (covering block equations AND inline chips,
 * since the shared math model resolves either from the block + caret). The
 * placeholder braces are inserted as real CRDT ops, returned in the threaded
 * `{ state, ops }` so the caller folds them into the same edit (one undo entry,
 * consistent across collaborators). A no-op — state unchanged, no ops — unless
 * the caret sits in math content with something to fill, so it's safe to run on
 * every keystroke regardless of block type.
 */
function normalizeMathInput(
  state: EditorState,
  blockIndex: number,
  textIndex: number,
): StateResult {
  const block = state.document.page.blocks[blockIndex];
  if (!block || block.deleted) return { state, ops: [] };

  let next = state;
  const ops: Operation[] = [];
  let caret = textIndex;

  // A non-space char typed at a chip's outer edge counts as inside it: re-mark
  // the chip to swallow the char so typing keeps extending the same formula
  // (`\oint`+`x` first gets a separator so it stays `\oint x`, never `\ointx`,
  // and a brace gets its escaping `\` so it joins as the literal `\{`). A
  // space at an edge leaves the chip — it never reaches here as a join. This runs
  // before materialize so a command completed at the edge (`\fra`+`c`) is joined
  // first, then its `\frac{}{}` placeholder fills in as usual. The fallback
  // covers the one-keystroke-later repair: a digit typed right after an edge
  // `.`/`,` re-marks the chip to absorb both — the punctuation the edge join
  // ejected as prose turned out to be part of a number (`$3$.` + `1` → `$3.1$`).
  const proposedJoin =
    mathJoinAtEdgeAfterInput(block, caret) ??
    mathAbsorbNumericPunctuationAfterInput(block, caret);
  // An attached mark's chars are only a compatibility projection. The legacy
  // edge-join normalizer re-marks with `{ type: "math" }`, which would replace
  // its persisted contentId and detach the canonical tree. Keep boundary input
  // as adjacent prose; entering the mark routes edits through its tree instead.
  const join =
    proposedJoin &&
    !rangeIntersectsStructuredMark(
      block,
      proposedJoin.from,
      proposedJoin.to,
      state.schema,
      "math",
    )
      ? proposedJoin
      : null;
  if (join) {
    let page = next.document.page;
    let to = join.to;
    if (join.insert) {
      const ins = insertCharsAtPosition(
        page,
        block.id,
        join.insert.at,
        join.insert.text,
        next.CRDTbinding,
      );
      page = ins.newPage;
      ops.push(ins.op);
      to += join.insert.text.length;
      caret += join.insert.text.length;
    }
    const marked = markCharsInRange(
      page,
      block.id,
      join.from,
      to,
      INLINE_MATH_MARK,
      true,
      next.CRDTbinding,
    );
    page = marked.newPage;
    ops.push(marked.op);
    invalidateBlockCache(page.blocks[blockIndex]);
    next = { ...next, document: { ...next.document, page } };
    next = moveCursorToPosition(next, blockIndex, caret, true);
  }

  // Auto-heal brace corruption BEFORE materializing, so the materializer works on
  // healed source. Both directions of imbalance only ever come from pasted /
  // imported / op-log LaTeX — typed braces are escaped and materialization inserts
  // balanced pairs: an unclosed `{` makes its group run to the source end,
  // swallowing every trailing offset so no caret can sit after the construct
  // (appending the missing `}` restores that exit), and a stray `}` is escaped to
  // `\}` so a `$$}$$`-style dead cell gains real caret stops on this very edit.
  // Render-neutral and idempotent, so it no-ops on the source normal typing produces.
  const balanceBlock = next.document.page.blocks[blockIndex];
  const bal =
    balanceBlock && !balanceBlock.deleted
      ? mathHealAfterInput(balanceBlock, caret)
      : null;
  if (bal && bal.inserts.length > 0) {
    const applied = applyMathInserts(next, block.id, blockIndex, bal, ops);
    next = applied.state;
    caret = applied.caret;
  }

  const materializeBlock = next.document.page.blocks[blockIndex];
  const mat =
    materializeBlock && !materializeBlock.deleted
      ? mathMaterializeAfterInput(materializeBlock, caret)
      : null;
  if (mat && mat.inserts.length > 0) {
    const applied = applyMathInserts(next, block.id, blockIndex, mat, ops);
    next = applied.state;
    caret = applied.caret;
  }

  // A space just typed inside an inline chip breaks it in two: strip the "math"
  // mark from that one space (which splits the run's span — see the reducer's
  // format-removal path), leaving two chips with a plain space between. No-op
  // for a block equation, a non-space keystroke, or a space inside a construct.
  const editedBlock = next.document.page.blocks[blockIndex];
  const split =
    editedBlock && !editedBlock.deleted
      ? mathSplitAfterInput(editedBlock, caret)
      : null;
  if (split) {
    const { newPage, op } = markCharsInRange(
      next.document.page,
      block.id,
      split.from,
      split.to,
      INLINE_MATH_MARK,
      false,
      next.CRDTbinding,
    );
    invalidateBlockCache(newPage.blocks[blockIndex]);
    next = { ...next, document: { ...next.document, page: newPage } };
    ops.push(op);
  } else {
    // A space that didn't split a chip but landed *inside* a formula (a block
    // equation, or an inline chip's construct like `\frac{a }{b}`) is dead LaTeX
    // — math mode collapses it, so drop it instead of saving a meaningless space.
    // Kept only when it's a real command separator (`\sin x`) or a text-mode
    // space (`\text{a b}`); see mathRedundantSpaceAfterInput. The caret steps
    // back onto where the space was so the next keystroke continues in place.
    const redundant =
      editedBlock && !editedBlock.deleted
        ? mathRedundantSpaceAfterInput(editedBlock, caret)
        : null;
    if (redundant) {
      const { newPage, op } = deleteCharsInRange(
        next.document.page,
        block.id,
        redundant.from,
        redundant.to,
        next.CRDTbinding,
      );
      invalidateBlockCache(newPage.blocks[blockIndex]);
      next = { ...next, document: { ...next.document, page: newPage } };
      ops.push(op);
      caret = redundant.from;
      next = moveCursorToPosition(next, blockIndex, caret, true);
    }
  }

  // Drop the command-entry separator space once a command char has landed in
  // front of it (`\frac{\a| }{}` → `\frac{\a|}{}`), so a completed command never
  // persists the `\ ` that kept the just-typed `\` off the slot's brace. Runs on
  // any keystroke — the trigger is a letter, not a space — and only removes a
  // parse-neutral space wedged between the caret and a `{`/`}` (see
  // mathRedundantSeparatorAfterInput), so it never disturbs real spacing.
  const separatorBlock = next.document.page.blocks[blockIndex];
  const separator =
    separatorBlock && !separatorBlock.deleted
      ? mathRedundantSeparatorAfterInput(separatorBlock, caret)
      : null;
  if (separator) {
    const { newPage, op } = deleteCharsInRange(
      next.document.page,
      block.id,
      separator.from,
      separator.to,
      next.CRDTbinding,
    );
    invalidateBlockCache(newPage.blocks[blockIndex]);
    next = { ...next, document: { ...next.document, page: newPage } };
    ops.push(op);
    // The caret sits before the removed space, so its index is unchanged.
    next = moveCursorToPosition(next, blockIndex, caret, true);
  }

  // Arm scratch against the post-materialize content at the (possibly moved) caret.
  const scratchBlock = next.document.page.blocks[blockIndex];
  const scratch =
    scratchBlock && !scratchBlock.deleted
      ? mathArmScratch(scratchBlock, caret)
      : null;
  if (scratch) {
    next = { ...next, ui: { ...next.ui, caretScratch: scratch } };
  }
  return { state: next, ops };
}

/**
 * Body of MathNode's CONTENT_DELETED observer: when a deletion left inline chips
 * touching (the text between them is gone), re-apply the "math" mark across each
 * adjacent run so they merge into one formula — the inverse of the space-split in
 * {@link normalizeMathInput}. A no-op (state unchanged, no ops) unless something
 * is adjacent, so it's safe to run after every delete regardless of block type.
 */
function mergeInlineMath(state: EditorState, blockIndex: number): StateResult {
  const block = state.document.page.blocks[blockIndex];
  if (!block || block.deleted) return { state, ops: [] };

  const plans = mathMergeAfterDelete(block)?.filter(
    (plan) =>
      !rangeIntersectsStructuredMark(
        block,
        plan.from,
        plan.to,
        state.schema,
        "math",
      ),
  );
  if (!plans || plans.length === 0) return { state, ops: [] };

  const ops: Operation[] = [];
  let page = state.document.page;
  // Apply plans right-to-left so an earlier plan's positions stay valid across
  // the separator inserts a later (higher-index) plan makes.
  for (const plan of [...plans].reverse()) {
    let to = plan.to;
    // Insert each separator space right-to-left, then extend the marked range to
    // cover them: a control word fused to a following letter (`\sin`⎵`x`) gets a
    // space back so the merged chip stays valid LaTeX (`\sin x`, never `\sinx`).
    for (const at of [...plan.separatorsAt].sort((a, b) => b - a)) {
      const ins = insertCharsAtPosition(
        page,
        block.id,
        at,
        " ",
        state.CRDTbinding,
      );
      page = ins.newPage;
      ops.push(ins.op);
      to += 1;
    }
    const { newPage, op } = markCharsInRange(
      page,
      block.id,
      plan.from,
      to,
      INLINE_MATH_MARK,
      true,
      state.CRDTbinding,
    );
    page = newPage;
    ops.push(op);
  }
  invalidateBlockCache(page.blocks[blockIndex]);
  return {
    state: { ...state, document: { ...state.document, page } },
    ops,
  };
}

/**
 * Block-equation counterpart of {@link mergeInlineMath}: after a delete welds a
 * control word onto a following letter (backspacing the empty subscript in
 * `\int_{}a` leaves `\inta`, one unknown command rendered as raw red source),
 * reinsert the command-separator space so the two stay distinct atoms (`\int a`).
 * `caret` is the post-delete caret offset (the weld point). A no-op unless a weld
 * actually happened, so it's safe to run after every delete. The caret is left
 * where the delete put it — just after the command, before the reinserted space.
 */
function separateBlockMath(
  state: EditorState,
  blockIndex: number,
  caret: number,
): StateResult {
  const block = state.document.page.blocks[blockIndex];
  if (!block || block.deleted) return { state, ops: [] };

  const at = mathSeparatorAfterDelete(block, caret);
  if (at === null) return { state, ops: [] };

  const { newPage, op } = insertCharsAtPosition(
    state.document.page,
    block.id,
    at,
    " ",
    state.CRDTbinding,
  );
  invalidateBlockCache(newPage.blocks[blockIndex]);
  return {
    state: { ...state, document: { ...state.document, page: newPage } },
    ops: [op],
  };
}

// ─── Math actions ────────────────────────────────────────────────────────────
//
// The math-specific click/hover actions live with the node they act on. The
// handler in `mouseEvents.ts` resolves the hit (clicked chip range, hovered
// block index) and dispatches these via `state.actionBus.dispatchState(...)`.
// All are pure — they touch overlay/hover UI state and emit no ops.

/** An inline-math chip's highlight range (engine-owned hover state). */
export interface InlineMathHover {
  blockIndex: number;
  startIndex: number;
  endIndex: number;
}

/** Set or clear the hovered block-math index (full-block backdrop). Pure, no ops. */
export const SET_MATH_BLOCK_HOVER = stateAction<{ blockIndex: number | null }>(
  "set-math-block-hover",
  (state, { blockIndex }) => {
    if (blockIndex === state.ui.hoveredMathBlockIndex)
      return { state, ops: [] };
    return {
      state: {
        ...state,
        ui: { ...state.ui, hoveredMathBlockIndex: blockIndex },
      },
      ops: [],
    };
  },
);

/**
 * Set or clear the inline-math chip hover highlight. The handler resolves the
 * chip range under the pointer (or `null`); this installs it only when the range
 * actually changed. Pure, no ops.
 */
export const SET_INLINE_MATH_HOVER = stateAction<{
  hover: InlineMathHover | null;
}>("set-inline-math-hover", (state, { hover }) => {
  const prev = state.ui.inlineMathHover;
  const changed =
    (prev === null) !== (hover === null) ||
    (prev &&
      hover &&
      (prev.blockIndex !== hover.blockIndex ||
        prev.startIndex !== hover.startIndex ||
        prev.endIndex !== hover.endIndex));
  if (!changed) return { state, ops: [] };
  return {
    state: { ...state, ui: { ...state.ui, inlineMathHover: hover } },
    ops: [],
  };
});

/**
 * Move the caret out of the inline-math chip `[startIndex, endIndex)` in
 * `blockId`, toward `direction`, and dismiss the chip's transient UI (any open
 * menu + the edit-highlight `inlineMathHover`). A pure cursor move — no ops.
 *
 * This is the inline-math counterpart to the caret-exit a host needs when the
 * user arrows/Escapes out of the WYSIWYG popover that mirrors the chip. It lives
 * here with the math node (not as a method on the generic editor handle) and is
 * fired by the host via `editor.dispatch(EXIT_INLINE_MATH, …)`, like
 * every other node/mark behavior. The caret is placed on the exiting edge and
 * then stepped one position further with the caret-model-aware
 * {@link moveCursorLeft} / {@link moveCursorRight}, so the chip's own snap can't
 * pull it back inside.
 */
export const EXIT_INLINE_MATH = stateAction<{
  blockId: string;
  startIndex: number;
  endIndex: number;
  direction: "left" | "right";
}>(
  "exit-inline-math",
  (state, { blockId, startIndex, endIndex, direction }) => {
    const blockIndex = state.document.page.blocks.findIndex(
      (b) => b.id === blockId,
    );
    if (blockIndex === -1) return { state, ops: [] };

    let next = closeActiveMenu(state);
    // Clear the edit highlight that lit the chip while the popover was open.
    if (next.ui.inlineMathHover) {
      next = { ...next, ui: { ...next.ui, inlineMathHover: null } };
    }

    // Place the caret on the side we're exiting toward, then step out one
    // position so the chip's snap doesn't pull us back inside.
    next =
      direction === "left"
        ? moveCursorLeft(moveCursorToPosition(next, blockIndex, startIndex))
        : moveCursorRight(moveCursorToPosition(next, blockIndex, endIndex));

    return { state: next, ops: [] };
  },
);
