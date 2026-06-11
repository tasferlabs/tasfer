/**
 * Node — the extensible per-block-type rendering contract.
 *
 * A Node is the *presentation* facet of a block type: layout, paint, and
 * hit-test. It deliberately knows nothing about CRDT data shape, validation, or
 * serialization — those are separate facets (the block-type registry lives next
 * to the sync layer so the node-only fuzz harness never imports canvas types).
 *
 * Two low-level primitives extend this base: TextNode (text geometry) and
 * AtomicNode (intrinsic-sized void/embed boxes). Styled block types extend one
 * of those rather than this class directly, so every node shares one draw API:
 *
 *   layout()  — wrap/measure once, producing height + line boxes (cacheable)
 *   paint()   — consume the precomputed layout, draw to canvas
 *   hitTest() — map a local point to a caret Position using the layout
 *
 * Splitting layout from paint is what keeps the height pass, the paint pass,
 * and the geometry passes (caret/selection/hit-test) from ever disagreeing.
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
export interface NodeLayout {
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
export interface NodeLayoutCtx {
  readonly block: Block;
  readonly blockIndex: number;
  /** Content width available to the block (canvas minus page padding). */
  readonly maxWidth: number;
  /** First block gets special treatment (e.g. full-bleed image padding). */
  readonly isFirst: boolean;
  readonly styles: EditorStyles;
}

/** Everything paint() needs on top of layout context. */
export interface NodePaintCtx extends NodeLayoutCtx {
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
 * registered in the node registry. Generic over the concrete block shape so
 * subclasses get a narrowed `block`.
 */
export abstract class Node<B extends Block = Block> {
  /** The block type string this node handles. */
  abstract readonly type: B["type"];

  /**
   * Optional: every type this node handles. When set, the node is registered
   * under each of these keys instead of just `type`. Used by nodes that back a
   * family of block types (e.g. TextNode handles headings + paragraph from one
   * implementation, ListNode the list family).
   */
  readonly types?: readonly string[];

  /**
   * Shared work: wrap text / resolve intrinsic size, return height + line
   * boxes. Called by the height pass (uses only `.height`) and by paint.
   */
  abstract layout(c: NodeLayoutCtx): NodeLayout;

  /** Draw using a precomputed layout — must NOT re-wrap or re-measure. */
  abstract paint(layout: NodeLayout, c: NodePaintCtx): RenderedBlock;

  /**
   * Map a block-local point to a caret position. Default places the caret at
   * the start of the block, which is correct for atomic/void blocks.
   */
  hitTest(_layout: NodeLayout, _local: Point, c: NodeLayoutCtx): Position {
    return { blockIndex: c.blockIndex, textIndex: 0 };
  }

  /**
   * Optional: adjust how much vertical flow this block consumes, given its
   * measured height. Used by blocks that bleed outside their box (e.g. a first
   * full-width image bleeding into the top padding advances by less than it
   * draws). When unset, flow height === drawn height.
   */
  adjustFlowHeight?(height: number, c: NodeLayoutCtx): number;

  /** Convenience for subclasses building their RenderedBlock result. */
  protected bounds(c: NodePaintCtx, height: number): BlockBounds {
    return { x: c.origin.x, y: c.origin.y, width: c.maxWidth, height };
  }
}

// ---------------------------------------------------------------------------
// Node registry — the single dispatch point that replaces ~69 `block.type ===`
// switches across renderer / selection / event-utils.
//
// IMPORTANT: this is a per-editor-instance object, NOT a module global. Each
// editor owns its own registry (stored on EditorState.nodes), so two
// editors on the same page can register different block sets — e.g. one with
// list blocks and one without. This is also what makes block types opt-in: a
// host composes the registry it wants at mount time. A module-level Map would
// be shared across every editor and break both of those properties.
// ---------------------------------------------------------------------------

export class NodeRegistry {
  private readonly nodes = new Map<string, Node>();

  /**
   * Register a node under its `type` (or every key in `types` for nodes that
   * back a family of block types). Returns `this` for fluent chaining.
   */
  register(node: Node): this {
    const keys = node.types ?? [node.type];
    for (const key of keys) {
      this.nodes.set(key, node);
    }
    return this;
  }

  /** Look up the node for a block type, or `undefined` if none is registered. */
  get(type: string): Node | undefined {
    return this.nodes.get(type);
  }

  /** Whether a node is registered for this block type. */
  has(type: string): boolean {
    return this.nodes.has(type);
  }
}
