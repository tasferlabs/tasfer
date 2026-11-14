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
  RegionHoverState,
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
   * The content width (canvas minus page padding) this layout was made for. Set
   * it from the `maxWidth` your `layout` receives. A cached layout is reused
   * only at this same width.
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
   * Companion hint: `true` when the previous visible block is the view's FIRST
   * visible block (i.e. this block sits at visible index 1). Lets a node tell
   * "directly under the document-opening block" apart from the same neighbour
   * type mid-document — e.g. a heading collapses its space-above under a cover
   * image (the document-opening full-width image) but keeps it after an image
   * that merely ends the previous section. Stamped/cleared with the type hints
   * above (same cache-invalidation rules); `undefined` everywhere else.
   */
  prevIsFirst?: boolean;
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
   * The viewport the block is painted into — `origin` is in its space, so
   * `viewport.height` is the canvas's bottom edge. Lets a block keep chrome on
   * screen while the rest of it runs past an edge (a wide table's scrollbar).
   * Absent when a block is painted outside a page render.
   */
  readonly viewport?: ViewportState;
  /**
   * Ask the host to schedule another render frame. Injected by the renderer so
   * a block can repaint itself after async work (e.g. image decode) completes,
   * without reaching for a module global.
   */
  readonly requestRedraw: () => void;
}

/**
 * What {@link Node.contentSelectionFromPoint} gets: the layout context, the
 * live state and your typed block.
 */
export interface NodeContentHitCtx<
  B extends NodeBlock = NodeBlock,
> extends Omit<NodeLayoutCtx, "block"> {
  readonly state: EditorState;
  readonly block: B;
}

/** Gesture details that can affect a node's nested caret hit-test. */
export interface NodeContentHitOptions {
  readonly pointerType: NodePointerType;
  /**
   * `true` while the user drags to select, with a mouse, a finger or a
   * selection handle. Snap to the nearest caret stop, and stay on the current
   * row until the pointer moves clearly away from it.
   */
  readonly drag?: boolean;
  /**
   * Where the moving end of the selection is now, or `null` when there is none.
   * During a drag, use it to keep that end steady (see `drag`).
   */
  readonly previousPoint?: ContentPoint | null;
}

/** A point in block-local canvas coordinates. */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * Context for {@link Node.contentCaretRect} — a layout context plus the block's
 * painted origin, so the node returns a rect in the caller's coordinate space
 * (viewport for the renderer, document for scroll/menu anchoring).
 */
export interface NodeContentCaretCtx<
  B extends NodeBlock = NodeBlock,
> extends Omit<NodeLayoutCtx, "block"> {
  readonly state: EditorState;
  readonly block: B;
  /** Top-left of the block's content box in the caller's coordinate space. */
  readonly origin: Point;
}

/** A caret rect: `x`/`y` are its top-left, `height` its full drawn extent. */
export interface NodeCaretRect {
  readonly x: number;
  readonly y: number;
  readonly height: number;
  /**
   * Set when the point sits in content the block has scrolled out of sight
   * sideways (a table column past the window's edge): `x` is then pinned to
   * that edge of what shows. Core draws no caret there — the local one is
   * revealed as it moves (see {@link Node.revealSideways}) — but marks a
   * peer's with an edge indicator, so a collaborator is never lost to scroll.
   */
  readonly offscreen?: "left" | "right";
}

/** An axis-aligned rect in the caller's coordinate space. */
export interface NodeRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Geometry of a non-collapsed {@link ContentSelection} a node owns — what
 * {@link Node.contentSelectionGeometry} returns.
 */
export interface NodeContentSelectionGeometry {
  /** The band the node paints for the range, used to test "is this on it". */
  readonly rects: readonly NodeRect[];
  /** The band's reading start: the start selection handle hangs from here. */
  readonly start: NodeCaretRect;
  /** The band's reading end: the end selection handle hangs from here. */
  readonly end: NodeCaretRect;
  /** Whether the anchor is the start (and the focus the end). */
  readonly isForward: boolean;
  /**
   * How strongly the node fills the band, when that differs from the theme's
   * `selection.opacity` (a block equation fills over its own card). Core
   * matches it for what it draws on top of the band.
   */
  readonly opacity?: number;
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

/**
 * Context for the sideways-scroll hooks ({@link Node.canScrollSideways} and
 * friends): the block's layout inputs plus the live state, which is where a
 * node keeps its scroll offset (`ui.nodeViewState`).
 */
export interface NodeScrollCtx extends NodeLayoutCtx {
  readonly state: EditorState;
}

/** Whether a hit region is being tested for a mouse or a finger. */
export type NodePointerType = "mouse" | "touch";

/** Everything a node needs to compute its interactive sub-region geometry. */
export interface NodeRegionCtx extends NodeLayoutCtx {
  readonly state: EditorState;
  readonly viewport: ViewportState;
  /** Top-left of the block's content box in canvas coordinates. */
  readonly origin: Point;
}

/**
 * A clickable part of a block, such as a todo checkbox or an image resize
 * handle. Every region has an `id` and a `hitTest`. It can also carry its own
 * behavior in `onTap` or `drag`, and a custom node should. A region with
 * neither does nothing, unless its id is one the editor already handles
 * (`todo-checkbox`). `hover` only works on a region that also has `onTap` or
 * `drag`.
 *
 * `H` is the type `hitTest` returns. `onTap`, `drag.onStart` and `hover` get
 * that same value, so you never cast it. Build regions with {@link hitRegion}
 * to get `H` worked out for you.
 */
export interface NodeHitRegion<H = unknown> {
  /** Stable id the event layer binds behavior to (e.g. "todo-checkbox"). */
  id: string;
  /**
   * Returns what is under the point, or `null` when it misses. The value is
   * passed to `onTap`, `drag.onStart` and `hover`. The point is in canvas
   * coordinates. Use `pointerType` to give fingers a larger target.
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
  /**
   * Optional hover affordance: the cursor to show while a mouse rests on this
   * region, plus a stable name for the exact thing under it (one column edge,
   * one handle). The engine records it in `ui.regionHover` and paints the
   * cursor; the node reads it back in `paint` — rebuilding the same `target`
   * string — to draw the hovered affordance as live. Never called on touch.
   */
  hover?(hit: H): Omit<RegionHoverState, "regionId"> | null;
}

/**
 * Builds a hit region and works out its hit type from what `hitTest` returns.
 * `onTap` and `drag.onStart` then get that same type, so you never cast it.
 * Wrap each region that {@link Node.regions} returns:
 *
 * ```ts
 * hitRegion({
 *   id: "image-resize",
 *   hitTest: (p, pointerType): ImageResizeHit | null => …,
 *   drag: { onStart(hit, p, ctx) { … }, … }, // hit is an ImageResizeHit
 * })
 * ```
 *
 * It returns the region unchanged, so it fits in the array `regions` returns.
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
 * The base class for a block type. It decides how the block is laid out,
 * painted and hit by the pointer. Each editor keeps one instance per block type
 * in its {@link NodeRegistry}.
 *
 * Most blocks extend {@link TextNode} or {@link AtomicNode} instead. Extend
 * `Node` itself only when you need full control, as the table node does. The
 * type parameter `B` is your block's shape, so `block` is typed in your
 * methods.
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
   * Optional: a group name for card-style blocks. Neighbouring blocks whose
   * nodes share a `joinGroup` can meet as one surface, with square corners
   * where they touch. The built-in cards (code, math, quote) all use `"card"`,
   * so they join each other. Your `paint` calls `cardJoinFlags` to learn which
   * edges join, and squares those corners itself. Leave it unset to never join.
   */
  readonly joinGroup?: string;

  /**
   * Optional: set to `true` so pasted paragraphs take this block's type. When
   * you paste several blocks with the caret inside this block, plain paragraphs
   * become more blocks of this type. For example, lines pasted into a quote
   * stay quotes. Pasted headings, lists, code and other rich blocks keep their
   * own type. Unset leaves pasted blocks as they are.
   */
  readonly absorbsPastedParagraphs?: boolean;

  /**
   * Optional: the text this node shows on the canvas, such as status labels and
   * placeholders, keyed by a short name. For example, ImageNode has `{
   * clickToUpload, loading, … }`. The English text ships with the node. A host
   * translates it per editor with `theme.nodeStrings[type]`. Read a string with
   * {@link str}.
   */
  // Merged into `state.resolvedNodeStrings` at resolve time. Keeping each
  // node's catalog with the node stops `EditorStrings` from becoming one
  // hand-maintained list.
  readonly strings?: Readonly<Record<string, string>>;

  /**
   * Works out the block's size: it wraps the text or measures the box. Returns
   * the height and the line boxes. The height pass uses only `.height`. Paint
   * uses the whole result.
   */
  abstract layout(c: NodeLayoutCtx): NodeLayout;

  /**
   * A quick height guess, used before the block comes near the screen. Override
   * it when your node can guess its height without a full layout. The default
   * runs `layout`, which is exact but slower.
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
   * Returns the base text style (font size, weight, color, line height) for one
   * of this node's text block types. Text wrapping, measuring and the caret
   * read it through {@link getTextStyle}.
   *
   * The default looks it up by type name in `styles.blocks`, such as
   * `paragraph` or `heading1`. Override it when your theme key differs from the
   * type (lists map `bullet_list` to `bulletList`), or to borrow another
   * block's style. If the theme has no entry for the type, the default returns
   * the paragraph style. Nodes without text (image, divider) never use it.
   */
  textStyle(styles: EditorStyles, type: B["type"]): TextStyle {
    const style = styles.blocks[type as keyof EditorStyles["blocks"]] as
      TextStyle | undefined;
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
   * Optional: map a block-local point to a place inside content this node owns,
   * such as a spot in a formula or a table cell. It is the nested version of
   * {@link hitTest}. The default returns `null`, which keeps the normal text
   * caret.
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
   * Optional: the caret rect for a {@link ContentPoint} inside content this
   * node owns. It is the reverse of {@link contentSelectionFromPoint}: that
   * turns a point into a place, this turns the place back into a rect.
   *
   * Declare it when your block keeps its text outside the normal text flow, as
   * the table does with its cells. Without it, such a block shows no caret.
   * Return `null` to use the normal text caret.
   */
  contentCaretRect?(
    layout: NodeLayout,
    point: ContentPoint,
    c: NodeContentCaretCtx<B>,
  ): NodeCaretRect | null;

  /**
   * Optionally describe a non-collapsed range this node owns: the band it
   * paints and the edges the touch selection handles hang from. The range
   * counterpart to {@link contentCaretRect} — without it core cannot draw or
   * grab handles for a nested range, nor tell that a tap landed on it.
   *
   * Rects are in the coordinate space of `c.origin`. Return `null` for a range
   * the node does not own or paints no band for.
   */
  contentSelectionGeometry?(
    layout: NodeLayout,
    selection: ContentSelection,
    c: NodeContentCaretCtx<B>,
  ): NodeContentSelectionGeometry | null;

  /**
   * Optional: change how much vertical space the block takes on the page, given
   * its measured height. Use it when the block should take more or less space
   * than it draws. When unset, the block takes exactly its drawn height. No
   * built-in node uses it.
   */
  adjustFlowHeight?(height: number, c: NodeLayoutCtx): number;

  /**
   * Optional: the block's clickable parts at its current layout, such as a
   * checkbox or resize handles. A region can carry its own tap and drag
   * behavior. Wrap it in {@link hitRegion} so those handlers get a typed hit. A
   * region without its own behavior only works for an id the editor already
   * handles. Today that is only `todo-checkbox`. Any other id does nothing.
   */
  regions?(c: NodeRegionCtx): readonly NodeHitRegion[];

  /**
   * Optional: the host overlays this block wants open right now, such as an
   * upload popover or an inline editor. Work them out from the block's data and
   * `c.state`. Each one names a host component with {@link NodeOverlay.key},
   * the block it belongs to (`blockId`), where to show it (`rect`) and optional
   * `data`. The node never draws the overlay. The host maps each key to its own
   * component and shows it at `rect`. Hosts collect them with
   * `editor.host.collectOverlays()`. Return `[]`, or leave it unset, for no
   * overlay.
   */
  overlays?(c: NodeRegionCtx): readonly NodeOverlay[];

  // ── Sideways scroll ────────────────────────────────────────────────────────
  // The page only scrolls up and down. A block that can be wider than the page
  // (a table with many columns) keeps its own sideways offset — usually in
  // `ui.nodeViewState[block.id]`, so it stays on this device and never syncs —
  // and the engine routes the sideways gestures to it: a sideways trackpad
  // swipe or Shift+wheel, a sideways finger drag and its fling. The node owns
  // the offset, its paint, and its hit-testing; the engine only asks.

  /**
   * Optional: whether the block has content past its sides right now. A touch
   * that starts on such a block owns its gesture (the host must not take a
   * sideways drag over it for a page-level swipe).
   */
  canScrollSideways?(c: NodeScrollCtx): boolean;

  /**
   * Optional: scroll the block's content sideways by `deltaX` px (positive
   * reveals more on the right). Return the next state when the content moved,
   * or `null` when there is no room that way — the gesture then falls through
   * to the page.
   */
  scrollSideways?(c: NodeScrollCtx, deltaX: number): EditorState | null;

  /**
   * Optional: scroll so a caret at `point` (a {@link ContentPoint} this node
   * owns) can be seen. Called after the local caret moves, from any source — a
   * key, a click, a command — and when a peer's out-of-view indicator is tapped
   * to jump to them. Return `null` when it already shows.
   */
  revealSideways?(c: NodeScrollCtx, point: ContentPoint): EditorState | null;

  /**
   * Optional: called when the user clicks or taps this block, unless the editor
   * is read-only. Only atomic blocks (see {@link AtomicNode}) get this call.
   * Return the host overlay to open. `key` names a host component (see
   * {@link overlays}). `data` is passed to the host as is. The engine opens the
   * overlay where the click landed. Return `null` for the default behavior,
   * such as selecting the block.
   */
  activate?(c: NodeActivateCtx): NodeActivation | null;

  /**
   * Optional: add this node's action handlers. Called once when the editor is
   * set up, with that editor's {@link ActionBus}. Use it to take over or watch
   * a built-in action for your block type. For example, CodeNode takes Enter
   * (`SPLIT_BLOCK`) to insert a newline instead of splitting the block.
   * Handlers belong to one editor, so they never reach another editor on the
   * page.
   *
   * ```ts
   * registerActions(bus: ActionBus) {
   *   bus.registerState(SELECT_ALL, (state) => {
   *     if (!caretInMyBlock(state)) return; // not ours: let others run
   *     return { state: selectMyBlock(state), ops: [], handled: true };
   *   }, 50); // higher priority runs first
   * }
   * ```
   */
  registerActions?(bus: ActionBus): void;

  /**
   * Optional: how the caret moves through special content in this block, such
   * as a token it should step over as one piece. When set, the editor's caret
   * and edit code asks your {@link CaretModel} instead of treating the text as
   * plain. Leave it unset for ordinary editable text. Most nodes only need
   * `caret.atomicSpans`. To fix up content after the user types, listen for
   * `TEXT_INPUTTED` in {@link registerActions}.
   */
  readonly caret?: CaretModel<B>;

  // ── Serialization facet ────────────────────────────────────────────────────
  /**
   * Optional: how this block type is written as markdown, HTML and plain text,
   * and read back from markdown. It can also list the assets the block points
   * to. It keeps a block's drawing and saving in one file, like
   * {@link Mark.codec} does for marks. If you set it, you must write all three
   * formats. TypeScript checks this. Do not also pass `toMarkdown`, `toHtml` or
   * `toText` to `defineNode`: the editor throws if you do. Leave `codec` unset
   * to use the generic round-trip from `defineNode`.
   */
  // The schema injects the node's `types` and adapts this into the `BlockCodec`
  // the parser/serializers consume (see codecs/from-node.ts), so they never see
  // a Node.
  readonly codec?: NodeCodec;

  /** Convenience for subclasses building their RenderedBlock result. */
  protected bounds(c: NodePaintCtx, height: number): BlockBounds {
    return { x: c.origin.x, y: c.origin.y, width: c.maxWidth, height };
  }

  /**
   * Returns one of this node's {@link strings} for this editor. It uses the
   * host's `theme.nodeStrings` text if set, else the node's English default,
   * else `""`. Overrides only affect the editor whose `state` you pass.
   */
  protected str(state: EditorState, key: string): string {
    return (
      state.resolvedNodeStrings.get(this.type)?.[key] ??
      this.strings?.[key] ??
      ""
    );
  }
}

/**
 * The nodes one editor can draw, looked up by block type. It is the one place
 * the engine asks how to lay out, paint and hit-test a block, instead of
 * checking `block.type` all over the code.
 *
 * Each editor has its own registry (kept on its state as `nodes`, never shared
 * across the page), so two editors can register different block types, for
 * example one with lists and one without. That is also what makes block types
 * opt-in: the host chooses which nodes to register when it mounts the editor.
 */
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
