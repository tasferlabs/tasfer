/**
 * BlockView — extensible per-block rendering contract (proof-of-concept).
 *
 * This is the *view* facet of a block definition: layout, paint, and hit-test.
 * It deliberately knows nothing about CRDT data shape, validation, or
 * serialization — those are separate facets (BlockSchema lives next to the sync
 * layer so the node-only fuzz harness never imports canvas types).
 *
 * The core contract is three methods built around a single shared step:
 *
 *   layout()  — wrap/measure once, producing height + line boxes (cacheable)
 *   paint()   — consume the precomputed layout, draw to canvas
 *   hitTest() — map a local point to a caret Position using the layout
 *
 * Splitting layout from paint removes the current duplication where
 * renderBlock() and calculateBlockHeight() each re-wrap the same text.
 */

import type { Block } from "../../serlization/loadPage";
import type {
  BlockBounds,
  EditorState,
  EditorStyles,
  Position,
  RenderedBlock,
  RenderedLine,
} from "../../state-types";
import type { AwarenessState } from "../../sync/awareness";

/** Result of the shared layout pass. Cacheable on `block.cachedHeight`. */
export interface BlockLayout {
  /** Total vertical space the block occupies, including its own padding. */
  readonly height: number;
  /** Text line boxes for hit-testing/caret math. Empty for atomic blocks. */
  readonly lines: readonly RenderedLine[];
}

export interface BlockRuntimeState {
  id: string;
  cachedHeight?: number; // Cached rendered height
  cachedWidth?: number; // Width at which height was cached
  deleted?: boolean;
  afterId?: string | null;
}

/** Geometry + styles available without a canvas (measurement, height passes). */
export interface BlockLayoutCtx {
  readonly block: Block;
  readonly blockIndex: number;
  /** Content width available to the block (canvas minus page padding). */
  readonly maxWidth: number;
  /** First block gets special treatment (e.g. full-bleed image padding). */
  readonly isFirst: boolean;
  readonly styles: EditorStyles;
}

/** Everything paint() needs on top of layout context. */
export interface BlockPaintCtx extends BlockLayoutCtx {
  readonly ctx: CanvasRenderingContext2D;
  readonly state: EditorState;
  /** Top-left origin of the block's content box in canvas space. */
  readonly origin: { readonly x: number; readonly y: number };
  readonly awareness?: Map<string, AwarenessState>;
  /**
   * Ask the host to schedule another render frame. Injected by the renderer so
   * a block can repaint itself after async work (e.g. image decode) completes,
   * without reaching for a module global.
   */
  readonly requestRedraw: () => void;
}

/** A point in block-local canvas coordinates. */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * Base class for a block type's on-canvas behavior. One instance per type,
 * registered in the view registry. Generic over the concrete block shape so
 * subclasses get a narrowed `block`.
 */
export abstract class BlockView<B extends Block = Block> {
  /** The block type string this view handles. */
  abstract readonly type: B["type"];

  /**
   * Optional: every type this view handles. When set, the view is registered
   * under each of these keys instead of just `type`. Used by views that back a
   * family of block types (e.g. TextBlockView handles headings + lists +
   * paragraph from one implementation).
   */
  readonly types?: readonly string[];

  /**
   * Shared work: wrap text / resolve intrinsic size, return height + line
   * boxes. Called by the height pass (uses only `.height`) and by paint.
   */
  abstract layout(c: BlockLayoutCtx): BlockLayout;

  /** Draw using a precomputed layout — must NOT re-wrap or re-measure. */
  abstract paint(layout: BlockLayout, c: BlockPaintCtx): RenderedBlock;

  /**
   * Map a block-local point to a caret position. Default places the caret at
   * the start of the block, which is correct for atomic/void blocks.
   */
  hitTest(_layout: BlockLayout, _local: Point, c: BlockLayoutCtx): Position {
    return { blockIndex: c.blockIndex, textIndex: 0 };
  }

  /**
   * Optional: adjust how much vertical flow this block consumes, given its
   * measured height. Used by blocks that bleed outside their box (e.g. a first
   * full-width image bleeding into the top padding advances by less than it
   * draws). When unset, flow height === drawn height.
   */
  adjustFlowHeight?(height: number, c: BlockLayoutCtx): number;

  /** Convenience for subclasses building their RenderedBlock result. */
  protected bounds(c: BlockPaintCtx, height: number): BlockBounds {
    return { x: c.origin.x, y: c.origin.y, width: c.maxWidth, height };
  }
}

// ---------------------------------------------------------------------------
// View registry — the single dispatch point that replaces ~69 `block.type ===`
// switches across renderer / selection / event-utils.
//
// IMPORTANT: this is a per-editor-instance object, NOT a module global. Each
// editor owns its own registry (stored on EditorState.blockViews), so two
// editors on the same page can register different block sets — e.g. one with
// list blocks and one without. This is also what makes block types opt-in: a
// host composes the registry it wants at mount time. A module-level Map would
// be shared across every editor and break both of those properties.
// ---------------------------------------------------------------------------

export class BlockViewRegistry {
  private readonly views = new Map<string, BlockView>();

  /**
   * Register a view under its `type` (or every key in `types` for views that
   * back a family of block types). Returns `this` for fluent chaining.
   */
  register(view: BlockView): this {
    const keys = view.types ?? [view.type];
    for (const key of keys) {
      this.views.set(key, view);
    }
    return this;
  }

  /** Look up the view for a block type, or `undefined` if none is registered. */
  get(type: string): BlockView | undefined {
    return this.views.get(type);
  }

  /** Whether a view is registered for this block type. */
  has(type: string): boolean {
    return this.views.has(type);
  }
}
