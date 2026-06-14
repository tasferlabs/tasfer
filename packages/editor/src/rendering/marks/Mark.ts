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
 * NOTE: `bold` is a styles-free flag rather than a {@link MarkStyle} channel,
 * because bold weight affects text *metrics* (caret/wrap geometry) — the
 * measurement engine reads it without resolving a theme. The cosmetic channels
 * in `style()` never change advance width, so they stay render-only.
 */

import type { Mark as MarkData } from "../../serlization/loadPage";
import type {
  EditorState,
  EditorStyles,
  NodeOverlay,
  ViewportState,
} from "../../state-types";

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
 * `italic`/`strikethrough`/`underline` are additive.
 */
export interface MarkStyle {
  readonly italic?: boolean;
  /** Glyph fill color (code chip color, link color, …). */
  readonly color?: string;
  /** Rounded-rect background behind the glyphs (code). */
  readonly background?: MarkChipStyle;
  /** Underline beneath the glyphs (link). */
  readonly underline?: MarkUnderlineStyle;
  /** Strike line through the glyphs. */
  readonly strikethrough?: boolean;
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
  /** Ask the renderer for another frame (e.g. after an async glyph decode). */
  readonly requestRedraw: () => void;
}

/**
 * A mark that REPLACES glyph rendering for its run — inline math draws a
 * rendered formula instead of the LaTeX characters. The run measures as an
 * atomic unit (`measure`) and paints itself (`paint`); the normal style/text
 * path is skipped for it.
 */
export interface MarkReplacement {
  /** Size of the rendered run, or `null` if it can't render (caller falls back to text). */
  measure(text: string, fontSize: number): MarkReplacementDims | null;
  paint(c: MarkReplacementPaintCtx): void;
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
   * Whether this mark renders its run bold. Metric-affecting (changes advance
   * width), so it's a styles-free flag the measurement engine can read without
   * a theme — not a {@link MarkStyle} channel.
   */
  readonly bold: boolean = false;

  /**
   * Whether `ChangeApi.toggleMark` may add/remove this mark directly.
   * Marks that need extra input to apply (a link's url, math's LaTeX) set
   * `false`; they're applied through their own dedicated commands instead.
   */
  readonly togglable: boolean = true;

  /** If set, this mark replaces glyph rendering for its run (inline math). */
  readonly replacement?: MarkReplacement;

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
   * If set, the host overlay key the engine opens when the user activates a run
   * of this mark (e.g. clicking an inline-math chip opens its editor). The engine
   * detects the activation and relays this key through `openOverlay` with the
   * run's range as `data`; it never names the overlay itself. Pair with
   * {@link overlays} to render it. Omit if the mark has no edit overlay.
   */
  readonly editOverlayKey?: string;
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
