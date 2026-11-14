/**
 * Mark — the extensible per-mark-type rendering contract (the inline analogue
 * of {@link Node}).
 *
 * A Mark is the *presentation* facet of an inline mark type: the visual channels
 * it contributes to a run of text (italic, color, a background chip, an
 * underline, a strike-through) plus an optional replacement renderer for marks
 * that draw their own glyphs instead of text (inline math). Like nodes, marks
 * know nothing about CRDT data shape or serialization — those are separate
 * facets (the mark's stored `attrs` ride the canvas-free `Mark` data type).
 *
 * Channels COMPOSE: when several marks land on the same run (bold + code + a
 * link), the renderer folds each mark's {@link MarkStyle} into one resolved
 * style and applies it once. Subclass {@link Mark} to add a mark, or extend an
 * existing mark and override `style()` to tweak its appearance:
 *
 *   class BrandLink extends LinkMark {
 *     style(c) { return { ...super.style(c), color: "#1db984" }; }
 *   }
 *
 * One instance per type, registered per-editor-instance in a
 * {@link MarkRegistry} (stored on `EditorState.marks`, never a module global —
 * the same multi-editor rule the node registry follows).
 *
 * NOTE: metric-affecting variants (bold weight, italic slant) live in the
 * styles-free {@link MarkMetrics} facet, not in {@link MarkStyle}, because they
 * change advance width — the measurement engine (wrap + caret geometry) reads
 * them without resolving a theme. The cosmetic channels in `style()` never
 * change advance width, so they stay render-only.
 */

import type { ActionBus } from "../../action-bus";
import type { MarkCodec } from "../../serlization/codecs/mark-codec";
import type { Mark as MarkData } from "../../serlization/loadPage";
import type {
  EditorState,
  EditorStyles,
  NodeOverlay,
  ViewportState,
} from "../../state-types";
import type {
  ContentPoint,
  ContentSelection,
} from "../../structured-selection";
import type { StructuredContentMap } from "../../sync/structured-content";
import type { CaretModel } from "../nodes/caret-model";

/**
 * One selection-wrap trigger: typing `char` while a non-collapsed text
 * selection is held applies this mark to the selection instead of replacing
 * it (see {@link Mark.selectionWrap}).
 */
export interface SelectionWrapTrigger {
  /** The typed character that triggers the wrap (e.g. `"*"`, `"$"`). */
  readonly char: string;
  /**
   * Orders marks sharing one `char` by their markdown delimiter count — the
   * count at which this mark appears alone (`*` = 1 → emphasis, `**` = 2 →
   * strong). Defaults to 1. Marks with distinct levels on the same char cycle
   * through the delimiter-count combinations on repeated presses.
   */
  readonly level?: number;
}

/** A rounded-rect background drawn behind a mark's glyphs (code, inline math). */
export interface MarkChipStyle {
  readonly color: string;
  readonly padding: number;
  readonly borderRadius: number;
}

/** An underline drawn beneath a mark's glyphs (link). */
export interface MarkUnderlineStyle {
  readonly color: string;
  readonly thickness: number;
}

/**
 * How one mark paints a run of text. When several marks share a run, the editor
 * combines them. The color of a mark with a background (like code) wins over a
 * plain `color`. Underline and strikethrough are drawn on top of the rest. None
 * of these change how wide the text is. Bold and italic do, so they go in
 * {@link MarkMetrics} instead.
 */
export interface MarkStyle {
  /** Glyph fill color (code chip color, link color, …). */
  readonly color?: string;
  /** Rounded-rect background behind the glyphs (code). */
  readonly background?: MarkChipStyle;
  /** Underline beneath the glyphs (link). */
  readonly underline?: MarkUnderlineStyle;
  /** Strike line through the glyphs. */
  readonly strikethrough?: boolean;
}

/**
 * The metric-affecting font variants one mark forces. Unlike the cosmetic
 * channels in {@link MarkStyle}, these change glyph advance width, so the
 * measurement engine (wrap + caret geometry) must apply them too — not just
 * paint. Theme-free, so the engine reads them without resolving styles. Folded
 * across a run's marks: any mark that sets a flag wins.
 */
export interface MarkMetrics {
  /** Heavier weight (`strong`). */
  readonly bold?: boolean;
  /** Oblique/italic slant (`emphasis`). */
  readonly italic?: boolean;
}

/**
 * What {@link Mark.style} receives: the editor's current styles and the stored
 * mark for the run being drawn, including its `attrs`.
 */
export interface MarkStyleCtx {
  readonly styles: EditorStyles;
  /** The stored mark for this run, carrying its `attrs` (e.g. a link's url). */
  readonly mark: MarkData;
}

/** Measured size of a replacement-rendered run (inline math). */
export interface MarkReplacementDims {
  readonly width: number;
  readonly height: number;
  readonly depthBelowBaseline: number;
}

/**
 * Where the collapsed caret sits relative to a replacement run, passed to
 * {@link MarkReplacement.measure}/`paint`/`caretRect` so the replacement can
 * adapt its rendering to in-progress editing (e.g. inline math keeps a command
 * still being typed as literal source rather than its resolved symbol). Both
 * fields are absent/false when the caret isn't in this run.
 */
export interface MarkReplacementEdit {
  /** Caret offset *within this run's text*, or undefined if the caret isn't in it. */
  readonly caretOffset?: number;
  /**
   * `true` while the user is typing a command at the caret. A half-typed
   * command should then show as its literal text, not its symbol. The flag is
   * set for the whole block, so only act on it when `caretOffset` is set.
   * `measure` and `paint` must make the same choice from this, or the reserved
   * width will not match what is drawn.
   */
  readonly editing?: boolean;
}

/** Caret geometry inside a replacement run, from {@link MarkReplacement.caretRect}. */
export interface MarkReplacementCaret {
  /** X from the run's left edge, CSS px. */
  readonly x: number;
  /** Caret top relative to the text baseline (negative = above), CSS px. */
  readonly top: number;
  /** Caret bottom relative to the text baseline (positive = below), CSS px. */
  readonly bottom: number;
  /**
   * Stand as tall as the text line the run sits on, ignoring `top`/`bottom` —
   * for a caret on the run's own row (a formula's main row), so it matches
   * the prose caret beside it. Only read from the nested-caret hook
   * ({@link MarkReplacement.contentCaretRect}).
   */
  readonly fillsLine?: boolean;
}

/**
 * One highlight rectangle for a selected sub-range inside a replacement run, from
 * {@link MarkReplacement.selectionRects}. The vertical analogue of
 * {@link MarkReplacementCaret}: geometry is relative to the run (x from the left
 * edge, top/bottom from the text baseline, +y down) so a sub-selection hugs the
 * selected glyphs' own row — a fraction's denominator highlights just the
 * denominator, not the whole formula's height.
 */
export interface MarkReplacementSelectionRect {
  /** X from the run's left edge, CSS px. */
  readonly x: number;
  /** Rect top relative to the text baseline (negative = above), CSS px. */
  readonly top: number;
  /** Rect bottom relative to the text baseline (positive = below), CSS px. */
  readonly bottom: number;
  /** Rect width, CSS px. */
  readonly width: number;
  /**
   * Fill the text line the run sits on, ignoring `top`/`bottom` — for a range
   * on the run's own row, so it reads as one band with selected prose. Only
   * read from the nested hook ({@link MarkReplacement.contentSelectionRects}).
   */
  readonly fillsLine?: boolean;
}

/**
 * What a mark receives when it draws its own content in place of the text, as
 * an inline formula does: the canvas context, the run's text, where to draw,
 * the measured size and the current styles. Passed to
 * {@link MarkReplacement.paint}.
 */
export interface MarkReplacementPaintCtx {
  readonly ctx: CanvasRenderingContext2D;
  /** The run's text (e.g. the LaTeX source for inline math). */
  readonly text: string;
  /** Pen x at the run start (its left edge LTR, right edge RTL). */
  readonly x: number;
  /** Text baseline y. */
  readonly y: number;
  readonly fontSize: number;
  readonly isRTL: boolean;
  /** Whether this run is the one the pointer is currently hovering. */
  readonly hovered: boolean;
  /** Size from {@link MarkReplacement.measure} (already computed by the caller). */
  readonly dims: MarkReplacementDims;
  readonly styles: EditorStyles;
  /** Caret position relative to this run (see {@link MarkReplacementEdit}). */
  readonly edit?: MarkReplacementEdit;
  /** Ask the renderer for another frame (e.g. after an async glyph decode). */
  readonly requestRedraw: () => void;
}

/** Persisted context available while resolving one replacement-mark run. */
export interface MarkReplacementSourceCtx {
  /** The stored mark for this exact run, including feature attrs/contentId. */
  readonly mark: MarkData;
  /** Supplemental structured attachments owned by the containing block. */
  readonly attachments: StructuredContentMap | undefined;
}

/**
 * What the caret and selection hooks of {@link MarkReplacement} receive for a
 * run whose content lives in a block attachment: the stored mark, the block's
 * attachments, the block id, and the part of the run being drawn. When the
 * editor is resolving a click or drag, it also says which pointer is used and
 * whether a finger is dragging.
 */
export interface MarkReplacementContentCtx extends MarkReplacementSourceCtx {
  readonly blockId: string;
  /**
   * The `start` and `end` offsets, in the run's full source, of the piece that
   * `text` holds. This matters when one run wraps across lines and is drawn in
   * pieces. Use it to keep the caret in the piece that holds it. Omitted means
   * `text` is the whole source.
   *
   * It is only used to place things on screen. Positions inside the run are
   * still {@link ContentPoint} values, not text offsets.
   */
  readonly sourceRange?: {
    readonly start: number;
    readonly end: number;
  };
  readonly pointerType?: "mouse" | "touch";
  readonly drag?: boolean;
  readonly previousPoint?: ContentPoint | null;
}

/**
 * Lets a mark draw its run itself instead of its text, the way inline math
 * draws a formula in place of the LaTeX. The run is sized by `measure` and
 * drawn by `paint`, and normal text styling is skipped.
 *
 * By default the caret and clicks treat the run as one unit and stop only at
 * its edges. Add `caretRect` and `hitTest` to let them go inside the drawn
 * content.
 */
export interface MarkReplacement {
  /**
   * Optional: the text to measure and draw for this run, when it differs from
   * the characters stored in the run (for example, a formula kept in a block
   * attachment). Omit it to use the run's own characters. It only changes what
   * is measured and drawn. Text positions still count the run's stored
   * characters.
   */
  source?(compatibilityText: string, c: MarkReplacementSourceCtx): string;
  /**
   * Optional: where to draw the caret at `point` inside this run, when the
   * run's content lives in a block attachment. Return `null` when the point is
   * not in the piece of the run given by `c.sourceRange`.
   */
  contentCaretRect?(
    text: string,
    fontSize: number,
    point: ContentPoint,
    c: MarkReplacementContentCtx,
  ): MarkReplacementCaret | null;
  /**
   * Optional: the selection inside this run at a point, when the run's content
   * lives in a block attachment. `localX` is from the run's left edge and
   * `localY` from the text baseline. Return `null` when the point does not land
   * on the run's content.
   */
  contentSelectionFromPoint?(
    text: string,
    fontSize: number,
    localX: number,
    localY: number,
    c: MarkReplacementContentCtx,
  ): ContentSelection | null;
  /**
   * Optional: highlight rectangles for a selection inside this run, when the
   * run's content lives in a block attachment. Works like
   * {@link MarkReplacement.contentCaretRect}, but for a range. Without it, a
   * range selected inside the run shows no highlight. Return `null` when the
   * selection is not in the piece of the run given by `c.sourceRange`.
   */
  contentSelectionRects?(
    text: string,
    fontSize: number,
    selection: ContentSelection,
    c: MarkReplacementContentCtx,
  ): MarkReplacementSelectionRect[] | null;
  /**
   * Size of the rendered run, or `null` if it can't render (caller falls back to
   * text). `edit` lets an in-progress token (`\in`) measure as its literal source
   * rather than its resolved symbol, so the reserved width matches what
   * {@link paint} draws while it's being typed.
   */
  measure(
    text: string,
    fontSize: number,
    edit?: MarkReplacementEdit,
  ): MarkReplacementDims | null;
  /**
   * Offsets in `text` where the line breaker may split this run across lines —
   * inline math's top-level operators and relations. Each slice is measured,
   * painted, and caret-mapped STANDALONE (see {@link MarkReplacementContentCtx.sourceRange}),
   * so an offset must cut the source into independently renderable pieces.
   *
   * Omit — or return nothing — to keep the run one unbreakable unit: it then
   * wraps whole and overflows its line when it cannot fit, like a long word.
   */
  breakpoints?(text: string, fontSize: number): readonly number[];
  paint(c: MarkReplacementPaintCtx): void;
  /**
   * Caret geometry for source `offset` within the run — x from the run's left
   * edge, top/bottom from the text baseline (+y down) — or `null` if it can't
   * place an interior caret (caller falls back to the run's boundary). Lets the
   * caret sit *inside* the rendered content (e.g. a math chip's subscript).
   */
  caretRect?(
    text: string,
    fontSize: number,
    offset: number,
    edit?: MarkReplacementEdit,
  ): MarkReplacementCaret | null;
  /**
   * Optional: the source offset nearest a point in the run, so a click can land
   * inside the drawn content. `localX` is from the run's left edge and `localY`
   * from the text baseline, with +y down. Omit it and a click lands only at the
   * run's edges.
   *
   * `drag` is set while a finger drags the caret with the magnifier. Then pick
   * the nearest stop in both directions, and stay on the current row until the
   * finger clearly leaves it, so a small wobble does not flip between a
   * formula's rows. `prevOffset` is the caret's current offset in this run, or
   * `null` when the caret is not in it. A plain tap leaves both unset.
   */
  hitTest?(
    text: string,
    fontSize: number,
    localX: number,
    localY: number,
    drag?: boolean,
    prevOffset?: number | null,
  ): number;
  /**
   * Highlight rectangles for a selected source sub-range `[start, end)` within
   * the run — the selection analogue of {@link caretRect}. Lets a sub-selection
   * hug the selected glyphs' own row (a fraction's denominator highlights just
   * the denominator) instead of spanning the run's full line box. Omit to keep
   * the run atomic for selection painting (the caller then fills the whole line
   * box across the run). Used only when the selection is confined to this run;
   * a selection that also covers surrounding text still fills the line box.
   */
  selectionRects?(
    text: string,
    fontSize: number,
    start: number,
    end: number,
    edit?: MarkReplacementEdit,
  ): MarkReplacementSelectionRect[];
}
/**
 * What {@link Mark.overlays} receives: the editor state, the viewport and the
 * current styles. A mark is not tied to one block, so it finds the run's
 * position and range in the active menu on `state`.
 */
export interface MarkOverlayCtx {
  readonly state: EditorState;
  readonly viewport: ViewportState;
  readonly styles: EditorStyles;
}

/**
 * Base class for how an inline mark looks and behaves on the canvas. Extend it,
 * give it a `type` and a `style()`, and pass an instance to {@link defineMark}
 * as `render`. Do not keep state on the instance. One instance can serve many
 * editors.
 *
 * ```ts
 * class HighlightMark extends Mark {
 *   readonly type = "highlight";
 *   style() {
 *     return { background: { color: "#fde68a", padding: 2, borderRadius: 3 } };
 *   }
 * }
 * const schema = baseSchema.extend({
 *   marks: [defineMark("highlight", { render: new HighlightMark() })],
 * });
 * ```
 */
export abstract class Mark {
  /** The mark type this renders (matches the stored `Mark.type`). */
  abstract readonly type: string;

  /**
   * How this mark paints its text: color, background, underline or strike. When
   * several marks share a run, their styles are combined (see
   * {@link MarkStyle}).
   */
  abstract style(c: MarkStyleCtx): MarkStyle;

  /**
   * Optional: font changes that change how wide the text is, such as bold or
   * italic. The editor uses them when it measures text, so line wrapping and
   * the caret match what is drawn. That is why they live here and not in
   * {@link MarkStyle}. When several marks share a run, any mark that sets a
   * flag turns it on. Omit it for a mark that does not change text width.
   */
  readonly metrics?: MarkMetrics;

  /**
   * Whether {@link ChangeApi | setMark(name)} with no options can toggle this
   * mark on and off. Defaults to `true`. Marks that need extra input, such as a
   * link's url, set `false`. For those, `setMark(name)` alone does nothing.
   * Apply them with attrs and a range, or through their own actions.
   */
  readonly togglable: boolean = true;

  /**
   * Optional: characters that wrap a selection in this mark when typed. Select
   * some text and type `*`, and the text turns italic instead of being
   * replaced. Each character means what it means in Markdown: `*` for emphasis,
   * a backtick for code, `$` for math.
   *
   * Marks can share a character at different `level`s, like emphasis (`*`,
   * level 1) and strong (`*`, level 2). Typing it again over the same selection
   * then steps through the Markdown meanings: one press is italic, two is bold,
   * three is both, and a fourth goes back to plain. A character only one mark
   * uses just toggles that mark (a backtick wraps the text as code, and a
   * backtick again unwraps it). Omit it for a mark with no typed character,
   * such as a link.
   *
   * The wrap only happens where the mark could be applied anyway: the schema
   * must allow the mark, and the block must accept formatting.
   */
  // Consumed generically by `wrapSelectionOnInput` (actions/wrap-selection),
  // gated by `DataSchema.isMarkAllowed` and the block's `hasFormats`
  // capability.
  readonly selectionWrap?: readonly SelectionWrapTrigger[];

  /** If set, this mark replaces glyph rendering for its run (inline math). */
  readonly replacement?: MarkReplacement;

  /**
   * Optional: how this mark is written to and read from Markdown and HTML. Set
   * it here or on {@link defineMark}, not both: if the two codecs differ,
   * building the schema throws an error. If neither has a codec, the mark stays
   * in the document but is dropped from Markdown and HTML export.
   */
  // Declared on the Mark so it is the single source of truth for the mark
  // type's facets; the canvas-free DataSchema reads it off the registered mark.
  readonly codec?: MarkCodec;

  /**
   * Optional: the host UI this mark wants on screen right now, such as an
   * inline editor for the run under the open menu. Works like `Node.overlays`.
   * Each overlay gives a key, its block id and a place (`rect`). The host maps
   * {@link NodeOverlay.key} to its own component and mounts it at `rect`.
   *
   * A mark is not tied to one block, so `editor.host.collectOverlays()` asks
   * each registered mark once. Read the run's block and range from the active
   * menu on `c.state`. Return `[]`, or leave the method out, for none.
   */
  overlays?(c: MarkOverlayCtx): readonly NodeOverlay[];

  /**
   * Optional: add this mark's action handlers. The editor calls it once, when
   * the editor is created, with that editor's own {@link ActionBus}. So
   * handlers never leak into another editor on the page. Works like
   * {@link Node.registerActions}.
   *
   * This is how a mark adds pointer or caret behavior. For example, the link
   * mark claims Ctrl/Cmd+click (`TEXT_CLICK`) to open the url, and watches
   * `POINTER_MOVE` to show its hover tooltip. A mark can watch `CURSOR_MOVED`
   * to react when an arrow key moves the caret across it.
   */
  registerActions?(bus: ActionBus): void;

  /**
   * Optional: makes this mark's runs act as one unit under the caret, like an
   * inline formula chip. The caret steps over the run instead of moving through
   * its characters. Works like {@link Node.caret}.
   *
   * Usually you only supply `caret.atomicSpans`, returning this mark's own runs
   * in the block. A mark with no such runs omits `caret`. To change the text
   * after an edit, such as filling in `\frac` as `\frac{}{}` once it is typed,
   * watch the `TEXT_INPUTTED` action in {@link Mark.registerActions}.
   */
  readonly caret?: CaretModel;

  /**
   * Optional: which way the local caret's edge flag points when the caret sits
   * on an edge of this mark's run — `"left"` or `"right"` toward the side typing
   * goes to, or `null` when the caret is not on one of this mark's edges.
   *
   * Flat marks (bold, italic, …) get this flag from the engine already. A mark
   * that owns its own caret stops (an inline formula, entered and left through
   * its own navigation) answers here instead, so its two stops at one screen
   * spot — inside and outside — are told apart the same way. Asked once per
   * registered mark each time the caret paints; keep it cheap.
   */
  caretEdgeFlag?(state: EditorState): "left" | "right" | null;
}

/**
 * The marks one editor can draw, looked up by mark type; the renderer asks it
 * how to style each marked run instead of checking mark names itself. Each
 * editor has its own registry (kept on its state as `marks`, not shared across
 * the page), so two editors can register different marks without affecting
 * each other. The mark-side twin of {@link NodeRegistry}.
 */
export class MarkRegistry {
  private readonly marks = new Map<string, Mark>();

  /** Register a mark under its `type`. Returns `this` for fluent chaining. */
  register(mark: Mark): this {
    this.marks.set(mark.type, mark);
    return this;
  }

  /** The mark for a type, or `undefined` if none is registered. */
  get(type: string): Mark | undefined {
    return this.marks.get(type);
  }

  /** Whether a mark is registered for this type. */
  has(type: string): boolean {
    return this.marks.has(type);
  }

  /** Every registered mark. */
  markList(): Mark[] {
    return [...this.marks.values()];
  }
}
