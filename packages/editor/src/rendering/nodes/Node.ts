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

import type { ActionBus } from "../../action-bus";
import { BLOCK_DRAG_HANDLE_ANCHOR_HEIGHT } from "../../constants";
// Type-only: the region-behavior contract a node carries on its hit regions.
// Erased at compile time, so importing it here introduces no runtime cycle
// even though the events layer imports `rendering/nodes`.
import type {
  RegionCtx,
  RegionDragSpec,
  RegionPoint,
  RegionResult,
} from "../../events/regions";
import type { NodeCodec } from "../../serlization/codecs/types";
import type { Block } from "../../serlization/loadPage";
import type {
  BlockBounds,
  EditorState,
  EditorStyles,
  NodeOverlay,
  Position,
  RenderedBlock,
  RenderedLine,
  TextStyle,
  ViewportState,
} from "../../state-types";
import type {
  ContentPoint,
  ContentSelection,
} from "../../structured-selection";
import type { MarkRegistry } from "../marks";
import type { CaretModel } from "./caret-model";

/** Result of the shared layout pass. Cacheable on `block.cachedLayout`. */
export interface NodeLayout {
  /** Total vertical space the block occupies, including its own padding. */
  readonly height: number;
  /** Text line boxes for hit-testing/caret math. Empty for atomic blocks. */
  readonly lines: readonly RenderedLine[];
  /**
   * Content width (canvas minus page padding) this layout was computed for —
   * the layout's provenance, and the key `memoizeNodeLayout` reuses it under.
   * Every `layout()` builds this from its `maxWidth`, so a holder of any layout
   * knows the width it is valid for.
   */
  readonly maxWidth: number;
}

export interface BlockRuntimeState {
  id: string;
  // Cached canonical (no-composition) layout — the SINGLE render-cache slot. The
  // full layout pass is the most expensive per-block operation (text measurement
  // is ~O(n²) for a large block) and is otherwise recomputed independently by the
  // height pass, paint, every hit-test on pointer move, and the caret/selection
  // passes. Memoizing the whole layout (height derived from `cachedLayout.height`,
  // and the width it was computed for carried on `cachedLayout.maxWidth` rather
  // than a sibling field) collapses all of those into one computation per
  // content/width change. Invalidated by `invalidateBlockCache`, and stripped
  // before persistence (it is a large, per-canvas-width render hint).
  cachedLayout?: NodeLayout;
  deleted?: boolean;
  /**
   * Fractional-index position key. Document order is `sort by (orderKey, id)`;
   * moving a block is a single LWW `block_set` of this field. See
   * `sync/fractional-index.ts`.
   *
   * Optional only at construction (freshly-parsed block literals omit it the
   * same way they used to omit `afterId`); every block in committed `Page`
   * state carries one, assigned by the parser, the reducer's `createEmptyBlock`,
   * or a registry default.
   */
  orderKey?: string;
  /**
   * Optional normalized structured attachments owned by this block. The core
   * CRDT reducer preserves and merges these by stable content id without
   * interpreting their feature-owned `kind` (math, diagram, …).
   */
  structuredContent?: import("../../sync/structured-content").StructuredContentMap;
  /**
   * Transient render hints: the `type` of the adjacent *visible* (non-deleted)
   * blocks, stamped by `getVisibleBlocks`. They let a node lay itself out aware
   * of its neighbours — e.g. consecutive quotes tighten their shared edge — the
   * one positional dependency the otherwise self-contained layout pass allows.
   * Kept here (not threaded through every height call site) so all 16+ callers
   * pick them up uniformly off the block. When a block's join context changes,
   * `getVisibleBlocks` clears `cachedLayout`, so any height/inset derived from
   * these is recomputed (and the height index, which re-measures on a cleared
   * cache, follows). `undefined` at a document edge. Stripped before persistence.
   */
  prevType?: string;
  nextType?: string;
  /**
   * Per-block visual style overrides — an open bag of `property → value`, layer
   * 3 of the style cascade (node default ◁ theme `styles.blocks[type]` ◁ this).
   * Each property syncs as its own `style.<key>` `block_set` (independent LWW),
   * via the style-namespace helpers in `sync/block-registry`. The keys a
   * built-in {@link TextStyle} carries are honored by the text nodes; a custom
   * node may read and paint any other key it understands. A `null` value means
   * "no override".
   */
  style?: Record<string, unknown>;
}

/**
 * Structural block shape accepted by a rendering node.
 *
 * The persisted core {@link Block} union intentionally contains only the base
 * package's blocks. Optional feature nodes specialize {@link Node} with their
 * own block shape (for example the math package's display block) without
 * forcing that feature type into the root declaration graph.
 */
export interface NodeBlock extends BlockRuntimeState {
  readonly type: string;
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
  /**
   * The per-instance mark registry — lets the layout/measurement pass reserve a
   * replacement run's rendered width (e.g. an inline-math chip) via the mark's
   * `replacement.measure`, instead of measuring its source as plain text.
   */
  readonly marks: MarkRegistry;
}

/** Everything paint() needs on top of layout context. */
export interface NodePaintCtx extends NodeLayoutCtx {
  readonly ctx: CanvasRenderingContext2D;
  readonly state: EditorState;
  /** Top-left origin of the block's content box in canvas space. */
  readonly origin: { readonly x: number; readonly y: number };
  /**
   * Ask the host to schedule another render frame. Injected by the renderer so
   * a block can repaint itself after async work (e.g. image decode) completes,
   * without reaching for a module global.
   */
  readonly requestRedraw: () => void;
}

/** Pointer-hit context for entering a node-owned structured attachment. */
export interface NodeContentHitCtx<
  B extends NodeBlock = NodeBlock,
> extends Omit<NodeLayoutCtx, "block"> {
  readonly state: EditorState;
  readonly block: B;
}

/** Gesture details that can affect a node's nested caret hit-test. */
export interface NodeContentHitOptions {
  readonly pointerType: NodePointerType;
  /** Finger/magnifier drag uses nearest-stop geometry with row hysteresis. */
  readonly drag?: boolean;
  /** Stable current endpoint used as the drag hysteresis anchor. */
  readonly previousPoint?: ContentPoint | null;
}

/** A point in block-local canvas coordinates. */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/** Context for {@link Node.activate} — enough to decide which overlay to open. */
export interface NodeActivateCtx {
  readonly state: EditorState;
  readonly block: Block;
  readonly blockIndex: number;
}

/** The host overlay {@link Node.activate} asks the engine to open. */
export interface NodeActivation {
  readonly key: string;
  readonly data?: unknown;
}

/** Pointer type for node hit regions (mirrors events/regions PointerType). */
export type NodePointerType = "mouse" | "touch";

/** Everything a node needs to compute its interactive sub-region geometry. */
export interface NodeRegionCtx extends NodeLayoutCtx {
  readonly state: EditorState;
  readonly viewport: ViewportState;
  /** Top-left of the block's content box in canvas coordinates. */
  readonly origin: Point;
}

/**
 * A named interactive sub-region of a block (todo checkbox, image resize
 * handle, …). A region always declares identity + geometry (`id` + `hitTest`);
 * it may additionally carry its own behavior (`priority`/`onTap`/`drag`), in
 * which case the event layer binds it directly instead of resolving behavior by
 * `id`. Carrying behavior is how a node owns its full interaction semantics
 * (e.g. ImageNode's resize-handle drag) rather than splitting geometry here and
 * behavior into a binding table in the event layer. Geometry-only regions (no
 * `onTap`/`drag`) are still bound by id (e.g. the todo checkbox).
 *
 * Generic over `H`, the hit-payload type: whatever {@link hitTest} returns is
 * exactly what {@link onTap} and {@link drag}'s `onStart` receive, so a node
 * author never casts the hit. Build a region with the {@link hitRegion} helper
 * to infer `H` from `hitTest`'s return; `regions()` then erases it back to
 * `unknown` for the heterogeneous event-layer registry (safe because the region
 * is internally consistent).
 */
export interface NodeHitRegion<H = unknown> {
  /** Stable id the event layer binds behavior to (e.g. "todo-checkbox"). */
  id: string;
  /**
   * Hit data (forwarded to the bound behavior) or null. The point is in
   * canvas coordinates; apply pointer-type hit slop here.
   */
  hitTest(p: Point, pointerType: NodePointerType): H | null;
  /** Higher wins when several regions contain the point. Defaults to 0. */
  priority?: number;
  /** Editor modes this region is active in. Defaults to ["edit", "select"]. */
  modes?: readonly ("edit" | "select" | "readonly")[];
  /** Tap behavior (carried with the region); `hit` is this region's payload. */
  onTap?(
    hit: H,
    p: RegionPoint,
    tapCount: number,
    ctx: RegionCtx,
  ): RegionResult;
  /** Drag behavior (carried with the region). */
  drag?: RegionDragSpec<H>;
}

/**
 * Identity helper that infers a hit region's payload type `H` from its
 * `hitTest` return, so `onTap`/`drag.onStart` receive that exact type with no
 * cast. Wrap each region literal a node's {@link Node.regions} returns:
 *
 *   hitRegion({
 *     id: "image-resize",
 *     hitTest: (p, pt): ImageResizeHit | null => …,
 *     drag: { onStart(hit) { …  hit is ImageResizeHit … } },
 *   })
 *
 * The result is assignable to the erased `NodeHitRegion` the array returns.
 */
export function hitRegion<H>(region: NodeHitRegion<H>): NodeHitRegion<H> {
  return region;
}

/** An atomic block (image/math/line) resolved under the pointer. */
export interface NodeAtomicHit {
  readonly blockIndex: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Base class for a block type's on-canvas behavior. One instance per type,
 * registered in the node registry. Generic over the concrete block shape so
 * subclasses get a narrowed `block`.
 */
export abstract class Node<B extends NodeBlock = NodeBlock> {
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
   * Optional: the visual "card" family this block tiles with. Adjacent blocks
   * whose nodes declare the same non-`undefined` `joinGroup` square off their
   * touching corners so their filled backgrounds meet as one continuous surface
   * instead of two rounded boxes with a notch at the seam. It groups by a shared
   * family rather than exact block type, so distinct card types (code, math,
   * quote) can be made to tile together by declaring one common group.
   * `undefined` (the default) never joins. Consumed via `cardJoinFlags`.
   */
  readonly joinGroup?: string;

  /**
   * Optional: when a multi-block paste lands with the caret inside a block of
   * this node's type, pasted plain paragraphs are re-typed to the host block's
   * type — multi-line plain text pasted into e.g. a quote continues as more
   * quote blocks instead of breaking out into paragraphs. Content that parsed
   * as a richer type (heading, list, code, …) keeps that type. `undefined`
   * (the default) leaves pasted blocks as parsed. Consumed by the paste path
   * in `insertBlocksAtCursor`.
   */
  readonly absorbsPastedParagraphs?: boolean;

  /**
   * Optional: this node's catalog of localized canvas strings (status labels,
   * placeholders) keyed by a short local name — e.g. ImageNode owns
   * `{ clickToUpload, loading, … }`. English defaults ship with the node; a
   * host overrides per instance via `theme.nodeStrings[type]`, merged into
   * `state.resolvedNodeStrings` at resolve time. Co-locating the catalog with
   * the node is what keeps `EditorStrings` from being a hand-maintained
   * god-object — each node owns its own slice. Read with {@link str}.
   */
  readonly strings?: Readonly<Record<string, string>>;

  /**
   * Shared work: wrap text / resolve intrinsic size, return height + line
   * boxes. Called by the height pass (uses only `.height`) and by paint.
   */
  abstract layout(c: NodeLayoutCtx): NodeLayout;

  /**
   * Cheap height used before a block enters the measured viewport. Nodes that
   * can estimate without performing canonical layout should override this.
   * The safe default is exact layout, preserving correctness for custom nodes
   * that have not opted into lazy estimation.
   */
  estimateHeight(c: NodeLayoutCtx): number {
    return this.layout(c).height;
  }

  /**
   * Vertical center (px from the block's top) that block-level gutter chrome —
   * the drag grip — aligns to. The default hugs the top of the block, which is
   * right for atomic blocks (image, divider). Nodes whose content starts below
   * a leading inset (a heading's space-above, a card's outer margin) override
   * this so the grip lines up with the first visible content, not the inset.
   */
  gutterAnchorY(c: NodeLayoutCtx): number {
    return Math.min(this.layout(c).height, BLOCK_DRAG_HANDLE_ANCHOR_HEIGHT) / 2;
  }

  /** Draw using a precomputed layout — must NOT re-wrap or re-measure. */
  abstract paint(layout: NodeLayout, c: NodePaintCtx): RenderedBlock;

  /**
   * Resolve the base text style (font size/weight/color/line-height) for one of
   * this node's textual block types — consumed by the text-geometry passes
   * (wrap, measure, caret) via {@link getTextStyle}. The default looks the style
   * up under the block-type name in `styles.blocks`, which is correct whenever
   * the theme key equals the type string (`paragraph`, `heading1`, `code`, …). A
   * node whose theme key differs from its type (the list family: `bullet_list` →
   * `bulletList`) or which borrows another block's metrics (math borrows the
   * paragraph style) overrides this. Non-textual nodes (image/line) never receive
   * a text-geometry pass, so the default's return value is unused for them.
   *
   * When the theme has no entry under `type` (a custom textual node that forgot
   * to register a theme key, or whose key differs without overriding this), the
   * default falls back to the paragraph style rather than returning `undefined`
   * typed as a `TextStyle` — so a missing key yields valid metrics instead of a
   * later deref. The lookup is by string, hence the index signature.
   */
  textStyle(styles: EditorStyles, type: B["type"]): TextStyle {
    const style = styles.blocks[type as keyof EditorStyles["blocks"]] as
      | TextStyle
      | undefined;
    return style ?? styles.blocks.paragraph;
  }

  /**
   * Map a block-local point to a caret position. Default places the caret at
   * the start of the block, which is correct for atomic/void blocks.
   */
  hitTest(_layout: NodeLayout, _local: Point, c: NodeLayoutCtx): Position {
    return { blockIndex: c.blockIndex, textIndex: 0 };
  }

  /**
   * Optionally map a block-local point into a structured-content selection.
   *
   * This is the nested counterpart to {@link hitTest}: the view asks the node
   * that owns the geometry, but the result is the editor's generic
   * identity-bearing selection currency. Core pointer code therefore never
   * needs to know whether the attachment is math, a diagram, or another tree.
   * Returning `null` keeps ordinary flat-cursor behavior unchanged.
   */
  contentSelectionFromPoint(
    _layout: NodeLayout,
    _local: Point,
    _c: NodeContentHitCtx<B>,
    _options: NodeContentHitOptions,
  ): ContentSelection | null {
    return null;
  }

  /**
   * Optional: adjust how much vertical flow this block consumes, given its
   * measured height. Used by blocks that bleed outside their box (e.g. a first
   * full-width image bleeding into the top padding advances by less than it
   * draws). When unset, flow height === drawn height.
   */
  adjustFlowHeight?(height: number, c: NodeLayoutCtx): number;

  /**
   * Optional: the block's interactive sub-regions at its current layout
   * (checkbox, resize handles, …). Geometry + identity only — behavior is
   * bound by id in the event layer, keeping nodes presentation-only.
   */
  regions?(c: NodeRegionCtx): readonly NodeHitRegion[];

  /**
   * Optional: the host-rendered overlays this block wants right now (an upload
   * popover, an inline editor, …), derived from its data + the current UI state
   * (read off `c.state`). Identity + geometry only — the actual React/DOM lives
   * host-side, keyed by {@link NodeOverlay.key}, so the engine stays
   * framework-agnostic. Collected per visible block by
   * `editor.collectOverlays()`; the host maps each `key` to a component and
   * mounts it at the returned `rect`. Return `[]` (or omit) for no overlay.
   */
  overlays?(c: NodeRegionCtx): readonly NodeOverlay[];

  /**
   * Optional: when the user activates (clicks/taps) this block in edit mode, the
   * host overlay to open — `key` maps to a host component (see {@link overlays}),
   * `data` is an opaque host payload. Return `null` to let the engine fall back
   * to its default activation (e.g. selecting the block). The engine relays the
   * returned `key`/`data` through `openOverlay` at the click anchor; it never
   * names the overlay itself, so the activation policy + overlay live host-side.
   */
  activate?(c: NodeActivateCtx): NodeActivation | null;

  /**
   * Optional: register this node's action-bus handlers for the instance. Called
   * once at mount with the per-instance {@link ActionBus} (after the node and bus
   * exist). This is how a node overrides or observes a built-in action for its
   * own block type — e.g. CodeNode claims Enter (`SPLIT_BLOCK`) to insert a
   * newline rather than split the block. The registry is per-editor-instance, so
   * handlers never leak across editors on the same page.
   */
  registerActions?(bus: ActionBus): void;

  /**
   * Optional: how this node's structured inline content behaves under the caret
   * (an atomic token to step over, a construct to navigate). Declaring it routes
   * the generic caret/edit code (selection, edit actions) through
   * {@link CaretModel}, so the core never special-cases the block type; a node
   * that leaves it unset behaves as ordinary editable text. The common case is
   * just `caret.atomicSpans`. This is the *query* half — the *effect* half
   * (materializing an incomplete construct after an edit) is a push, observed as
   * the `TEXT_INPUTTED` action in {@link registerActions}. See {@link CaretModel}.
   */
  readonly caret?: CaretModel<B>;

  // ── Serialization facet ────────────────────────────────────────────────────
  /**
   * Optional: this block type's markdown/HTML/text round-trip and asset refs,
   * bundled into one object so a block type's rendering AND serialization live
   * in one file. The block analogue of {@link import("../marks/Mark").Mark.codec}:
   * the schema injects the node's `types` and adapts this into the `BlockCodec`
   * the parser/serializers consume (see codecs/from-node.ts), so they never see
   * a Node. Omit it and the node falls back to the generic round-trip
   * (`defineNode`). Because the codec's `output` channels are non-optional, a
   * node that declares `codec` must provide all of markdown/html/text — enforced
   * at compile time rather than by a runtime check.
   */
  readonly codec?: NodeCodec;

  /** Convenience for subclasses building their RenderedBlock result. */
  protected bounds(c: NodePaintCtx, height: number): BlockBounds {
    return { x: c.origin.x, y: c.origin.y, width: c.maxWidth, height };
  }

  /**
   * Resolve one of this node's {@link strings} for the current instance: the
   * host's `theme.nodeStrings` override if present, else the node's English
   * default. Reads the per-instance table off `state` (never a field on the
   * shared singleton), so overrides stay scoped to one editor.
   */
  protected str(state: EditorState, key: string): string {
    return (
      state.resolvedNodeStrings.get(this.type)?.[key] ??
      this.strings?.[key] ??
      ""
    );
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

  /**
   * Every distinct registered node, deduped — a family node (TextNode,
   * ListNode) registers under several type keys but is one instance. Used to
   * collect per-node string catalogs at theme-resolution time.
   */
  nodeList(): Node[] {
    return [...new Set(this.nodes.values())];
  }

  /** Whether a node is registered for this block type. */
  has(type: string): boolean {
    return this.nodes.has(type);
  }
}
