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
 * The visual channels one mark contributes to a run. The renderer composes the
 * styles of every mark on the run (see the precedence notes in the renderer):
 * `background`/`color` from the chip-bearing mark win over a plain `color`;
 * `strikethrough`/`underline` are additive. These channels are render-only —
 * none of them change advance width. A variant that *does* (bold, italic)
 * belongs in {@link MarkMetrics} instead.
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
   * Whether caret-anchored scratch is armed at `caretOffset` — i.e. the user is
   * actively typing here, so an in-progress token should render literally instead
   * of resolving. `measure` and `paint` MUST derive identical geometry from this
   * so reserved width matches drawn glyphs.
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
}

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

/** Structured-caret context for a replacement run in one textual block. */
export interface MarkReplacementContentCtx extends MarkReplacementSourceCtx {
  readonly blockId: string;
  /**
   * Canonical-source range represented by the `text` argument for this visual
   * fragment. A replacement can use this projection to keep an identity-backed
   * nested caret in the fragment that owns it when one marked run wraps across
   * lines. Omitted means the text represents the complete replacement source.
   *
   * This is geometry metadata only: nested selection remains expressed as
   * stable {@link ContentPoint} identities rather than flattened text offsets.
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
 * A mark that REPLACES glyph rendering for its run — inline math draws a
 * rendered formula instead of the LaTeX characters. The run measures as an
 * atomic unit (`measure`) and paints itself (`paint`). It MAY additionally let
 * the caret descend into the rendered content (`caretRect`/`hitTest`) instead of
 * treating the run as one opaque advance; a replacement that omits those keeps
 * the atomic-boundary behavior. The normal style/text path is skipped for the run.
 */
export interface MarkReplacement {
  /**
   * Resolve the canonical source painted/measured for this run. Omit to use the
   * marked compatibility characters unchanged. The returned string affects
   * replacement geometry only; flat-text indices continue to address the
   * compatibility run, while structured caret hooks own attached content.
   */
  source?(compatibilityText: string, c: MarkReplacementSourceCtx): string;
  /** Stable nested caret geometry for an attached replacement run. */
  contentCaretRect?(
    text: string,
    fontSize: number,
    point: ContentPoint,
    c: MarkReplacementContentCtx,
  ): MarkReplacementCaret | null;
  /** Map a run-local point directly to an identity-bearing nested selection. */
  contentSelectionFromPoint?(
    text: string,
    fontSize: number,
    localX: number,
    localY: number,
    c: MarkReplacementContentCtx,
  ): ContentSelection | null;
  /**
   * Highlight rectangles for a nested (identity-bearing) selection held inside
   * this run — the selection analogue of {@link contentCaretRect}. The nested
   * selection deliberately clears the flat cursor/range, so without this seam a
   * range selected inside an attached run (e.g. a construct selected before
   * deletion) would have no visible highlight. Return `null` when the selection
   * doesn't resolve within the fragment described by `c.sourceRange`.
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
   * Source offset nearest a run-local point (`localX` from the left edge,
   * `localY` from the text baseline, +y down) — lets a click descend into the
   * rendered content. Omit to keep the run atomic for hit-testing.
   *
   * `drag` requests finger-drag (magnifier) resolution: nearest stop in 2-D with
   * row hysteresis, so a vertical drag descends smoothly between a math chip's
   * stacked rows without flipping on wobble. `prevOffset` is the caret's current
   * run-local offset (the hysteresis anchor), or null when the caret is not
   * already inside this run. A precise tap leaves both unset.
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
  /**
   * The word/token sub-range `[start, end)` a double-click / double-tap at
   * run-local source `offset` selects — the replacement's own notion of "the thing
   * under the caret". Inline math returns the whole construct the offset sits in (a
   * script `x^{2}`, a `\frac`, a `\sqrt{…}`), so a double-tap grabs that construct
   * rather than the entire chip. Return `null` (or omit) to fall back to selecting
   * the whole run. Offsets are run-local (a chip's visible chars ARE its LaTeX).
   */
  wordRangeAt?(
    text: string,
    offset: number,
  ): { start: number; end: number } | null;
  /**
   * The double-click / double-tap sub-range `[start, end)`, resolved from a POINT
   * (`localX` from the run's left edge, `localY` from the text baseline, +y down)
   * rather than a source offset — the point-based counterpart to
   * {@link wordRangeAt}. This is what makes an ATOMIC replacement selectable: an
   * inline-math command like `\det` has caret stops only at its edges, so a tap
   * resolves to a run boundary and the offset path can't see it, but the glyphs
   * carry the command's span, so the point lands inside. Return `null` to let the
   * caller fall back to the offset path. Offsets in the returned range are
   * run-local.
   */
  wordRangeFromPoint?(
    text: string,
    fontSize: number,
    localX: number,
    localY: number,
    edit?: MarkReplacementEdit,
  ): { start: number; end: number } | null;
  /**
   * Offsets *within* `text` where the run may be line-broken when it is too wide
   * to fit — letting the line-wrapper flow a long run across several lines instead
   * of treating it as one unbreakable advance. Each offset splits the run into
   * pieces that each render standalone via {@link paint} (the wrapper slices the
   * run's chars at these points and renders each line's slice on its own). Return
   * `[]` (or omit the method) to keep the run atomic — it then wraps only as a
   * whole unit and overflows if it cannot fit. For inline math these are the
   * formula's top-level operator/relation breaks.
   */
  breakpoints?(text: string, fontSize: number): number[];
}

/**
 * Everything a mark needs to declare its host-overlay slots — the inline
 * analogue of `NodeRegionCtx`, minus the per-block geometry. A mark isn't tied
 * to one block, so it reads the run's position/range off the active menu in
 * {@link MarkOverlayCtx.state} rather than from a block origin.
 */
export interface MarkOverlayCtx {
  readonly state: EditorState;
  readonly viewport: ViewportState;
  readonly styles: EditorStyles;
}

/**
 * Base class for an inline mark's on-canvas behavior. One instance per type,
 * registered in a {@link MarkRegistry}. Stateless — shareable across editors.
 */
export abstract class Mark {
  /** The mark type this renders (matches the stored `Mark.type`). */
  abstract readonly type: string;

  /** Visual channels this mark contributes; composed across a run's marks. */
  abstract style(c: MarkStyleCtx): MarkStyle;

  /**
   * Optional: the metric-affecting font variants this mark forces (bold weight,
   * italic slant). Read by the measurement engine without a theme so wrap and
   * caret geometry stay in sync with paint — the reason these live here and not
   * as cosmetic {@link MarkStyle} channels (those never change advance width).
   * Folded across a run (any flag set wins). Omit for a metric-neutral mark.
   */
  readonly metrics?: MarkMetrics;

  /**
   * Whether `ChangeApi.toggleMark` may add/remove this mark directly.
   * Marks that need extra input to apply (a link's url, math's LaTeX) set
   * `false`; they're applied through their own dedicated actions instead.
   */
  readonly togglable: boolean = true;

  /**
   * Optional: the typed-delimiter triggers that apply this mark over a held
   * selection — VS Code-style auto-surround with markdown semantics. When a
   * non-collapsed text selection is active and the user types a trigger char,
   * the editor applies this mark to the selection instead of replacing it,
   * mirroring what the delimiter means in markdown source (`*` → emphasis,
   * `` ` `` → code, `$` → math).
   *
   * Marks may share a trigger char at different `level`s (emphasis `*`/1,
   * strong `*`/2); repeated presses over the held selection then walk the
   * delimiter-count combinations exactly as markdown reads them — `*` →
   * *emphasis*, `**` → **strong**, `***` → both, a fourth press back to
   * plain. A single-mark trigger is a plain toggle (`$` wraps as math, `$`
   * again unwraps). Omit for a mark with no typed delimiter (link).
   *
   * Consumed generically by `wrapSelectionOnInput` (actions/wrap-selection),
   * gated per document by `DataSchema.isMarkAllowed` and per block by the
   * block's `hasFormats` capability, like every other mark application.
   */
  readonly selectionWrap?: readonly SelectionWrapTrigger[];

  /** If set, this mark replaces glyph rendering for its run (inline math). */
  readonly replacement?: MarkReplacement;

  /**
   * Markdown/HTML serialization facet — how this mark round-trips on export.
   * Declared here so the Mark is the single source of truth for ALL of a mark
   * type's facets (the inline analogue of a Node owning its codec); the
   * canvas-free DataSchema reads it off the registered mark. Omit for a mark
   * that survives only via the CRDT (it's dropped from markdown/HTML export).
   */
  readonly codec?: MarkCodec;

  /**
   * Optional: the host-rendered overlays this mark wants right now (an inline
   * editor for the run under the active menu, …), derived from the current UI
   * state. The inline analogue of `Node.overlays`: identity + geometry only —
   * the host maps {@link NodeOverlay.key} to a component and mounts it at the
   * returned `rect`. Marks aren't tied to one block, so this is consulted once
   * per registered mark by `editor.collectOverlays()`; read the run's
   * block/range/position off `c.state`'s active menu. Return `[]` (or omit) for
   * none.
   */
  overlays?(c: MarkOverlayCtx): readonly NodeOverlay[];

  /**
   * Optional: register this mark's action-bus handlers for the instance. Called
   * once at mount with the per-instance {@link ActionBus} (the inline analogue of
   * {@link import("../nodes/Node").Node.registerActions}). This is how a mark
   * contributes pointer/cursor behavior — LinkMark claims Ctrl/Cmd+click
   * (`TEXT_CLICK`) to open the URL and observes `POINTER_MOVE` to drive its hover
   * tooltip; MathMark observes `CURSOR_MOVED` to open the inline-math editor when
   * the caret crosses a chip. The registry is per-editor-instance, so handlers
   * never leak across editors on the same page.
   */
  registerActions?(bus: ActionBus): void;

  /**
   * Optional: how this mark's run behaves under the caret when it is **atomic**
   * (an inline-math chip, whose visible chars ARE its source) — the inline
   * analogue of {@link import("../nodes/Node").Node.caret}. The common case is
   * `caret.atomicSpans` returning the mark's own runs; the mark inspects the
   * block's runs of its own type to answer per-run. A mark with no atomic runs
   * omits `caret`. The *effect* half (materializing a construct after an edit)
   * is observed as the `TEXT_INPUTTED` action in {@link registerActions}.
   */
  readonly caret?: CaretModel;
}

// ---------------------------------------------------------------------------
// Mark registry — the per-editor-instance dispatch table that replaces the
// hardcoded `f.type === "strong" | "code" | "link" | …` branches in the
// renderer. Mirrors NodeRegistry: per instance (stored on EditorState.marks),
// NOT a module global, so two editors on a page can register different mark
// sets without clobbering each other.
// ---------------------------------------------------------------------------

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
