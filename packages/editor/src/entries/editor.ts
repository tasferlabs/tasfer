import { DomMirror } from "../a11y/dom-mirror";
import {
  type Action,
  type ActionHandler,
  CLOSE_CONTEXT_MENU,
  CONVERT_STRUCTURED_BLOCK,
  DEFAULT_ACTION_PRIORITY,
  type DispatchArgs,
  IMAGE_PASTE,
  isMutationAction,
  isStateAction,
  type MutationAction,
  type MutationHandler,
  OPEN_CONTEXT_MENU,
  OPEN_LINK,
  SCROLL,
} from "../action-bus";
import {
  convertBlockAtCursor,
  deleteSelectedText,
  insertText,
  toggleFormat,
} from "../actions/actions";
import {
  buildClipboardPayload,
  copySelectionToClipboard,
  cutSelectionToClipboard,
  getSelectionPlainText,
  type HostClipboard,
  pasteFromSystemClipboard,
} from "../actions/clipboard";
import { COPY, CUT } from "../actions/input-actions";
import {
  expandSelectionAroundStructuredMarks,
  rangeIntersectsStructuredMark,
} from "../actions/structured-marks";
import { BLUR_SELECTION_CLEAR_DELAY } from "../constants";
import { IS_DEV } from "../env";
import { edgeScrollDelta } from "../events/autoScroll";
import { createChromeRegionRegistry } from "../events/chromeRegions";
import { handleEvents } from "../events/events";
import {
  createInteractionSession,
  isInLongPressMode,
} from "../events/interaction-session";
import { onFontsReady } from "../fonts";
import { resolveMarkRuns } from "../inline-math-spans";
import {
  caretInProtectedSource,
  clampMirrorStartToSpans,
  computeSurfaceDelta,
  currentWordStart,
  hasSentinel,
  isEmptyDelta,
  isWordBoundaryChar,
  rescueCaretBeforeSentinel,
  sentenceStartOffset,
  stripSentinel,
  SURFACE_SENTINEL,
} from "../input-diff";
import { getBlockTextContent, isAndroid, isIOS } from "../node-shared";
import {
  type BlockData as RuntimeBlockData,
  docMarks,
  type DocPoint,
  type DocRange,
  docSelection,
  queryMarkInfos,
  resolveBlockIndex,
  resolveBlockSpan,
  resolveInlineRange,
  resolvePoint,
  selectTarget,
  toBlockData,
} from "../positions";
import { BlockHeightIndex } from "../rendering/block-height-index";
import type { Decoration } from "../rendering/decorations";
import {
  removeDecorationLayer,
  setDecorationLayer,
} from "../rendering/decorations";
import {
  clearAllBlockCaches,
  collectOverlays,
  getEstimatedBlockHeight,
  getIndexedCursorViewportCoords,
  invalidateBlockCache,
  renderCursorLayer,
  renderPage,
} from "../rendering/renderer";
import type {
  AnySchemaDefinition,
  BaseSchemaDefinition,
  BlockAttrs,
  BlockName,
  MarkAttrs,
  MarkNameOf,
  SchemaBlockData,
  SchemaDefinition,
  SchemaMarkInfo,
} from "../schema-types";
import { getCursorCoordinatesWithComposition } from "../selection";
import { isNodeSelection } from "../selection";
import { moveCursorToPosition } from "../selection";
import { dropIndexAtPoint } from "../selection";
import { isCursorBlinking } from "../selection";
import { updateFocus } from "../selection";
import { updateCursor } from "../selection";
import { clearSelection } from "../selection";
import { updateSelection } from "../selection";
import {
  type Block,
  type CharRun,
  loadPage,
  type Mark,
  type MarkSpan,
  type Page,
} from "../serlization/loadPage";
import { serializeToMarkdown } from "../serlization/serializer";
import type {
  ActionResult,
  ActiveMenu,
  EditorMode,
  EditorState,
  EditorStyles,
  EditorTheme,
  NodeOverlay,
  Position,
  ViewportState,
  VisibleBlockRange,
} from "../state-types";
import type { Operation } from "../state-types";
import {
  closeActiveMenu,
  isCaretScratchActive,
  isTouchDevice,
  isTouchOnlyDevice,
  setActiveMenu,
  updateMode,
} from "../state-utils";
import {
  cloneContentSelection,
  type ContentPoint,
  type ContentSelection,
  isContentSelectionCollapsed,
  normalizeContentPoint,
  reconcileContentSelectionState,
  updateContentSelection,
} from "../structured-selection";
import {
  getEditorStyles,
  mergeTheme,
  resolveNodeStrings,
  resolveTheme,
} from "../styles";
import { findBlock, findBlockIndex } from "../sync/block-lookup";
import {
  isPlainStyleObject,
  isPreformattedType,
  isStyleField,
  isTextualBlock,
  readBlockStyle,
  styleField,
  styleKeyOf,
} from "../sync/block-registry";
import {
  canRedoState,
  canUndoState,
  recordUndoOps,
  redoState,
  undoState,
} from "../sync/crdt-undo";
import {
  deleteCharsInRange,
  insertCharsAtPosition,
  markCharsInRange,
  orderKeyAfter,
  sortBlocksByOrder,
} from "../sync/crdt-utils";
import type { IdentityAllocator } from "../sync/id";
import { applyOp, applyOps } from "../sync/reducer";
import { generateRestoreOperations } from "../sync/snapshot-diff";
import {
  canonicalizeStructuredDocument,
  hasStructuredBlockAuthority,
  hasStructuredContent,
  type StructuredDocument,
  type StructuredMutation,
} from "../sync/structured-content";
import { getVisibleBlocks } from "../sync/sync";
import type { CanvasLayers } from "./layers";

// ── Per-block style: write-API expansion ─────────────────────────────────────
// A write-API attr bag may carry a nested `style` object (e.g.
// `setBlock({ style: { color: "red" } })`). It fans out to one `style.<key>`
// (field, value) pair per property — each an independent LWW register so
// concurrent edits to different style properties merge — while other attrs pass
// through unchanged. These are the (field, value) pairs that become block_set
// ops, and the matching local block patch.

/** Expand an attr bag's nested `style` object into `style.<key>` field pairs. */
function styleAwareEntries(
  attrs: Record<string, unknown>,
): Array<[string, unknown]> {
  const entries: Array<[string, unknown]> = [];
  for (const [field, value] of Object.entries(attrs)) {
    if (field === "style" && isPlainStyleObject(value)) {
      for (const [key, v] of Object.entries(value)) {
        entries.push([styleField(key), v]);
      }
    } else {
      entries.push([field, value]);
    }
  }
  return entries;
}

/**
 * Apply expanded (field, value) pairs to a block for the optimistic local
 * update, nesting `style.<key>` fields back into the block's `style` bag (the
 * batched mirror of the reducer's per-op write).
 */
function applyAttrEntries<B extends Block>(
  block: B,
  entries: Array<[string, unknown]>,
): B {
  const flat: Record<string, unknown> = {};
  let style: Record<string, unknown> | undefined;
  for (const [field, value] of entries) {
    if (isStyleField(field)) {
      style = {
        ...(style ?? readBlockStyle(block)),
        [styleKeyOf(field)]: value,
      };
    } else {
      flat[field] = value;
    }
  }
  return { ...block, ...flat, ...(style ? { style } : {}) } as B;
}

/** Runtime storage guard for schema-declared textual extension blocks. */
function hasTextStorage(
  block: Block,
): block is Block & { charRuns: CharRun[]; formats: MarkSpan[] } {
  return (
    "charRuns" in block &&
    Array.isArray(block.charRuns) &&
    "formats" in block &&
    Array.isArray(block.formats)
  );
}

/**
 * Events for the convenience {@link Editor.on} subscription:
 *   - "change"          — the document content changed
 *   - "selectionchange" — the caret/selection moved (no content change)
 *   - "focus" / "blur"  — the editor gained or lost focus
 */
export type EditorEvent = "change" | "selectionchange" | "focus" | "blur";

/**
 * Payload delivered to `on("change", …)` listeners: the batch of CRDT
 * operations that changed the document, and whether they were applied from a
 * remote peer (sync) rather than a local edit. Filter on `isRemote` to ignore
 * your own echoes; read `ops.length` for the size of the change.
 */
export interface ChangeTransaction {
  /** True when applied from a peer via sync; false for a local edit/undo/redo. */
  readonly isRemote: boolean;
  /** The CRDT operations that produced this change, in apply order. */
  readonly ops: readonly Operation[];
}

/**
 * An inline mark name accepted by {@link ChangeApi.toggleMark} — any mark
 * type registered on the editor's schema whose {@link Mark.togglable} is true
 * (the built-ins `strong`/`emphasis`/`strike`/`code`, plus any custom toggle
 * marks a host registers). `link` and `math` are valid mark types but are
 * `togglable: false` — they carry data (a url / LaTeX) and are applied through
 * {@link ChangeApi.setMarkRange} (which takes `mark.attrs`), so `toggleMark` is
 * a no-op for them.
 *
 * Typed as `string` rather than a closed union so custom marks are accepted;
 * the name is validated against the schema at call time.
 */
export type MarkName<S extends SchemaDefinition = AnySchemaDefinition> =
  MarkNameOf<S>;

// The DocPoint / DocRange / BlockData position vocabulary — and the pure resolvers
// that consume it — live in `../positions` (free functions over EditorState, so
// they're unit-testable without a canvas). Re-exported here because they're part
// of the ChangeApi / read-API contract.
export type { DocPoint, DocRange } from "../positions";
export type BlockData<S extends SchemaDefinition = BaseSchemaDefinition> =
  SchemaBlockData<S>;
export type MarkInfo<S extends SchemaDefinition = BaseSchemaDefinition> =
  SchemaMarkInfo<S>;

type BlockInsertInput<S extends SchemaDefinition, T extends BlockName<S>> = {
  readonly id?: string;
  readonly type: T;
  readonly style?: Record<string, unknown>;
} & Partial<BlockAttrs<S, T>>;

type BlockPatch<S extends SchemaDefinition> = {
  [T in BlockName<S>]: Partial<BlockAttrs<S, T>> & { readonly type?: never };
}[BlockName<S>];

type RuntimeBlockInput = {
  id?: string;
  type: string;
  [key: string]: unknown;
};

type RuntimeBlockPatch = {
  type?: string;
  level?: number;
  [key: string]: unknown;
};

/**
 * The single mutation surface, handed to the callback of {@link Editor.change}
 * / {@link Editor.canChange} (and to an {@link EditorAction}). Every method
 * queues one granular edit and returns `this`, so calls chain. The whole
 * callback commits as ONE undoable step — one undo entry, one broadcast, one
 * `on("change")` — regardless of how many methods it calls. A method whose
 * target is missing/invalid is a silent no-op (it queues nothing).
 *
 * Every method takes an optional {@link DocPoint}/{@link DocRange} target that
 * defaults to the live caret/selection, so the common case stays terse
 * (`insertText("x")`, `setMark("strong")`) while a host plugin can act at an
 * explicit, CRDT-stable position without reaching into editor internals.
 */
export interface ChangeApi<S extends SchemaDefinition = AnySchemaDefinition> {
  /**
   * The document CRDT's authoritative identity allocator for this change.
   * Feature controllers use it for every new persisted node/character id, then
   * pass their generic mutations to {@link editContent}. Do not retain it or
   * create a feature-specific generator around it.
   */
  readonly identities: IdentityAllocator;

  // ── inline ──────────────────────────────────────────────────────────────
  /**
   * Insert `text`, replacing `range`. `range` defaults to the live selection —
   * so `insertText("x")` types at the caret (inheriting the pending caret
   * format), and an explicit range replaces it. `mark` optionally applies a
   * single inline mark to the inserted run (its per-mark data rides on
   * `mark.attrs`). A no-op for a missing/non-textual target.
   */
  insertText(text: string, range?: DocRange, mark?: Mark): this;
  /**
   * Delete `range` (default: the live selection). Multi-block when it resolves
   * to the selection; an explicit {@link DocRange} must be within one block. The
   * caret lands where the range began.
   */
  deleteRange(range?: DocRange): this;
  /**
   * Apply, remove, or toggle an inline mark over `range`. With no options it
   * toggles across the selection (or the pending caret format) — the common
   * bold/italic case. Pass `active` to force apply (`true`) / remove (`false`),
   * `attrs` for the mark's per-mark data (e.g. a link's `url`), and `range` to
   * target an explicit single-block span (default: selection). A no-op for an
   * empty range or a missing/non-textual block.
   */
  setMark<T extends MarkNameOf<S>>(
    name: T,
    opts?: {
      active?: boolean;
      attrs?: MarkAttrs<S, T>;
      range?: DocRange;
    },
  ): this;

  // ── structured content ──────────────────────────────────────────────────
  /**
   * Apply generic CRDT mutations to one structured attachment. This is the
   * node-agnostic write seam for feature controllers (math, diagrams, …): the
   * edits join this change's single undo/broadcast transaction. Invalid or
   * inapplicable mutations are no-ops.
   */
  editContent(
    blockId: string,
    contentId: string,
    edits: StructuredMutation | readonly StructuredMutation[],
  ): this;
  /**
   * Set or clear an identity-bearing selection inside structured content as
   * part of this change. Entering content selection clears the flat caret/range.
   */
  selectContent(selection: ContentSelection | null): this;

  // ── block ───────────────────────────────────────────────────────────────
  /**
   * Insert a new block at `at` (a block-edge {@link DocPoint}; default: after the
   * caret block). The block's `type` is required; an `id` is generated when
   * absent and any extra own attrs are applied as `block_set` ops — a nested
   * `style` object seeds per-block visual overrides, fanned out per property the
   * same way {@link setBlock} does. Text content is not seeded — insert an empty
   * block, then fill it.
   */
  insertBlock<T extends BlockName<S>>(
    block: BlockInsertInput<S, T>,
    at?: DocPoint,
  ): this;
  /**
   * Reconcile the block at `at` (default: caret block) toward `attrs`. `type` is
   * the attr whose presence triggers a structural conversion — textual
   * (paragraph/heading/list/code) and void (image/math/line, which clear their
   * text and get a trailing paragraph); `"heading"` is sugar mapped to heading1–3
   * by `level`. Other attrs are validated against the block type's schema and set
   * one `block_set` per field. A nested `style` object sets per-block visual
   * overrides (`setBlock({ style: { color: "#f00" } })`) — each property fans out
   * to its own `style.<key>` `block_set` so concurrent edits to different
   * properties merge; `null` clears a key. Structural conversion, plain attr
   * edits, and style all fold into this one call.
   */
  setBlock<T extends BlockName<S>>(
    attrs: { readonly type: T } & Partial<BlockAttrs<S, T>>,
    at?: DocPoint,
  ): this;
  setBlock(
    attrs: { readonly type: "heading"; readonly level?: 1 | 2 | 3 },
    at?: DocPoint,
  ): this;
  setBlock(attrs: BlockPatch<S>, at?: DocPoint): this;
  /** Delete the block at `at` (default: caret block); tombstoned so undo can
   * restore it. If it was the last visible block, an empty paragraph replaces it. */
  deleteBlock(at?: DocPoint): this;

  // ── selection ─────────────────────────────────────────────────────────────
  /**
   * Position the caret/selection as part of this change. Composes:
   * `c.insertText("x").select("end")`. "Select all" is just
   * `select({ from: "start", to: "end" })`. A collapsed {@link DocRange} (or a
   * bare {@link DocPoint}) places a caret; a span selects it.
   */
  select(target: DocRange): this;
}

/**
 * A named, reusable document mutation: a function over the {@link ChangeApi}.
 * Register one under a name in the schema's `actions` (or bind it to a keyboard
 * `shortcut`) to invoke it by name — it commits as a single undoable step, just
 * like a {@link Editor.change} callback. The host's own actions and the engine
 * built-ins are the same kind of value —
 * `const toggleStrong: EditorAction = (c) => c.setMark("strong")`.
 */
export type EditorAction<S extends SchemaDefinition = AnySchemaDefinition> = (
  c: ChangeApi<S>,
) => void;

/**
 * Read-only snapshot of editor state for UI binding (see {@link Editor.state}).
 * A fresh value is built on each read and is never mutated, so it's safe to
 * destructure and hold for the duration of one read.
 */
export interface EditorStateSnapshot {
  /**
   * The current selection: `empty` is true for a bare caret (or no caret), and
   * `range` is the selection as a {@link DocRange} (a collapsed point for a
   * caret), or `null` when there is no caret/selection. `block` preserves the
   * stable identity of an atomic whole-block selection, whose range endpoints
   * otherwise occupy the same document stop.
   */
  readonly selection: {
    readonly empty: boolean;
    readonly range: DocRange | null;
    /** Stable id of the atomically selected whole block, otherwise `null`. */
    readonly block: string | null;
  };
  /**
   * The active identity-bearing caret/range inside a structured attachment.
   * Separate from {@link selection}, so ordinary {@link DocPoint} behavior is
   * unchanged. This plain-data value can be published directly as presence.
   */
  readonly contentSelection: ContentSelection | null;
  /** Inline marks active at the caret / across the selection. */
  readonly activeMarks: ReadonlySet<Mark["type"]>;
  /** Whether {@link EditorApi.undo} would currently change the document. */
  readonly canUndo: boolean;
  /** Whether {@link EditorApi.redo} would currently change the document. */
  readonly canRedo: boolean;
  /** Whether the editor currently has focus. */
  readonly isFocused: boolean;
  /**
   * The current interaction mode: `edit` (normal), `select` (selection-only,
   * e.g. mobile), `suspended` (read-only; momentum halted), or `readonly`. The
   * read counterpart to {@link EditorHostApi.setMode} — lets host chrome gate
   * behavior on mode (e.g. suspend while a modal popover is open) without
   * reaching into raw state.
   */
  readonly mode: EditorMode;
  /**
   * Whether the editor was initialized read-only. Unlike {@link mode} (which a
   * read-only editor flips to `select` to allow drag-select + copy), this stays
   * true for the editor's lifetime — so host chrome can suppress *mutating*
   * affordances (a link's Edit button, a code block's language picker) for the
   * whole read-only session, not just while `mode === "readonly"`.
   */
  readonly isReadonlyBase: boolean;
  /**
   * Whether the caret sits in a node/mark's caret-anchored command-entry scratch
   * — e.g. typing a `\command` inside a math chip, kept literal until confirmed.
   * Gates host chrome that mirrors that in-progress entry (the inline-math
   * `\command` palette). Type-agnostic: true whenever any owner armed the slot at
   * the current caret.
   */
  readonly caretScratchActive: boolean;
}

/**
 * The viewport/geometry & ephemeral-paint facet of {@link EditorApi}, reached as
 * `editor.view`. Read-mostly host plumbing: where the caret/blocks sit on screen,
 * scroll position, and the generic decoration layers (find highlights, remote
 * cursors). Public and semver-stable — providers depend on the decoration
 * members (see `@tasfer/provider-core/cursors`) — but kept off the flat root
 * so the everyday content/command surface stays small.
 */
export interface EditorViewApi {
  /**
   * Map a document point to viewport (screen) coordinates — `{ x, y, height }`
   * with scroll applied — or `null` when the point isn't laid out (or can't be
   * resolved). Takes the same public {@link DocPoint} vocabulary the read/write
   * API speaks: an absolute `{ block, offset }` (the stable, CRDT-id form), or a
   * relative `"caret"`/`"start"`/`"end"`. This is the anchoring primitive a host
   * menu/typeahead builds on: e.g. a slash plugin anchors at the `/` position so
   * its popover stays put as the caret moves through the filter text; pass
   * `"caret"` to anchor an IME/autocomplete overlay to the current caret.
   */
  coordsAtPos: (point: DocPoint) => {
    x: number;
    y: number;
    height: number;
  } | null;
  /**
   * Map an identity-bearing structured-content point to viewport coordinates.
   * The owning node resolves its own tree geometry; returns `null` when the
   * point or attachment is stale or the node has no content-caret renderer.
   */
  coordsAtContent: (point: ContentPoint) => {
    x: number;
    y: number;
    height: number;
  } | null;
  /**
   * Merge a partial viewport patch (e.g. width/height on a container resize) and
   * re-render. A width change clears cached block layout, since it affects text
   * wrapping and document height.
   */
  updateViewport: (viewport: Partial<ViewportState>) => void;
  /** Get current scroll position. */
  getScrollY: () => number;
  /**
   * The fully-resolved {@link EditorStyles} the engine currently paints with —
   * the host {@link EditorTheme} (tokens + overrides + window-focus state)
   * collapsed into concrete values. A host drawing chrome that must visually
   * match the canvas (e.g. an overlay caret using the same cursor color) reads
   * it here instead of re-resolving the theme itself. Recomputed per call, so
   * it reflects the latest {@link EditorApi.setTheme}/focus state.
   */
  getStyles: () => EditorStyles;
  /** Scroll the viewport to make a document point visible. Speaks the same
   * public {@link DocPoint} vocabulary as {@link coordsAtPos}: an absolute
   * `{ block, offset }` (the stable, CRDT-id form), or a relative
   * `"caret"`/`"start"`/`"end"`. */
  scrollToPosition: (
    point: DocPoint,
    options?: { viewportOffsetY?: number },
  ) => void;
  /**
   * Replace the decorations in one layer — the engine's generic, ephemeral
   * overlay primitive (find highlights, remote cursors, …). `layer` is an opaque
   * key (e.g. `"search"`, `"presence:<peerId>"`); decorations in different layers
   * never clobber each other. Passing an empty array clears the layer. Points are
   * addressed by stable block id (resolved to indices at paint time) so they stay
   * correct across concurrent remote edits between producing and painting. Not
   * document content — never persisted, never in undo. */
  setDecorations: (layer: string, decorations: readonly Decoration[]) => void;
  /** Clear one decoration layer. */
  clearDecorations: (layer: string) => void;
  /**
   * Drive the insertion-line indicator for an external drag — e.g. dragging an
   * image file over the canvas. Pass viewport client coordinates (`clientX`/
   * `clientY` from a DOM drag event); the engine maps them to the nearest
   * insertion gap, paints the same line a block reorder shows (without the gutter
   * grip), and returns the {@link DocPoint} that line marks so a drop can insert
   * there. Returns `null` — and clears the line — when the point is outside the
   * canvas or can't be resolved. Pass `null` to clear on drag-leave/drop. Purely
   * ephemeral chrome: no document content, no CRDT op, not in undo.
   */
  showDropIndicator: (
    client: { x: number; y: number } | null,
  ) => DocPoint | null;
  /**
   * Advance edge auto-scroll for an external drag and refresh the drop line —
   * one frame's worth. Native HTML5 drags emit only `drag*` events (never
   * `pointermove`), so the engine's pointer-driven auto-scroll can't see them;
   * a host drives this from its own `requestAnimationFrame` loop while a file
   * drag is in flight, passing the latest `clientX`/`clientY`. When the pointer
   * sits within the edge band the viewport scrolls (clamped to the document),
   * then the insertion line is re-resolved against the new scroll — same
   * geometry and DocPoint contract as {@link showDropIndicator}. A pointer away
   * from both edges scrolls nothing but still refreshes the line. Pass `null`
   * on drag-leave/drop to reset. Purely ephemeral chrome: no op, not in undo.
   */
  edgeScrollForDrag: (
    client: { x: number; y: number } | null,
  ) => DocPoint | null;
}

/**
 * The chrome-lifecycle facet of {@link EditorApi}, reached as `editor.host`.
 * The surface a host builds rich UI chrome on: node-declared overlays, the
 * opaque per-block view-state channel, menu lifecycle, interaction mode, and
 * snapshot restore. Public and semver-stable, but kept off the flat root
 * since most consumers (and the React bindings) never touch it.
 */
export interface EditorHostApi {
  /**
   * Switch the interaction mode: `edit` (normal), `select` (selection-only, e.g.
   * mobile), or `suspended` (read-only; also halts scroll momentum). Notifies
   * subscribers.
   */
  setMode: (mode: "edit" | "select" | "suspended") => void;
  /**
   * Collect the node-declared overlay descriptors for the on-screen blocks
   * (see {@link NodeOverlay}). The host maps each `key` to a component and
   * mounts it at the descriptor's `rect`; recompute on state/scroll changes.
   * Empty unless a registered node implements `overlays()`.
   */
  collectOverlays: () => NodeOverlay[];
  /**
   * Open a host-defined overlay (popover/drawer/tooltip). The single generic
   * primitive every host overlay flows through: the engine stores `{ key, data }`
   * opaquely and never names a specific overlay. The node/mark that declares the
   * overlay in `overlays()` reads it back by `key`; a typed opener co-located
   * with that owner (e.g. `openLinkEditMenu` in the host schema) builds the
   * payload and calls this. Use {@link closeActiveMenu} to dismiss.
   */
  openOverlay: (overlay: {
    key: string;
    blockId: string;
    x: number;
    y: number;
    data?: unknown;
  }) => void;
  /**
   * Set (or clear, with `null`) transient per-block canvas view-state, keyed by
   * `blockId`. The opaque payload is read by the node that paints the block — the
   * generic channel for ephemeral chrome like an image's upload spinner, so the
   * engine never models that chrome as a menu/overlay. Not document content;
   * produces no CRDT op.
   */
  setNodeViewState: (blockId: string, data: unknown | null) => void;
  /**
   * Close whichever menu/overlay is currently open (slash menu, host overlay…)
   * and notify subscribers.
   */
  closeActiveMenu: () => void;
  /**
   * Dismiss the link hover tooltip (`ui.linkHover`). The tooltip is an
   * interactive DOM popover the host renders; once the pointer is over it the
   * canvas sees no more moves, so the host signals dismissal here when the
   * pointer leaves the popover. Engine-internal off-link hover detection still
   * clears it on its own while the pointer is over the canvas.
   */
  clearLinkHover: () => void;
  /** Restore from snapshot - generates and broadcasts operations */
  restoreFromSnapshot: (blocks: Block[]) => void;
}

/**
 * The read facet of {@link EditorApi}, reached as `editor.query` — the mirror of
 * the {@link ChangeApi} write surface. Every method speaks the same
 * {@link DocPoint}/{@link DocRange} vocabulary and defaults to the live
 * caret/selection, so a read pairs symmetrically with its write:
 * `query.block(at)` ↔ `c.setBlock(attrs, at)`, `query.marks(at)` ↔
 * `c.setMark(name, { range })`. A host reads a {@link BlockData}'s id/attrs here
 * and hands them straight back to a {@link Editor.change} without reaching into
 * raw state. The selection itself — the caret/anchor `DocRange`
 * with offsets — is read off the reactive snapshot at
 * {@link EditorStateSnapshot.selection} (`editor.state.selection.range`), the
 * one place that value lives.
 */
export interface QueryApi<S extends SchemaDefinition = BaseSchemaDefinition> {
  /**
   * Plain-data view of the single block at `at` (default: the caret block), or
   * `null` when there's no such block. Address a specific block by id with
   * `block({ block: id })` (the common "find the block this overlay/menu
   * targets" pattern) — no scan of a raw block array.
   * The point counterpart to {@link blocks}: this takes a {@link DocPoint} and
   * returns one block, that takes a {@link DocRange} and returns the span.
   */
  block(at?: DocPoint): BlockData<S> | null;
  /**
   * The visible blocks the `range` touches, in document order — the same
   * {@link DocRange} the {@link ChangeApi} methods speak. Defaults to the
   * **selection**, so `blocks()` is "the blocks under the caret/selection"
   * (equivalently `blocks(editor.state.selection.range)`). Narrow to any span
   * without fetching-then-filtering; for the whole document pass
   * `{ from: "start", to: "end" }`. A collapsed range (or bare point) yields the
   * one block there; empty when the range can't be resolved.
   */
  blocks(range?: DocRange): BlockData<S>[];
  /**
   * The mark runs present at `at` (default: caret) — the data-carrying read for
   * "what link/math/custom-mark is under the caret". Each {@link MarkInfo}
   * carries the mark's `attrs` (a link's `{ url }`), the contiguous `range` of
   * that run, and its `text` (a link's text, a math chip's LaTeX). A run covers
   * the point when `from <= offset < to`; narrow on `range` for strictly-inside.
   *
   * For "is bold active here?" toolbar highlighting use the name-only
   * {@link EditorStateSnapshot.activeMarks} set instead — it is selection-aware
   * (intersection across a span) and includes pending caret toggles, which this
   * point read deliberately does not.
   */
  marks(at?: DocPoint): MarkInfo<S>[];
  /**
   * Detached snapshot of one structured attachment, addressed without knowing
   * its node class. Returns `null` for a missing block/content id.
   */
  content(blockId: string, contentId: string): StructuredDocument | null;
}

/**
 * The action/lifecycle surface implemented by {@link Editor}. Kept as a
 * standalone interface so the documentation lives in one place and the class
 * is compile-checked (`class Editor implements EditorApi`) against it.
 *
 * Organized by audience: the flat members here are the everyday
 * content/command surface; content reads live on the {@link QueryApi} `query`
 * facet (the mirror of {@link change}), geometry & decorations on the
 * {@link EditorViewApi} `view` facet, and chrome-building plumbing on the
 * {@link EditorHostApi} `host` facet. Engine-internal doc↔editor wiring and
 * mount-only window plumbing live on the separate {@link EditorWiring}
 * interface, so neither appears in the type a consumer holds.
 */
export interface EditorApi<S extends SchemaDefinition = BaseSchemaDefinition> {
  /**
   * Read-only state snapshot for UI binding: `{ selection, activeMarks,
   * canUndo, canRedo, isFocused, mode, isReadonlyBase, caretScratchActive }`.
   * The typed read surface for chrome — pair it with the {@link query} facet for
   * content reads and the {@link view} facet for geometry. The raw internal
   * `EditorState` is not exposed through this public contract — both
   * {@link subscribe} and {@link on} now deliver this snapshot. A first-party
   * host that genuinely needs raw state for advanced diffing reaches it via the
   * internal `subscribeRaw` (see `@tasfer/editor/internal`).
   */
  readonly state: EditorStateSnapshot;
  /** Content read facet (the mirror of {@link change}) — see {@link QueryApi}. */
  readonly query: QueryApi<S>;
  /** Geometry & ephemeral-paint facet — see {@link EditorViewApi}. */
  readonly view: EditorViewApi;
  /** Chrome-lifecycle facet — see {@link EditorHostApi}. */
  readonly host: EditorHostApi;
  /**
   * Tear down the editor: cancel the render loop and remove every canvas/input/
   * window event listener. For an editor created via
   * `createEditor`, call `TasferEditor.destroy` instead — it supersedes this and
   * also tears down the mount.
   */
  destroy: () => void;
  /**
   * Focus the editor and its hidden input surface so it can receive keyboard
   * and IME input. Does not create, clear, or reposition the model selection.
   */
  focus: () => void;
  /**
   * Blur the editor and its hidden input surface, clearing the model selection
   * and dismissing the soft keyboard.
   */
  blur: () => void;
  /**
   * Subscribe to state changes: the listener receives a fresh
   * {@link EditorStateSnapshot} after each render-loop diff and on direct
   * notifications (focus, mode, undo…). Fires on any state change — including
   * scroll/viewport ticks the filtered {@link on} events don't cover — so it's
   * the right hook for chrome that must reposition as the document moves (e.g. a
   * popover anchored to a caret coordinate). Returns an unsubscribe function. For
   * a filtered, self-describing alternative see {@link on}.
   */
  subscribe: (listener: (snapshot: EditorStateSnapshot) => void) => () => void;
  /**
   * Convenience event subscription — a thin, self-describing filter over
   * {@link Editor.subscribe} (see {@link EditorEvent}). Returns an unsubscribe
   * function. The `"change"` listener receives a {@link ChangeTransaction}
   * (`{ isRemote, ops }`); the others receive a fresh {@link EditorStateSnapshot}.
   */
  on(event: "change", callback: (tx: ChangeTransaction) => void): () => void;
  on(
    event: "selectionchange" | "focus" | "blur",
    callback: (snapshot: EditorStateSnapshot) => void,
  ): () => void;
  /**
   * Observe or override a mutation action (see `action`). The handler runs
   * inside the dispatch's single transaction and is handed the {@link ChangeApi}
   * — return `true` to claim the action and skip its default mutation, or
   * `false`/`void` to observe while still contributing edits. Higher `priority`
   * runs first (default `0`). Returns an unsubscribe fn.
   */
  registerAction<P>(
    action: MutationAction<P>,
    handler: MutationHandler<P>,
    priority?: number,
  ): () => void;
  /**
   * Register a handler for a action (see `action`). Higher `priority`
   * runs first (default `0`, above the editor's built-in defaults). Return
   * `true` to handle the action and stop propagation — skipping the default —
   * or `false`/`void` to observe and pass through. Returns an unsubscribe fn.
   */
  registerAction<P>(
    action: Action<P>,
    handler: ActionHandler<P>,
    priority?: number,
  ): () => void;
  /**
   * Dispatch a action through this editor's bus — the single entry point for all
   * three action kinds (see `action` / `stateAction`):
   * - **plain action** — runs its handlers; returns whether one claimed it.
   * - **mutation action** — the default plus all observers run inside ONE
   *   undoable transaction; returns whether the document changed.
   * - **state action** — its observers and (unless one claims it) its default
   *   transform run as one committed step, recorded to undo and broadcast when it
   *   emits ops; returns whether the editor state changed. This is how a host
   *   fires a node/mark's lower-level state behavior (e.g. a math chip's
   *   `EXIT_INLINE_MATH` caret exit) at the live editor.
   *
   * @see {@link Editor.registerAction}
   */
  dispatch<P>(action: Action<P>, ...args: DispatchArgs<P>): boolean;
  /** Serialize the current document to a Markdown string. */
  getMarkdown: () => string;
  /**
   * Replace the whole document with the given Markdown. Parsed via `loadPage`,
   * then applied as CRDT operations (the current blocks are deleted and the new
   * ones inserted) — so it is a single undoable step and is broadcast to peers,
   * exactly like any other edit. A no-op when the result is identical.
   */
  setMarkdown: (markdown: string) => void;
  /**
   * Apply document mutations as ONE undoable step. The callback receives a
   * {@link ChangeApi} whose methods chain; everything it queues commits
   * together — one undo entry, one broadcast, one `on("change")`. Returns
   * whether anything actually changed.
   */
  change: (fn: (c: ChangeApi<S>) => void) => boolean;
  /** Dry-run a {@link change}: would the queued mutations change anything now? */
  canChange: (fn: (c: ChangeApi<S>) => void) => boolean;
  /** Step local history backward; returns whether it changed the document. */
  undo: () => boolean;
  /** Step local history forward; returns whether it changed the document. */
  redo: () => boolean;
  /**
   * Place a collapsed caret at a {@link DocPoint} (default `"start"`), clearing
   * any selection, returning to `edit` mode, and notifying subscribers. The
   * point speaks the same stable vocabulary as the read/write API — `"start"`/
   * `"end"`, or an absolute `{ block, offset }`. Forces the caret to move unless
   * `onlyIfUnset` is passed, in which case it is a no-op when a cursor already
   * exists (seed-an-initial-caret). No-op when the point can't be resolved
   * (empty doc, unknown block). The selection it produces is read back at
   * {@link EditorStateSnapshot.selection} (`editor.state.selection.range`).
   */
  setCaret: (
    point?: Exclude<DocPoint, "caret">,
    opts?: { onlyIfUnset?: boolean },
  ) => void;
  /**
   * Place a selection spanning a {@link DocRange}, returning to `edit` mode and
   * notifying subscribers — e.g. to reveal a search match. A collapsed range (a
   * bare {@link DocPoint}) drops a caret; `{ from, to }` selects the span. No-op
   * when the range can't be resolved. Pass `null` to clear both the selection
   * and the caret — removing all selection/cursor visuals — and notify
   * subscribers.
   */
  setSelection: (range: DocRange | null) => void;
  /**
   * Copy a {@link DocRange} to the system clipboard and close any open context
   * menu. With no `docRange` (or `null`) it copies the current selection.
   * `selectRange` (default `false`) also moves the editor's selection to
   * `docRange` after copying; otherwise the current selection is left untouched
   * (copy is non-destructive). Resolves to whether the copy succeeded.
   */
  copy: (docRange?: DocRange | null, selectRange?: boolean) => Promise<boolean>;
  /**
   * Cut a {@link DocRange} to the system clipboard (one undoable step) and close
   * any open context menu. With no `docRange` (or `null`) it cuts the current
   * selection. `selectRange` (default `false`) leaves the caret collapsed at the
   * cut point (where the removed content was); otherwise the caller's original
   * caret/selection is restored after the cut. Resolves to whether anything was
   * cut.
   */
  cut: (docRange?: DocRange | null, selectRange?: boolean) => Promise<boolean>;
  /**
   * Paste from the system clipboard at the caret/selection (one undoable step)
   * and close any open context menu. Resolves to whether anything was pasted.
   */
  paste: () => Promise<boolean>;
  /**
   * Update this instance's theme. The patch is deep-merged onto the current
   * theme (tokens/fonts/strings shallow-merged, `styles` deep-merged), re-
   * resolved into the full style tree, and the editor re-renders. Use for live
   * theme changes — e.g. a host driving colors from CSS variables on a
   * dark-mode toggle calls `setTheme({ tokens })`.
   */
  setTheme: (patch: EditorTheme) => void;
}

/**
 * The doc↔editor wiring channel — the private plumbing `mountEditor` uses to
 * bind an attached {@link Doc} to an {@link Editor} (local edits → doc via
 * {@link setBroadcast}, merged doc updates → editor via {@link updatePageFromSync}).
 *
 * Deliberately NOT part of {@link EditorApi}: these are engine internals with no
 * semver guarantee. `Editor` implements both interfaces, so the concrete class
 * (reachable as `EditorClass` from `@tasfer/editor/internal`) carries them
 * while the public action/lifecycle type a consumer holds stays free of wiring.
 * A `@internal` JSDoc tag does not remove a member from a type — separating the
 * interfaces does. Hosts sync through the `Doc` API (`doc.applyUpdate` /
 * `doc.on("update")`), never by calling these directly.
 */
export interface EditorWiring {
  /**
   * Adopt a remotely-merged page (the doc→editor channel). Pass the merged
   * `remoteOps` so `on("change")` listeners fire with `isRemote: true` and the
   * applied ops. Driven by an attached `Doc` (see `mountEditor`'s `doc` option).
   */
  updatePageFromSync: (page: Page, remoteOps?: readonly Operation[]) => void;
  /**
   * Set the function that receives this editor's locally-produced ops. Set by
   * `mountEditor` to feed an attached `Doc` (`doc._ingestLocal`); pass `null` to
   * detach. Hosts observe local ops via `doc.on("update")`, not by installing a
   * callback here.
   */
  setBroadcast: (fn: ((ops: Operation[]) => void) | null) => void;
  /**
   * Route `copy`/`cut`/`paste` through a host-supplied clipboard instead of
   * `navigator.clipboard`. Native shells (iOS/Android WebViews) set this: their
   * async clipboard API is gated by a transient user activation a programmatic
   * clipboard op — e.g. one fired from a native context-menu callback — can't
   * satisfy, so it silently fails. Pass `null` to revert to the browser
   * clipboard (the web default). Engine-internal plumbing, off the public
   * {@link EditorApi}; reached via `EditorClass` from `@tasfer/editor/internal`.
   */
  setClipboard: (clipboard: HostClipboard | null) => void;
  /**
   * Raw state firehose — the listener receives the full internal
   * {@link EditorState} after each render-loop diff and on direct notifications.
   * The public {@link EditorApi.subscribe} is the snapshot-delivering wrapper
   * over this; `subscribeRaw` is the unstable escape hatch for a first-party host
   * that needs internal state the snapshot doesn't model (e.g. `ui.activeMenu`,
   * per-char formats). No semver guarantee — reachable via
   * `EditorClass` from `@tasfer/editor/internal`, never `EditorApi`.
   */
  subscribeRaw: (listener: (state: EditorState) => void) => () => void;
  /**
   * Update browser-window focus (affects selection color); re-renders. Driven by
   * `mountEditor`'s window focus/blur listeners — not a host-facing control.
   */
  /**
   * Whether a host pointer-capturing menu (the context menu) is currently open.
   * The engine maintains this from the menu's `OPEN_CONTEXT_MENU` /
   * `CLOSE_CONTEXT_MENU` lifecycle actions — a host shows its menu and dispatches
   * `CLOSE_CONTEXT_MENU` to dismiss it, never writing the flag itself. Read by
   * `mountEditor`'s focus backstops and the touch FSM.
   */
  isHostMenuCapturing: () => boolean;
}

// A pure (state) => ActionResult transform. Named distinctly from the
// action-bus `Action` type (imported above), which is a different concept.
type StateAction = (s: EditorState) => ActionResult;

/**
 * The canvas editor instance. Attaches the engine to a set of layered canvases
 * and (optionally) an accessible contenteditable input surface, runs the render
 * loop, and exposes the imperative action/lifecycle API ({@link EditorApi}).
 *
 * Every public member is an arrow-function field (bound to the instance) so the
 * surface survives being spread into a host handle (see `createEditor`). All
 * state is per-instance — no module-level globals — so multiple editors can
 * coexist on one page.
 */
export class Editor implements EditorApi<AnySchemaDefinition>, EditorWiring {
  // ── Canvas / input surface ────────────────────────────────────────────────
  private readonly contentCtx: CanvasRenderingContext2D;
  private readonly cursorCtx: CanvasRenderingContext2D;
  private readonly contentCanvas: HTMLCanvasElement;
  private readonly hiddenInput?: HTMLElement;
  // Mount-time baseline for native OS predictive text / autocorrect on the input
  // surface. Withheld while the caret is in verbatim source; see
  // `applyAutosuggestForCaret`.
  private readonly nativeAutocomplete: boolean = true;
  // Last-applied autosuggestion suppression, so the DOM attributes are only
  // rewritten on a transition (writing them every frame is wasteful and, mid-
  // typing, can disturb the keyboard's session). `false` matches the mount-time
  // baseline the surface starts with.
  private autosuggestSuppressed = false;
  // The accessible DOM mirror of the document (host reading surface). Undefined
  // when the host opted out or supplied no container. Patched in `emitChange`.
  private readonly a11yMirror?: DomMirror;

  // ── Core state ────────────────────────────────────────────────────────────
  private _state: EditorState;
  private viewport: ViewportState;

  // Per-instance pointer interaction state (in-flight gestures, auto-scroll,
  // tap tracking) and this editor's built-in chrome regions (scrollbar,
  // selection handles, peer indicators) — threaded into handleEvents so two
  // mounted editors never share gesture state.
  private readonly regionRegistry = createChromeRegionRegistry();
  private readonly session = createInteractionSession(this.regionRegistry);

  private animationFrameId: number | null = null;
  // Deferred blur-driven selection clear; cancelled if focus returns within
  // BLUR_SELECTION_CLEAR_DELAY (see applyBrowserFocus).
  private pendingSelectionClear: ReturnType<typeof setTimeout> | null = null;
  private documentHeight = 0;
  private visibility: VisibleBlockRange = { start: 0, end: 0, startY: 0 };
  private isRendering = false;

  // Auto-height mode: the canvas grows to fit its content instead of filling a
  // scroll region, so the scrollbar is suppressed and the host is told the
  // content height (via `onContentHeightChange`) so it can size the container.
  // Used for compact surfaces like a title field. `lastNotifiedContentHeight`
  // debounces the callback so the host only hears about real height changes.
  private readonly autoHeight: boolean;
  private readonly onContentHeightChange?: (height: number) => void;
  private lastNotifiedContentHeight = -1;

  // Broadcast function for sending operations to peers
  private broadcastFn: ((ops: Operation[]) => void) | null = null;

  // Host-supplied clipboard (native shells); null → use navigator.clipboard.
  private clipboard: HostClipboard | null = null;

  // Change-event channel. `on("change")` listeners receive a ChangeTransaction
  // ({ isRemote, ops }); this is distinct from the state-diff subscribe() path
  // that backs selectionchange/focus/blur.
  private readonly changeListeners: ((tx: ChangeTransaction) => void)[] = [];

  // Cache for canvas bounding rect to avoid getBoundingClientRect in render loop
  private cachedRect = { left: 0, top: 0 };
  private rectNeedsUpdate = true;

  // Dirty flags for each layer
  private dirtyLayers = {
    content: true, // Start with true for initial render
    cursor: true,
  };

  // Cache for document height (expensive to calculate)
  private cachedDocumentHeight = 0;
  private documentHeightDirty = true;
  private readonly blockHeights = new BlockHeightIndex();
  private pendingViewportAnchor: {
    position: Position;
    viewportOffsetY: number;
    remainingCorrections: number;
  } | null = null;

  private lastCursorBlinkState = false; // Track cursor blink state changes

  // Timestamp of the caret's most recent navigation, driving the "landing"
  // morph (circle → bar). `null` when no morph is in flight. See caret-landing.
  private caretLandingStartedAt: number | null = null;
  // Set when a mouse click (non-touch) is dispatched, so the landing morph plays
  // only when the caret *jumps* to a clicked location — not on keyboard movement
  // or touch. Consumed on the next rendered frame.
  private caretJumpPending = false;
  private readonly reducedMotionQuery =
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)")
      : null;

  private readonly eventsQueue: Event[] = [];
  // Printable physical keys commit through the contenteditable's input event,
  // which is later replayed as a synthetic key. Preserve the original source
  // across that handoff so host typeaheads can distinguish it from an IME key.
  private pendingTextInputSource: "hardware-keyboard" | "input-surface" | null =
    null;
  private readonly listeners: ((state: EditorState) => void)[] = [];

  // Store clipboard data separately since it gets detached after the event handler
  private pendingClipboardData: {
    html: string;
    text: string;
    imageFile: File | null;
  } | null = null;

  // ── Input-surface mirror (per-instance) ─────────────────────────────────────
  // `hiddenInput` is a contenteditable surface that holds either the current
  // selection's text (so native copy/cut and screen readers see real content) or
  // the SENTINEL followed by the text up to the caret, caret placed AFTER it. The
  // leading sentinel keeps Android GBoard emitting `deleteContentBackward` on
  // backspace and is a real word boundary so the keyboard predicts/autocorrects
  // the word (see SURFACE_SENTINEL).
  //
  // How much text trails the sentinel is platform-specific (see
  // `mirrorSentenceContext`): the current word on desktop, the current sentence
  // on mobile. All programmatic DOM mutation is wrapped in `isMirrorUpdating` so
  // the resulting input/selection events aren't mistaken for user edits, and
  // `lastSelectionSig` avoids recomputing the (potentially large) selection text
  // on every render frame.
  //
  // iOS uses an EMPTY sentinel; Android and desktop a single space. The space
  // gives Android GBoard a character before the caret so it keeps emitting
  // `deleteContentBackward` on backspace, and is a real word boundary so the
  // keyboard predicts/autocorrects the word (see SURFACE_SENTINEL). iOS doesn't
  // need it — it emits a real Backspace `keydown` — and the space actively breaks
  // WebKit autocapitalization: at a sentence start the surface would read " "
  // instead of empty, so WebKit never sees a fresh sentence and never capitalizes.
  // With an empty sentinel the surface is genuinely empty at a sentence boundary,
  // and `setMirror("")` leaves the DOM selection untouched (no `firstChild`), so
  // WebKit's shift-state survives and the OS capitalizes the first letter itself.
  private readonly SENTINEL = isIOS() ? "" : SURFACE_SENTINEL;
  // Mobile keyboards derive autocapitalization from the text before the caret, so
  // the surface must mirror real sentence context or the OS capitalizes every word
  // (glaringly in list items) — or, at a word boundary, would capitalize mid-
  // sentence words. At a sentence start the sentence slice is empty, which is
  // exactly the signal the keyboard needs to capitalize. Desktop keyboards don't
  // autocapitalize, so they mirror just the word for tighter predictions.
  private readonly mirrorSentenceContext = isAndroid() || isIOS();
  // Input-surface strategy (see the `inputStrategy` mount option). `"faithful"`
  // makes the contenteditable a real per-block field the OS keyboard reads full
  // context from; `"managed"` is the legacy sentinel+word puppet. Defaults to
  // faithful on iOS, where the managed surface cannot satisfy WebKit's stateful
  // autocapitalization (notably on new lines). Set in the constructor.
  private readonly inputStrategy: "managed" | "faithful";
  private isMirrorUpdating = false;
  private lastSelectionSig: string | null = null;
  // The last surface text the editor observed or wrote (begins with the sentinel
  // in caret mode; the iOS sentinel is empty). `hiddenInputHandler` diffs the new
  // surface against this to classify the edit (append / backspace / autocorrect
  // replacement).
  private lastSurfaceValue: string = this.SENTINEL;

  // Guards async work that settles after destroy() from poking a torn-down loop.
  private destroyed = false;

  // Track last rendered page to detect remote operation changes
  private lastRenderedPageRef: Page | null = null;

  // Track touch state to distinguish taps from scrolls
  private touchStartY = 0;
  private touchStartTime = 0;
  private touchHasMoved = false;
  private readonly TAP_THRESHOLD = 10; // pixels
  private readonly TAP_TIME_THRESHOLD = 300; // milliseconds

  // Click handler for focusing input (stored for cleanup)
  private canvasClickHandler: (() => void) | null = null;
  private desktopPointerListenersAttached = false;

  // Named actions (from the schema), resolvable by name from a keyboard
  // `shortcut`. A value is either a raw EditorAction or a listenable MutationAction.
  private schemaActions: Readonly<
    Record<string, EditorAction | MutationAction<void>>
  > = {};
  // Keybinding → action (name, inline, or MutationAction), checked ahead of
  // built-in keys. A MutationAction fires through `dispatch` so its observers run.
  private schemaShortcuts: Readonly<
    Record<string, string | EditorAction | MutationAction<void>>
  > = {};

  constructor(
    layers: CanvasLayers,
    initialState: EditorState,
    viewportProp: ViewportState,
    hiddenInput?: HTMLElement,
    config?: {
      actions?: Readonly<Record<string, EditorAction | MutationAction<void>>>;
      shortcuts?: Readonly<
        Record<string, string | EditorAction | MutationAction<void>>
      >;
      /** Host-owned container for the accessible DOM mirror (see DomMirror). */
      a11yContainer?: HTMLElement;
      /** Input-surface strategy; defaults per-platform (see `inputStrategy`). */
      inputStrategy?: "managed" | "faithful";
      /**
       * Baseline for native OS predictive text / autocorrect / autocapitalize on
       * the input surface (default true). Even when enabled, it is withheld while
       * the caret sits in verbatim source (math/code); see `applyAutosuggestForCaret`.
       */
      nativeAutocomplete?: boolean;
      /**
       * Grow the canvas to fit its content instead of filling a fixed viewport.
       * Suppresses the scrollbar and reports the content height through
       * `onContentHeightChange` so the host can resize the container.
       */
      autoHeight?: boolean;
      /**
       * Called (in auto-height mode) whenever the rendered content height
       * changes, so the host can resize the canvas/container to match.
       */
      onContentHeightChange?: (height: number) => void;
    },
  ) {
    // Extract contexts from layers
    this.contentCtx = layers.content.ctx;
    this.cursorCtx = layers.cursor.ctx;
    this.contentCanvas = layers.content.canvas;
    this.hiddenInput = hiddenInput;
    this.inputStrategy =
      config?.inputStrategy ?? (isIOS() ? "faithful" : "managed");
    this.nativeAutocomplete = config?.nativeAutocomplete !== false;
    this.autoHeight = config?.autoHeight ?? false;
    this.onContentHeightChange = config?.onContentHeightChange;

    this.schemaActions = config?.actions ?? {};
    this.schemaShortcuts = config?.shortcuts ?? {};

    this._state = initialState;
    this.viewport = viewportProp;

    // The accessible DOM mirror reads the document's blocks lazily, so it stays
    // correct as `_state` is replaced; it patches surgically off the op stream
    // (see emitChange). Only built when the host supplies a container.
    if (config?.a11yContainer) {
      this.a11yMirror = new DomMirror({
        container: config.a11yContainer,
        getBlocks: () => this._state.document.page.blocks,
      });
    }
    this.rebuildBlockHeightIndex();

    // Built-in action defaults. These sit below any host handler (registered
    // via editor.registerAction) on the bus, so a host can override them by
    // returning true — e.g. a native shell taking over OPEN_LINK. Observe-only
    // actions (haptics, gesture milestones) have no default and are dispatched
    // as-is.
    this._state.actionBus.register(
      OPEN_LINK,
      ({ url }) => {
        window.open(url, "_blank", "noopener,noreferrer");
        return true;
      },
      DEFAULT_ACTION_PRIORITY,
    );

    // The engine owns the `hostMenuCapturing` flag (per-instance interaction
    // state) but never names the context menu otherwise: it flips the flag on
    // the menu's lifecycle actions so it can arbitrate focus + touch (keep the
    // editor focused while a menu is up; route the long-press drag/release to
    // the host). These observe (return void) at high priority so they run
    // *before* a host claims OPEN — a host shows its menu and dispatches
    // CLOSE_CONTEXT_MENU to dismiss it; it never touches the flag directly.
    this._state.actionBus.register(
      OPEN_CONTEXT_MENU,
      () => {
        this.session.hostMenuCapturing = true;
      },
      Infinity,
    );
    this._state.actionBus.register(
      CLOSE_CONTEXT_MENU,
      () => {
        this.session.hostMenuCapturing = false;
      },
      Infinity,
    );

    // Initialize the editor and start the render loop.
    this.scheduleRender(); // Schedule initial render
    this.renderLoop();

    // Add click/mousedown handler to canvas as fallback for focusing input
    this.canvasClickHandler = () => {
      this.focus();
    };
    if (!isTouchOnlyDevice()) {
      this.desktopPointerListenersAttached = true;
      this.contentCanvas.addEventListener("mousedown", this.canvasClickHandler);

      this.contentCanvas.addEventListener("contextmenu", this.eventsHandler);
      this.contentCanvas.addEventListener("mousedown", this.eventsHandler);
      this.contentCanvas.addEventListener("mousemove", this.eventsHandler);
      this.contentCanvas.addEventListener("mouseup", this.eventsHandler);
      // Clear hover-driven chrome (image handles, link/math hovers) when the
      // pointer leaves the canvas; without this they stay painted until the
      // next mousemove, which never comes once the cursor is gone.
      this.contentCanvas.addEventListener("mouseleave", this.eventsHandler);
      this.contentCanvas.addEventListener("wheel", this.eventsHandler, {
        passive: false,
      });

      window.addEventListener("mouseup", this.windowMouseUpHandler);
      window.addEventListener("mousemove", this.windowMouseMoveHandler);
    }
    this.contentCanvas.addEventListener("click", this.canvasClickHandler);

    this.contentCanvas.addEventListener("touchstart", this.touchStartHandler, {
      passive: false,
    });
    this.contentCanvas.addEventListener("touchmove", this.touchMoveHandler, {
      passive: false,
    });
    this.contentCanvas.addEventListener("touchend", this.touchEndHandler, {
      passive: false,
    });
    this.contentCanvas.addEventListener("touchcancel", this.eventsHandler, {
      passive: false,
    });

    // Keyboard, IME, and clipboard are NOT captured on `window` — they flow
    // through the per-instance contenteditable surface below. This keeps two
    // editors on one page from clobbering each other's input (the old global
    // window keydown/paste listeners fired for every instance).

    // Invalidate rect cache when canvas position might change
    window.addEventListener("resize", this.invalidateRectCache);
    window.addEventListener("scroll", this.invalidateRectCache, true);
    window.addEventListener("focus", this.browserFocusHandler);
    window.addEventListener("blur", this.browserBlurHandler);

    // Set up input-surface handlers (keyboard, mobile, IME, clipboard).
    if (this.hiddenInput) {
      this.hiddenInput.addEventListener("focus", this.browserFocusHandler);
      this.hiddenInput.addEventListener("blur", this.browserBlurHandler);
      this.hiddenInput.addEventListener("input", this.hiddenInputHandler);
      this.hiddenInput.addEventListener(
        "keydown",
        this.hiddenInputKeyDownHandler,
      );

      // Add composition event listeners for IME support
      this.hiddenInput.addEventListener(
        "compositionstart",
        this.compositionStartHandler,
      );
      this.hiddenInput.addEventListener(
        "compositionupdate",
        this.compositionUpdateHandler,
      );
      this.hiddenInput.addEventListener(
        "compositionend",
        this.compositionEndHandler,
      );

      // Native clipboard events — synchronous copy/cut/paste on the selection.
      this.hiddenInput.addEventListener("copy", this.copyHandler);
      this.hiddenInput.addEventListener("cut", this.cutHandler);
      this.hiddenInput.addEventListener("paste", this.pasteHandler);

      // Ensure input is focusable (already set in mount.ts, but ensure it's correct)
      this.hiddenInput.setAttribute("tabindex", "0");

      // Seed the sentinel content so the surface is never empty before focus.
      this.resetSentinel();
    }

    // Font-family changes now flow through `setTheme` (which clears block caches
    // and re-renders), so there's no separate font-change subscription.

    // If fonts haven't loaded yet, re-render once they're ready
    // so text measurements use the correct font metrics
    onFontsReady(() => {
      clearAllBlockCaches(this._state.document.page.blocks);
      this.documentHeightDirty = true;
      this.rebuildBlockHeightIndex();
      this.scheduleRender();
    });
  }

  // Change-event funnel: patch the accessible mirror, then notify "change"
  // listeners with a ChangeTransaction. Both local edits and remote sync funnel
  // through here, so the mirror tracks either origin. The mirror reads the (now
  // updated) document and re-serializes only the blocks the ops touched.
  private emitChange = (ops: readonly Operation[], isRemote: boolean): void => {
    if (ops.length === 0) return;
    this.a11yMirror?.applyChange(ops);
    if (this.changeListeners.length === 0) return;
    const tx: ChangeTransaction = { isRemote, ops };
    for (const listener of this.changeListeners) listener(tx);
  };

  // Single funnel for locally-produced ops: broadcast to peers (when wired) and
  // notify change listeners as a local edit. Replaces the bare emitLocalOps(ops)
  // calls at every op site below.
  private emitLocalOps = (ops: Operation[]): void => {
    if (ops.length === 0) return;
    this.broadcastFn?.(ops);
    this.emitChange(ops, false);
  };

  /**
   * Execute a action that returns { state, ops } and broadcast operations to peers.
   * This is the central point for all state-modifying operations.
   */
  private executeAction = (result: ActionResult): void => {
    const { state: newState, ops } = result;
    const prevState = this._state;

    // Update local state and record to undo stack (pass both before/after states for cursor restoration)
    this._state =
      ops.length > 0
        ? recordUndoOps(
            prevState,
            newState,
            ops,
            this._state.CRDTbinding.getPeerId(),
          )
        : newState;
    this._state = reconcileContentSelectionState(this._state);

    // Broadcast ops to peers (if any)
    if (ops.length > 0 && this.broadcastFn) {
      this.emitLocalOps(ops);
    }

    // Trigger re-render
    this.scheduleRender();

    // Notify listeners
    const currentState = this._state;
    this.listeners.forEach((listener) => listener(currentState));
  };

  // Keep the caret/selection inside this editor's block window — a no-op for a
  // full-document editor (window undefined). Local navigation can resolve a
  // target block outside the window (the block-boundary helpers scan the whole
  // page), and a remote edit can shift the windowed block out from under a stale
  // caret; in both cases we snap back to the nearest in-window block, at the edge
  // the caret was heading toward, so a single-block TitleEditor's caret never
  // escapes into the body it doesn't render.
  private clampToWindow = (state: EditorState): EditorState => {
    const window = state.view.window;
    if (!window) return state;
    const blocks = state.document.page.blocks;
    const included = window.select(blocks);
    if (included.size === 0) return state;
    const sorted = [...included].sort((a, b) => a - b);
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const clampPos = (pos: Position): Position => {
      if (included.has(pos.blockIndex) && !blocks[pos.blockIndex]?.deleted) {
        return pos;
      }
      const target = pos.blockIndex < first ? first : last;
      const atStart = pos.blockIndex < target;
      return {
        blockIndex: target,
        textIndex: atStart ? 0 : getBlockTextContent(blocks[target]).length,
      };
    };
    let cursor = state.document.cursor;
    if (cursor) {
      const pos = clampPos(cursor.position);
      if (pos !== cursor.position) cursor = { ...cursor, position: pos };
    }
    let selection = state.document.selection;
    if (selection) {
      const anchor = clampPos(selection.anchor);
      const focus = clampPos(selection.focus);
      if (anchor !== selection.anchor || focus !== selection.focus) {
        selection = {
          ...selection,
          anchor,
          focus,
          isCollapsed:
            anchor.blockIndex === focus.blockIndex &&
            anchor.textIndex === focus.textIndex,
        };
      }
    }
    if (
      cursor === state.document.cursor &&
      selection === state.document.selection
    ) {
      return state;
    }
    return { ...state, document: { ...state.document, cursor, selection } };
  };

  private updateCachedRect = () => {
    const containerRect = this.contentCanvas.getBoundingClientRect();
    this.cachedRect = {
      left: containerRect.left,
      top: containerRect.top,
    };
    this.rectNeedsUpdate = false;
  };

  /**
   * Mark that content layer needs re-rendering (expensive operation).
   * This is called when page content, selection, or viewport changes.
   */
  private scheduleRender = () => {
    this.dirtyLayers.content = true;
    this.dirtyLayers.cursor = true; // Cursor position may have changed too
  };

  // Passed into the renderer so async work (image decode, math typeset) can
  // request a repaint when its cache populates. Guarded so a promise that
  // settles after destroy() is a no-op instead of poking a torn-down loop.
  private requestRedraw = () => {
    if (!this.destroyed) this.scheduleRender();
  };

  // Update canvas cursor style based on scrollbar hover and drag state
  private updateCursorStyle = (
    isHoveringScrollbar: boolean,
    isDragging: boolean,
    isHoveringLinkWithModifier: boolean,
    dragHandleHover: "left" | "right" | "bottom" | null = null,
    isHoveringCheckbox: boolean = false,
    isHoveringPeerIndicator: boolean = false,
    isHoveringMath: boolean = false,
    isHoveringDragHandle: boolean = false,
    isDraggingBlock: boolean = false,
  ) => {
    // Only update the pointer cursor when a fine pointer is available.
    if (isTouchOnlyDevice()) {
      return;
    }

    if (isDragging || isDraggingBlock) {
      // Dragging the scrollbar or reordering a block — closed-hand cursor.
      this.contentCanvas.style.cursor = "grabbing";
    } else if (isHoveringDragHandle) {
      // Hovering a block's reorder grip — open-hand "grab" affordance.
      this.contentCanvas.style.cursor = "grab";
    } else if (dragHandleHover) {
      // When hovering over a drag handle, use resize cursor
      if (dragHandleHover === "left" || dragHandleHover === "right") {
        this.contentCanvas.style.cursor = "ew-resize"; // Horizontal resize
      } else if (dragHandleHover === "bottom") {
        this.contentCanvas.style.cursor = "ns-resize"; // Vertical resize
      }
    } else if (isHoveringScrollbar) {
      // When hovering over scrollbar, use pointer cursor
      this.contentCanvas.style.cursor = "pointer";
    } else if (isHoveringLinkWithModifier) {
      // When hovering over link with Ctrl/Cmd held, use pointer cursor
      this.contentCanvas.style.cursor = "pointer";
    } else if (isHoveringCheckbox) {
      // When hovering over todo checkbox, use pointer cursor
      this.contentCanvas.style.cursor = "pointer";
    } else if (isHoveringPeerIndicator) {
      // When hovering over out-of-view peer indicator, use pointer cursor
      this.contentCanvas.style.cursor = "pointer";
    } else if (isHoveringMath) {
      // Inline math chip — clickable (opens the chip editor)
      this.contentCanvas.style.cursor = "pointer";
    } else {
      // When hovering over text, use text cursor
      this.contentCanvas.style.cursor = "text";
    }
  };

  // Drain the queued DOM events into document state: apply them, record undo,
  // broadcast ops, and dispatch a queued image paste. Returns the state as it
  // was BEFORE draining (the render loop diffs against it to choose dirty
  // layers). Also called by `flushPendingInput` to settle pending keystrokes
  // synchronously before an out-of-band edit (an autocorrect replacement) so
  // that edit addresses an up-to-date document.
  private processQueuedEvents = (): EditorState => {
    const prevState = this._state;

    const handleEventsResult = handleEvents(
      this._state,
      this.viewport,
      this.visibility,
      this.eventsQueue,
      this.documentHeight,
      this.cachedRect,
      this.session,
      this.updateViewport,
      this.pendingClipboardData,
      this.scrollPositionIntoView,
    );

    this._state = handleEventsResult.state;

    // Contain the caret/selection within this editor's block window (no-op when
    // unwindowed) before recording undo, so a windowed editor's navigation can
    // never leave a caret pointing at a block it doesn't render.
    this._state = this.clampToWindow(this._state);
    this._state = reconcileContentSelectionState(this._state);

    // Record operations to undo stack (only if not from undo/redo). Undo/redo
    // already updates undoManager internally, so check if it changed.
    if (handleEventsResult.ops.length > 0) {
      const undoManagerChanged =
        prevState.undoManager !== this._state.undoManager;
      if (!undoManagerChanged) {
        this._state = recordUndoOps(
          prevState,
          this._state,
          handleEventsResult.ops,
          this._state.CRDTbinding.getPeerId(),
        );
      }
      if (this.broadcastFn) {
        this.emitLocalOps(handleEventsResult.ops);
      }
    }

    // Dispatch the IMAGE_PASTE action if an image file was pasted. A node may
    // claim it (return true) to handle its own upload; the host observes it at
    // priority 0 to upload + rewrite the block url.
    if (
      this.pendingClipboardData?.imageFile &&
      handleEventsResult.pastedImageBlockIndex !== undefined
    ) {
      const file = this.pendingClipboardData.imageFile;
      const blockIndex = handleEventsResult.pastedImageBlockIndex;
      // Resolve to a stable id now (index is valid at this tick) so the host's
      // async upload addresses the right block even if it shifts meanwhile.
      const pastedBlock = this._state.document.page.blocks[blockIndex];
      if (pastedBlock) {
        this.dispatch(IMAGE_PASTE, { file, blockId: pastedBlock.id });
      }
    }

    // Clear clipboard data after it's been used
    this.pendingClipboardData = null;

    return prevState;
  };

  // Settle any queued keystrokes into the document immediately. The event queue
  // normally drains on the next animation frame; an out-of-band edit that uses
  // absolute document offsets (the autocorrect-replacement path) must flush it
  // first so those offsets are computed against the real, current document.
  private flushPendingInput = () => {
    if (this.eventsQueue.length === 0) return;
    this.processQueuedEvents();
    this.scheduleRender();
  };

  // Render a single frame synchronously
  private renderFrame = async () => {
    if (this.isRendering) return;
    this.isRendering = true;

    try {
      // Check if page changed since last render (handles remote ops that bypass handleEvents)
      if (this.lastRenderedPageRef !== this._state.document.page) {
        this._state.view.visibleBlocks = getVisibleBlocks(
          this._state.document.page,
          this._state.view.window,
        );
        this.dirtyLayers.content = true;
        this.dirtyLayers.cursor = true;
        this.documentHeightDirty = true;
        this.reconcileBlockHeightIndex();
        this.lastRenderedPageRef = this._state.document.page;
      }

      // Update cached rect only when needed (avoids expensive getBoundingClientRect every frame)
      if (this.rectNeedsUpdate) {
        this.updateCachedRect();
      }

      // Drain queued DOM events into document state (also returns the
      // pre-drain state the dirty-layer checks below diff against).
      const prevState = this.processQueuedEvents();

      // Check if state changed or if there are events that require rendering
      const stateChanged = prevState !== this._state;

      // Determine what changed to decide which layers to update
      if (stateChanged) {
        // Check if page content changed (requires content layer update)
        if (prevState.document.page !== this._state.document.page) {
          this._state.view.visibleBlocks = getVisibleBlocks(
            this._state.document.page,
            this._state.view.window,
          ); // ADD HERE
          this.dirtyLayers.content = true;
          this.dirtyLayers.cursor = true; // Cursor position may have changed
          this.documentHeightDirty = true; // Blocks changed, need to recalculate height
          this.reconcileBlockHeightIndex();
        }

        // Check if selection changed (requires content layer update)
        if (prevState.document.selection !== this._state.document.selection) {
          this.dirtyLayers.content = true;
        }
        if (
          prevState.document.contentSelection !==
          this._state.document.contentSelection
        ) {
          this.dirtyLayers.content = true;
          this.dirtyLayers.cursor = true;
        }

        // Check if cursor position changed (requires cursor layer update)
        const cursorPositionChanged =
          prevState.document.cursor?.position !==
          this._state.document.cursor?.position;
        const contentCaretPositionChanged =
          prevState.document.contentSelection?.focus !==
          this._state.document.contentSelection?.focus;
        const caretPositionChanged =
          cursorPositionChanged || contentCaretPositionChanged;
        if (caretPositionChanged) {
          this.dirtyLayers.cursor = true;
        }

        // Start the caret "landing" morph only when the caret *jumps* to a
        // clicked location (mouse only — `caretJumpPending`). Not on keyboard
        // movement, not on touch, and not when it advances because content was
        // typed or deleted (a content edit swaps the page reference).
        const contentChanged =
          prevState.document.page !== this._state.document.page;
        if (
          this.caretJumpPending &&
          caretPositionChanged &&
          !contentChanged &&
          (prevState.document.cursor || prevState.document.contentSelection) &&
          (this._state.document.cursor ||
            this._state.document.contentSelection) &&
          !this.reducedMotionQuery?.matches
        ) {
          this.caretLandingStartedAt = Date.now();
        }

        // Check if focus changed (affects cursor visibility)
        if (prevState.view.isFocused !== this._state.view.isFocused) {
          this.dirtyLayers.cursor = true;
        }

        // Check if scrollbar state changed (for fade animation)
        if (prevState.view.scrollbar !== this._state.view.scrollbar) {
          this.dirtyLayers.content = true;
        }

        // Math hover state changes affect rendered chip/block backgrounds. The
        // inline-math edit popover also styles its chip as hovered — the open
        // path records that range in `inlineMathHover`, so this check covers it.
        if (
          prevState.ui.inlineMathHover !== this._state.ui.inlineMathHover ||
          prevState.ui.hoveredMathBlockIndex !==
            this._state.ui.hoveredMathBlockIndex
        ) {
          this.dirtyLayers.content = true;
        }
      }

      // Check if cursor blink state changed (for cursor animation)
      const activeCaretForBlink =
        this._state.document.cursor ??
        (this._state.document.contentSelection
          ? {
              position: { blockIndex: 0, textIndex: 0 },
              lastUpdate: this._state.document.contentSelection.lastUpdate ?? 0,
            }
          : null);
      const currentCursorBlinkState = activeCaretForBlink
        ? isCursorBlinking(activeCaretForBlink, getEditorStyles(this._state))
        : false;
      const cursorBlinkChanged =
        this.lastCursorBlinkState !== currentCursorBlinkState;
      this.lastCursorBlinkState = currentCursorBlinkState;

      // Cursor blink only affects cursor layer
      if (cursorBlinkChanged) {
        this.dirtyLayers.cursor = true;
      }

      // A pending jump is consumed by the frame that follows its click, whether
      // or not the caret ended up moving — never let it carry into a later frame
      // and mis-trigger on keyboard movement.
      this.caretJumpPending = false;

      // Keep the cursor layer repainting while a caret-landing morph is in
      // flight, then clear the marker so the caret settles to a static bar.
      if (this.caretLandingStartedAt !== null) {
        const elapsed = Date.now() - this.caretLandingStartedAt;
        const landingDuration = getEditorStyles(this._state).cursor
          .landingDuration;
        if (elapsed >= landingDuration) {
          this.caretLandingStartedAt = null;
        } else {
          this.dirtyLayers.cursor = true;
        }
      }

      // Render dirty layers
      const needsAnyRender =
        this.dirtyLayers.content || this.dirtyLayers.cursor;

      if (needsAnyRender) {
        let viewportChangedAfterPaint = false;
        // Render content layer if dirty (expensive)
        if (this.dirtyLayers.content) {
          // Recalculate document height only when needed
          if (this.documentHeightDirty) {
            this.cachedDocumentHeight = this.calculateDocumentHeight();
            this.documentHeightDirty = false;
          }

          // Pre-calculate document height to clamp viewport before rendering
          const maxScroll = Math.max(
            0,
            this.cachedDocumentHeight - this.viewport.height,
          );
          if (this.viewport.scrollY > maxScroll) {
            this.applyProgrammaticScroll(maxScroll);
          }

          // Render the page content (text, blocks, selection, scrollbar)
          // Drag handles are now rendered within renderImageBlock for consistency
          this.documentHeight = renderPage(
            this.contentCtx,
            this._state,
            this.viewport,
            this.visibility,
            undefined,
            this.requestRedraw,
            this.blockHeights,
            this.autoHeight,
          );
          this.cachedDocumentHeight = this.documentHeight;
          this.viewport = {
            ...this.viewport,
            documentHeight: this.documentHeight,
          };

          // Auto-height: the editor owns its viewport height, growing it to the
          // content. It then tells the host to resize the DOM canvas/container
          // to match (the host callback touches the DOM only, never this editor,
          // so it's safe even during the synchronous first paint in the
          // constructor). This frame already painted at the old height, so
          // schedule a repaint at the new one.
          if (
            this.autoHeight &&
            this.documentHeight !== this.lastNotifiedContentHeight
          ) {
            this.lastNotifiedContentHeight = this.documentHeight;
            this.viewport = { ...this.viewport, height: this.documentHeight };
            this.onContentHeightChange?.(this.documentHeight);
            this.scheduleRender();
          }

          const anchor = this.pendingViewportAnchor;
          if (anchor) {
            const coords = this.coordsAtIndexPosition(anchor.position);
            const delta = coords ? coords.y - anchor.viewportOffsetY : 0;
            if (coords && Math.abs(delta) > 0.5) {
              const maxScroll = Math.max(
                0,
                this.documentHeight - this.viewport.height,
              );
              const scrollY = Math.max(
                0,
                Math.min(maxScroll, this.viewport.scrollY + delta),
              );
              viewportChangedAfterPaint = scrollY !== this.viewport.scrollY;
              this.applyProgrammaticScroll(scrollY);
            }
            anchor.remainingCorrections--;
            if (
              !viewportChangedAfterPaint ||
              anchor.remainingCorrections <= 0 ||
              !coords
            ) {
              this.pendingViewportAnchor = null;
            }
          }

          // Update cursor style based on scrollbar hover and drag state
          this.updateCursorStyle(
            this._state.view.scrollbar.isHovered,
            this._state.view.scrollbar.isDragging,
            this._state.ui.isHoveringLinkWithModifier,
            this._state.ui.imageHover?.hoveredHandle || null,
            this._state.ui.isHoveringCheckbox,
            this._state.ui.isHoveringPeerIndicator,
            // Inline chips are clickable (→ pointer); a block equation is
            // editable text, so it keeps the text caret even while hovered.
            this._state.ui.inlineMathHover !== null,
            this._state.ui.hoveredDragHandleBlockId !== null,
            this._state.ui.blockDrag !== null,
          );

          this.dirtyLayers.content = viewportChangedAfterPaint;
          if (viewportChangedAfterPaint) this.dirtyLayers.cursor = true;
        }

        // Render cursor layer if dirty (very cheap!)
        if (this.dirtyLayers.cursor && !viewportChangedAfterPaint) {
          renderCursorLayer(
            this.cursorCtx,
            this.session,
            this._state,
            this.viewport,
            getEditorStyles(this._state),
            this.blockHeights,
            this.caretLandingStartedAt,
          );
          this.dirtyLayers.cursor = false;
        }

        // Update hidden input position to match cursor for IME composition toolbar
        if (
          this.hiddenInput &&
          this._state.document.cursor &&
          this._state.view.isFocused &&
          !viewportChangedAfterPaint
        ) {
          const isComposing = this._state.ui.composition?.isComposing;
          const cursorCoords = isComposing
            ? getCursorCoordinatesWithComposition(this._state, this.viewport)
            : this.coordsAtIndexPosition(this._state.document.cursor.position);
          if (cursorCoords) {
            this.hiddenInput.style.left = `${cursorCoords.x}px`;
            const viewportY = isComposing
              ? cursorCoords.y - this.viewport.scrollY
              : cursorCoords.y;
            this.hiddenInput.style.top = `${viewportY + cursorCoords.height}px`;
          }
        }

        // Mirror the model selection into the input surface so native copy/cut
        // and screen readers operate on real text. Skipped during IME
        // composition (the browser owns the surface content then).
        if (
          this.hiddenInput &&
          this._state.view.isFocused &&
          !this._state.ui.composition?.isComposing
        ) {
          this.syncMirrorToSelection();
        }

        // Notify listeners only if state changed
        if (stateChanged) {
          const currentState = this._state;
          this.listeners.forEach((listener) => listener(currentState));
        }
      }
    } finally {
      this.isRendering = false;
    }
  };

  // Render loop
  // The loop continues running via requestAnimationFrame for smooth interactions,
  // but the actual canvas rendering only happens when needed (via the needsRender flag)
  private renderLoop = () => {
    this.renderFrame();
    this.animationFrameId = requestAnimationFrame(this.renderLoop);
  };

  private eventsHandler = (e: Event) => {
    // Ignore keyboard events from hidden input - those are handled separately
    if (e instanceof KeyboardEvent && e.target === this.hiddenInput) {
      return;
    }

    // Don't process keyboard/paste events targeting other interactive elements
    // (e.g., dialog inputs, search bars) — those belong to the other element
    if (
      (e instanceof KeyboardEvent || e.type === "paste") &&
      e.target instanceof HTMLElement &&
      e.target !== this.hiddenInput
    ) {
      const tag = e.target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || e.target.isContentEditable) {
        return;
      }
    }

    // On desktop, if hidden input is focused, ignore window keyboard events
    // (they should come through the hidden input instead for IME support)
    if (
      e instanceof KeyboardEvent &&
      e.target === window &&
      document.activeElement === this.hiddenInput
    ) {
      return;
    }

    // Only process keyboard and paste events if editor is focused
    if (e instanceof KeyboardEvent || e.type === "paste") {
      // Check if editor is focused before handling keyboard/paste events
      if (!this._state.view.isFocused) {
        return;
      }
    }

    if (
      e instanceof KeyboardEvent &&
      ["Enter", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(
        e.key,
      )
    ) {
      e.preventDefault();
    }
    // Prevent default on wheel, touchmove, and contextmenu to avoid browser interference
    if (
      e.type === "wheel" ||
      e.type === "touchmove" ||
      e.type === "contextmenu"
    ) {
      e.preventDefault();
    }

    // Keep focus on the hidden input across a primary-button press. The canvas
    // isn't focusable, so WebKit's default mousedown action moves focus to
    // <body> — and that runs *after* `canvasClickHandler` re-focuses the input,
    // so the input is blurred a moment later. That stray blur schedules the
    // deferred selection-clear, which on a drag longer than the clear delay fires
    // mid-gesture and collapses the in-progress selection (the anchor then
    // re-pins at the pointer). Suppressing the default keeps focus put; the
    // explicit `focus()` in `canvasClickHandler` still runs. Right-click is left
    // alone (its focus/context-menu path is handled separately), and
    // selectstart/dragstart are already prevented on the canvas.
    if (e.type === "mousedown" && (e as MouseEvent).button === 0) {
      e.preventDefault();
      // A left click that lands the caret elsewhere is a "jump" — arm the
      // landing morph for this frame. Ignored on touch (where `mousedown` is
      // synthesized but never places the caret).
      if (!isTouchOnlyDevice()) this.caretJumpPending = true;
    }

    // Paste is handled by the contenteditable surface's `paste` listener
    // (pasteHandler), which extracts the clipboard data synchronously and
    // queues the event. eventsHandler no longer receives paste/keydown.

    this.eventsQueue.push(e);
    this.scheduleRender(); // Mark that we need to render due to this event
  };

  // Window-level mouse handlers to catch events outside canvas
  private windowMouseUpHandler = (e: Event) => {
    this.eventsQueue.push(e);
  };

  private windowMouseMoveHandler = (e: Event) => {
    // Forward window-level moves whenever a drag owns the pointer, so a gesture
    // that runs past the canvas edge keeps being tracked. Text selection is a
    // mode (not a captured region); scrollbar/image-resize/block-reorder are
    // captured region drags. A captured drag needs these to reach its edge zone:
    // a fast flick can jump from mid-canvas straight past the bottom without a
    // canvas mousemove ever landing in the 80px edge band, so without the
    // window move its edge auto-scroll would never activate. Named
    // node-agnostically via `session.captured` — no region type appears here.
    if (
      this._state &&
      (this._state.view.scrollbar.isDragging ||
        this._state.ui.mode === "select" ||
        this.session.captured !== null)
    ) {
      this.eventsQueue.push(e);
    }
  };

  private applyBrowserFocus = (focused: boolean) => {
    // Regaining focus cancels any pending blur-driven clear. A blur that bounces
    // straight back must not destroy the current selection — on Android the
    // WebView synthesizes mouse/click events after `touchend` that move focus to
    // <body> and immediately back, which would otherwise wipe a double-tap word
    // selection milliseconds after it appears (iOS doesn't fire that blur).
    if (focused) this.cancelPendingSelectionClear();

    const focusChanged = this._state.view.isFocused !== focused;
    // Defer clearing the selection on blur rather than doing it inline: the clear
    // only happens if focus has NOT returned by the time the timer fires.
    //
    // While a host menu is up the editor is intentionally blurred (a native menu
    // or popover took focus), but the selection must survive — its actions (copy,
    // cut, formatting) still target it. The menu clears `hostMenuCapturing` via
    // CLOSE_CONTEXT_MENU, and a later real blur schedules the clear as usual.
    // A mid-drag blur must never tear down the selection being built. The
    // desktop selection mirror (and other focus churn) can momentarily blur the
    // hidden input while the pointer is still down; if the deferred clear then
    // fires before focus returns, `updateSelectionFocus` sees a null selection on
    // the next move and re-anchors at the pointer — collapsing everything dragged
    // so far ("less selection, not where I started"). An in-progress drag owns
    // the selection until mouseup flips the mode back to `edit`.
    if (
      !focused &&
      this._state.document.selection !== null &&
      this._state.ui.mode !== "select" &&
      !this.session.hostMenuCapturing
    ) {
      this.scheduleSelectionClearOnBlur();
    }
    if (!focusChanged) return;

    this._state = updateFocus(this._state, focused);

    // A focused editable editor must always hold a caret (or a selection):
    // focus can be granted outside the pointer-resolution paths — the canvas
    // click fallback after a touch that didn't qualify as a tap, a host calling
    // `focus()` bare, Tab onto the input surface — and without a caret the
    // editor looks focused (ring, keyboard) but every keystroke is a no-op.
    // Seed the document start, clamped into the view window (a windowed title
    // editor must never hold a caret outside its window); a tap/click that
    // resolves a position places its own caret over this in the same frame
    // (pointer events are processed from the queue after this synchronous focus
    // handler). An existing selection is left alone — focus returning from a
    // menu/popover must not collapse it.
    if (
      focused &&
      !this._state.ui.isReadonlyBase &&
      this._state.document.selection === null &&
      this._state.document.cursor === null
    ) {
      const resolved = resolvePoint(this._state, "start");
      if (resolved) {
        this._state = this.clampToWindow(
          updateMode(
            updateCursor(this._state, {
              blockIndex: resolved.blockIndex,
              textIndex: resolved.offset,
            }),
            "edit",
          ),
        );
      }
    }

    // Re-assert the input surface's DOM caret now that focus is here. The
    // sentinel is seeded while the surface is unfocused (setMirror cannot place
    // a DOM caret then), and a browser granting focus without an explicit
    // selection parks the caret at offset 0 — BEFORE the sentinel. The
    // render-loop resync alone leaves a one-frame window where the first
    // keystroke lands before the sentinel and the reconciliation leaks the
    // sentinel space into the document as a spurious space; syncing here, in
    // the synchronous focus handler, closes it. Skipped mid-composition (the
    // browser owns the surface content then), like the render-loop call.
    if (focused && !this._state.ui.composition?.isComposing) {
      this.syncMirrorToSelection();
    }

    this.scheduleRender();
    const currentState = this._state;
    this.listeners.forEach((listener) => listener(currentState));
  };

  private cancelPendingSelectionClear = () => {
    if (this.pendingSelectionClear !== null) {
      clearTimeout(this.pendingSelectionClear);
      this.pendingSelectionClear = null;
    }
  };

  private scheduleSelectionClearOnBlur = () => {
    if (this.pendingSelectionClear !== null) return; // already scheduled
    this.pendingSelectionClear = setTimeout(() => {
      this.pendingSelectionClear = null;
      // Focus came back, or the selection is already gone — nothing to clear.
      if (this._state.view.isFocused) return;
      // A host menu opened after this was scheduled — keep the selection alive
      // for its actions until the menu closes.
      if (this.session.hostMenuCapturing) return;
      // A drag-select started after this was scheduled — never clear the
      // selection out from under an in-progress gesture (it would re-anchor at
      // the pointer on the next move).
      if (this._state.ui.mode === "select") return;
      if (this._state.document.selection === null) return;
      this._state = clearSelection(this._state);
      this.scheduleRender();
      const currentState = this._state;
      this.listeners.forEach((listener) => listener(currentState));
    }, BLUR_SELECTION_CLEAR_DELAY);
  };

  private syncBrowserFocus = () => {
    this.applyBrowserFocus(
      document.hasFocus() && document.activeElement === this.hiddenInput,
    );
  };

  private browserFocusHandler = () => {
    this.syncBrowserFocus();
  };

  // True while an in-progress touch gesture should hold the soft keyboard open.
  // On Android the WebView blurs the focused hidden input to <body> partway
  // through any touch hold (the touch lands on the canvas, not the input), which
  // dismisses the keyboard and threatens to clear an in-progress selection — even
  // though the gesture never left the editor; iOS doesn't fire this blur. Covers
  // both gestures that hold while the keyboard should stay up: a long-press
  // drag-select and a cursor-drag (the magnifier loupe repositioning the caret).
  // Excludes the menu-takeover case: a long-press on existing selected text opens
  // the context menu, which legitimately takes focus (`hostMenuCapturing`).
  private shouldHoldKeyboardForTouch = (): boolean =>
    isTouchDevice() &&
    !!this.hiddenInput &&
    !this.session.hostMenuCapturing &&
    !this._state.ui.isReadonlyBase &&
    (isInLongPressMode(this.session) ||
      this.session.touch?.isCursorDrag === true);

  // Re-grab focus for the hidden input if it drifted off during a touch gesture,
  // so the keyboard stays up (see shouldHoldKeyboardForTouch).
  private reassertTouchSelectionFocus = () => {
    if (!this.shouldHoldKeyboardForTouch()) return;
    if (document.activeElement === this.hiddenInput) return;
    try {
      this.hiddenInput?.focus({ preventScroll: true });
    } catch {
      // Ignore — focus can throw if the element is detached mid-teardown.
    }
  };

  private browserBlurHandler = () => {
    // Re-grab focus and swallow the transient blur during a touch gesture so the
    // keyboard stays up. If focus can't be reclaimed, fall through and record the
    // blur as usual.
    if (this.shouldHoldKeyboardForTouch()) {
      this.reassertTouchSelectionFocus();
      if (document.activeElement === this.hiddenInput) return;
    }
    this.applyBrowserFocus(false);
  };

  // Handle touchstart - track for tap detection
  private touchStartHandler = (e: TouchEvent) => {
    // Refresh the cached canvas rect at the start of every touch gesture: the
    // tap pipeline turns `touch.clientX/Y` into canvas coords by subtracting
    // this rect, and the cache is otherwise only invalidated on `window`
    // resize/scroll and `updateViewport`. A host can move the canvas without any
    // of those firing — e.g. a bottom sheet that raises itself above the soft
    // keyboard on focus. On iOS (Capacitor keyboard `resize: "none"`) opening
    // the keyboard fires no window resize and no window scroll, so the rect goes
    // stale, every tap's Y is measured against the old canvas position, and in a
    // short editor the point falls above all blocks and collapses to offset 0 —
    // the caret appears frozen. Reading the rect once per gesture (not per
    // frame) is cheap and keeps taps addressing the canvas's real position.
    this.invalidateRectCache();

    // Store touch start info for tap detection
    if (e.touches.length > 0) {
      this.touchStartY = e.touches[0].clientY;
      this.touchStartTime = Date.now();
      this.touchHasMoved = false;
    }

    // Keep the soft keyboard up across canvas touch gestures. On Android the
    // WebView otherwise runs its own long-press / selection handling on the
    // touch and blurs the focused hidden input to <body> mid-gesture (the touch
    // lands on the canvas, not the input), dismissing the keyboard. Preventing
    // the touchstart default stops that native gesture at the source while the
    // editor owns the keyboard: the engine drives scrolling and selection from
    // touchmove, and a fresh tap's focus is granted explicitly in
    // touchEndHandler, so nothing here depends on the default. Scoped to a
    // single-finger touch on an already-focused, editable surface so multi-touch
    // scroll and the unfocused first-tap-to-focus path are untouched. iOS never
    // fires the blur; preventing here is a harmless no-op there.
    if (
      isTouchDevice() &&
      e.cancelable &&
      e.touches.length === 1 &&
      this._state.view.isFocused &&
      !this._state.ui.isReadonlyBase
    ) {
      e.preventDefault();
    }

    // Process the touch event normally (for scrolling, etc.)
    this.eventsHandler(e);
  };

  // Handle touchend - focus input if it was a tap (not a scroll)
  private touchEndHandler = (e: TouchEvent) => {
    // Check if we're ending a long press selection or a cursor-drag BEFORE
    // processing the event, so we can focus the input synchronously with the user
    // gesture. A cursor-drag (magnifier) ends in neither a tap nor a long-press,
    // but the keyboard must stay up just the same.
    const wasLongPress = isInLongPressMode(this.session);
    const wasCursorDrag = this.session.touch?.isCursorDrag === true;

    // Process the touch event first
    this.eventsHandler(e);

    // Check if this was a tap (not a scroll/drag)
    const touchDuration = Date.now() - this.touchStartTime;
    const wasTap =
      !this.touchHasMoved && touchDuration < this.TAP_TIME_THRESHOLD;

    // Don't focus input if a context menu just opened (it would close the menu)
    const hasContextMenu = this.session.hostMenuCapturing;

    // Focus input if ending a long press, a cursor-drag, or on tap (but not when
    // a context menu is open or in readonly mode)
    if (
      this.hiddenInput &&
      isTouchDevice() &&
      (wasLongPress || wasTap || wasCursorDrag) &&
      !hasContextMenu &&
      !this._state.ui.isReadonlyBase
    ) {
      // The gesture is fully handled here (caret placed by the touch pipeline,
      // focus granted below), so suppress the browser's compatibility mouse
      // events (mousedown/mouseup/click). They are hit-tested at the finger's
      // screen coordinates AFTER this handler runs — and focusing the editor can
      // move the layout under that point (a bottom sheet auto-raising for the
      // keyboard, the keyboard itself resizing the viewport). The synthesized
      // mousedown then lands on whatever slid under the finger, its default
      // action moves focus to <body>, and the canvas `click` fallback that would
      // re-focus never fires because the click no longer targets the canvas —
      // the first tap appears to do nothing. Nothing on the touch path needs
      // those events: `canvasClickHandler` only duplicates the `focus()` below.
      if (e.cancelable) e.preventDefault();
      this.focus();
    }
  };

  // Handle touchmove - track movement to distinguish taps from scrolls
  private touchMoveHandler = (e: TouchEvent) => {
    // Track if touch has moved significantly
    if (e.touches.length > 0) {
      const deltaY = Math.abs(e.touches[0].clientY - this.touchStartY);
      if (deltaY > this.TAP_THRESHOLD) {
        this.touchHasMoved = true;
      }
    }

    // Process the touch event normally (for scrolling)
    this.eventsHandler(e);

    // A long-press drag-select keeps the finger on the canvas, so Android's
    // native long-press blurs the hidden input and the keyboard slides away
    // mid-drag. Re-grab focus on each move (a touchmove is a strong enough
    // gesture context to keep the keyboard up) so it stays put.
    this.reassertTouchSelectionFocus();
  };

  // ── Input-surface mirror + clipboard helpers ───────────────────────────────

  // Write `text` into the contenteditable surface and, when it's the focused
  // element, set the DOM selection: spanning the whole text (so a screen reader
  // announces it and the browser has real content to copy) or collapsed after
  // it (the sentinel caret). Wrapped in `isMirrorUpdating` so the resulting DOM
  // events are ignored by our own handlers.
  private setMirror = (text: string, selectText: boolean) => {
    if (!this.hiddenInput) return;
    this.isMirrorUpdating = true;
    try {
      if (this.hiddenInput.textContent !== text) {
        this.hiddenInput.textContent = text;
      }
      const node = this.hiddenInput.firstChild;
      if (node && document.activeElement === this.hiddenInput) {
        const sel = window.getSelection();
        if (sel) {
          const range = document.createRange();
          if (selectText) {
            range.setStart(node, 0);
            range.setEnd(node, text.length);
          } else {
            range.setStart(node, text.length);
            range.collapse(true);
          }
          sel.removeAllRanges();
          sel.addRange(range);
        }
      }
    } catch {
      // Defensive: a stray DOM state shouldn't break input handling.
    } finally {
      this.isMirrorUpdating = false;
    }
  };

  // Restore the bare-sentinel state with the caret AFTER it (keeps Android
  // emitting deleteContentBackward). Used when there is no live word to mirror
  // (empty caret position, composition end, cut, focus seed).
  private resetSentinel = () => {
    this.setMirror(this.SENTINEL, false);
    this.lastSurfaceValue = this.SENTINEL;
  };

  // ── Faithful input surface (per-block, browser-authoritative) ───────────────
  // The faithful strategy makes the contenteditable a real field that holds the
  // focused block's FULL visible text as a single text node, with the real DOM
  // caret. The browser edits it natively and the engine reconciles a whole-block
  // diff to CRDT ops. Because the field is real, the OS keyboard owns
  // autocapitalization (incl. on new lines), autocorrect, and predictions with no
  // sentinel/word puppeteering. See `docs/input-surface-rebuild.md`.

  // Whether a block uses the faithful representation. Only when the faithful
  // strategy is active and the block is prose with NO verbatim source: a
  // preformatted block (code/math) is source end to end, and a replacement-mark
  // run (inline math chip) embeds source in prose — both must stay on the managed
  // path so the keyboard can't autocorrect into source. Those fall back to the
  // sentinel surface even under the faithful strategy.
  private faithfulEligible = (block: Block | undefined): boolean => {
    if (this.inputStrategy !== "faithful") return false;
    if (!block || block.deleted || !isTextualBlock(block)) return false;
    if (isPreformattedType(block.type)) return false;
    const hasReplacementRun = resolveMarkRuns(block).some(
      (r) => this._state.marks.get(r.name)?.replacement,
    );
    return !hasReplacementRun;
  };

  // Write the block's full visible text as a single text node and collapse the
  // DOM caret at `caretOffset` (a visible-character index, which equals the DOM
  // offset within the one text node). Wrapped in `isMirrorUpdating` so the
  // resulting DOM events are ignored by our own handlers. An empty block leaves
  // no text node — the caret collapses into the element, which WebKit reads as a
  // fresh line/sentence (so a new line capitalizes).
  private setFaithfulMirror = (text: string, caretOffset: number) => {
    if (!this.hiddenInput) return;
    this.isMirrorUpdating = true;
    try {
      if (this.hiddenInput.textContent !== text) {
        this.hiddenInput.textContent = text;
      }
      if (document.activeElement === this.hiddenInput) {
        const sel = window.getSelection();
        if (sel) {
          const node = this.hiddenInput.firstChild;
          const range = document.createRange();
          if (node) {
            range.setStart(
              node,
              Math.max(0, Math.min(caretOffset, text.length)),
            );
          } else {
            range.setStart(this.hiddenInput, 0);
          }
          range.collapse(true);
          sel.removeAllRanges();
          sel.addRange(range);
        }
      }
    } catch {
      // Defensive: a stray DOM state shouldn't break input handling.
    } finally {
      this.isMirrorUpdating = false;
    }
  };

  // The current collapsed DOM caret offset within the surface's text node, or
  // `null` when the selection is absent, ranged, or not inside the surface.
  // Both strategies use it to decide whether the surface is truly consistent
  // (text AND caret) before skipping a rewrite — skipping preserves the
  // keyboard's in-flight prediction/autocorrect session, but skipping on text
  // alone would leave a misplaced caret (e.g. before the sentinel) uncorrected.
  private readSurfaceCaret = (): number | null => {
    if (!this.hiddenInput) return null;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    if (!range.collapsed) return null;
    const node = this.hiddenInput.firstChild;
    if (node) {
      return range.startContainer === node ? range.startOffset : null;
    }
    // Empty surface: the caret collapses into the element itself.
    return range.startContainer === this.hiddenInput ? 0 : null;
  };

  // The document offset where the mirrored region after the sentinel begins. On
  // mobile it's the start of the current sentence (so the keyboard reads real
  // left-context and capitalizes only true sentence starts); on desktop it's the
  // current word. `sentenceStartOffset` is stable while typing within a sentence,
  // so the surface the keyboard already built isn't rewritten between keystrokes
  // (which would tear down its predictive-text/autocorrect session).
  private mirrorStartOffset = (text: string, caret: number): number =>
    this.mirrorSentenceContext
      ? sentenceStartOffset(text, caret)
      : currentWordStart(text, caret);

  // Where the mirrored word may start, clamped so it never reaches into content
  // that is verbatim SOURCE rather than prose — exposing source to the OS
  // keyboard lets predictive text / autocorrect rewrite it, and a multi-character
  // swap is then applied as a raw range replace (`applySurfaceReplacement`) that
  // bypasses the source's own input pipeline. That mangles it: e.g. an inline
  // math chip's LaTeX loses braces and gains accented characters.
  //
  // Two node/mark-agnostic sources of "not prose":
  //   • A preformatted block (code, math) IS source end to end → `null`: no live
  //     word at all, just the bare sentinel. Typing still flows through the
  //     synthetic-key pipeline; only autocorrect/prediction is withheld.
  //   • A replacement-mark run (an inline math chip) embeds source inside prose.
  //     The caret strictly inside one → `null`; otherwise the word may not start
  //     before the end of the last such run at or before the caret.
  //
  // Returns the clamped start, or `null` when the surface should fall back to the
  // bare sentinel.
  private clampedMirrorStart = (
    block: Block,
    text: string,
    caret: number,
  ): number | null => {
    if (isPreformattedType(block.type)) return null;
    // Replacement-mark runs (inline math chips) are verbatim source embedded in
    // prose; the keyboard must not autocorrect them.
    const spans = resolveMarkRuns(block)
      .filter((r) => this._state.marks.get(r.name)?.replacement)
      .map((r) => ({ start: r.startIndex, end: r.endIndex }));
    const floor = clampMirrorStartToSpans(spans, caret);
    if (floor === null) return null;
    return Math.max(this.mirrorStartOffset(text, caret), floor);
  };

  // Whether the collapsed caret currently sits in verbatim SOURCE rather than
  // prose: a preformatted block (a math block or code block is source end to
  // end) or strictly inside a replacement-mark run (an inline math chip's LaTeX).
  // Node/mark-agnostic — the same preformatted/replacement signal the input
  // mirror uses to keep source away from the OS keyboard.
  private caretInVerbatimSource = (): boolean => {
    const nested = this._state.document.contentSelection;
    if (nested) {
      const block = findBlock(this._state.document.page, nested.focus.blockId);
      const document = block?.structuredContent?.[nested.focus.contentId];
      if (block && document?.authority === "block") return true;
    }

    const caret = resolvePoint(this._state, "caret");
    if (!caret) return false;
    const block = this._state.document.page.blocks[caret.blockIndex];
    if (!block || block.deleted || !isTextualBlock(block)) return false;
    const spans = resolveMarkRuns(block)
      .filter((r) => this._state.marks.get(r.name)?.replacement)
      .map((r) => ({ start: r.startIndex, end: r.endIndex }));
    return caretInProtectedSource(
      isPreformattedType(block.type),
      spans,
      caret.offset,
    );
  };

  // Native predictive text / autocorrect / autocapitalize draw their suggestions
  // from the input surface. In math (or code) source those suggestions are noise
  // — the mobile strip offers to "fix" `\frac` into an English word — so withhold
  // them while the caret is in verbatim source and restore the mount-time
  // baseline when it leaves. Only rewrites the attributes on a transition.
  private applyAutosuggestForCaret = () => {
    const el = this.hiddenInput;
    if (!el) return;
    const suppressed = this.caretInVerbatimSource();
    if (suppressed === this.autosuggestSuppressed) return;
    this.autosuggestSuppressed = suppressed;
    const on = this.nativeAutocomplete && !suppressed;
    el.setAttribute("autocapitalize", on ? "sentences" : "off");
    el.setAttribute("autocorrect", on ? "on" : "off");
    el.setAttribute("spellcheck", on ? "true" : "false");
  };

  // Cheap signature of the current selection/caret, to avoid recomputing the
  // (potentially large) selection text on every render frame.
  private selectionSignature = (s: EditorState): string => {
    const nested = s.document.contentSelection;
    if (nested) {
      const point = (value: ContentPoint): string =>
        value.kind === "text"
          ? `text:${value.blockId}:${value.contentId}:${value.nodeId}:${value.field}:${value.afterCharId ?? ""}:${value.affinity}`
          : `gap:${value.blockId}:${value.contentId}:${value.parentId}:${value.slot}:${value.afterNodeId ?? ""}:${value.affinity}`;
      return `content:${point(nested.anchor)}-${point(nested.focus)}`;
    }
    const sel = s.document.selection;
    if (sel && !sel.isCollapsed) {
      return `sel:${sel.anchor.blockIndex}:${sel.anchor.textIndex}-${sel.focus.blockIndex}:${sel.focus.textIndex}`;
    }
    const c = s.document.cursor;
    return c
      ? `caret:${c.position.blockIndex}:${c.position.textIndex}`
      : "none";
  };

  // Reconcile the input surface against the document each frame. Skipped during
  // IME composition (the browser owns the content then).
  //
  // Two modes:
  //   • Non-collapsed selection → mirror its plain text (selected), so native
  //     copy/cut and screen readers operate on real content. Recomputed only
  //     when the selection changes (the text can be large).
  //   • Caret → mirror "sentinel + the current word (mobile: sentence) up to the caret", derived
  //     from the document. When the surface ALREADY equals that, it is left untouched —
  //     rewriting an already-correct surface tears down the OS predictive-text /
  //     autocorrect session, which is exactly what used to make autocomplete
  //     dead. The surface is only rewritten when it has drifted (caret moved,
  //     autoformat rewrote the word, a remote edit landed, …).
  private syncMirrorToSelection = (forceRangedSelection = false) => {
    if (!this.hiddenInput) return;

    // Toggle native predictive text off while the caret is in verbatim source,
    // independent of which surface branch below runs.
    this.applyAutosuggestForCaret();

    const selection = this._state.document.selection;
    const contentSelection = this._state.document.contentSelection;
    const hasRangedSelection =
      (!!selection && !selection.isCollapsed) ||
      (!!contentSelection && !isContentSelectionCollapsed(contentSelection));

    // Mirroring a non-collapsed selection as a *ranged* DOM selection on the
    // hidden contenteditable is what lets the native (hardware-key) copy/cut
    // event and screen readers see real selected text. On touch devices we skip
    // it: Android's IME dismisses the soft keyboard the instant the focused
    // editable holds a ranged selection (iOS doesn't), so doing this on every
    // frame of a drag-select yanks the keyboard away mid-gesture. The selection
    // is still painted on canvas, and touch copy/cut build from editor state, so
    // the ranged surface is only needed for the native copy/cut event — that
    // path forces it on demand via `forceRangedSelection`.
    const mirrorRangedSelection =
      hasRangedSelection && (forceRangedSelection || !isTouchOnlyDevice());

    const sig = this.selectionSignature(this._state);
    const sigUnchanged = sig === this.lastSelectionSig;
    this.lastSelectionSig = sig;

    if (mirrorRangedSelection) {
      if (sigUnchanged) return;
      const text = getSelectionPlainText(this._state);
      if (text) {
        this.setMirror(text, true);
        this.lastSurfaceValue = text;
        return;
      }
      // No plain text (e.g. an image-only selection) — fall through to caret.
    } else if (hasRangedSelection) {
      // Touch device with a live selection: leave the collapsed caret surface in
      // place so the soft keyboard stays up while text is selected.
      return;
    }

    const caret = resolvePoint(this._state, "caret");
    if (!caret) {
      this.resetSentinel();
      return;
    }
    const block = this._state.document.page.blocks[caret.blockIndex];
    if (!block || block.deleted || !isTextualBlock(block)) {
      this.resetSentinel();
      return;
    }

    // Faithful strategy: mirror the block's full text with the real caret. Only
    // rewrite when the surface has actually drifted (text or caret) — rewriting an
    // already-correct field cancels the keyboard's in-flight suggestion session.
    if (this.faithfulEligible(block)) {
      const fullText = getBlockTextContent(block);
      const consistent =
        this.hiddenInput.textContent === fullText &&
        document.activeElement === this.hiddenInput &&
        this.readSurfaceCaret() === caret.offset;
      if (!consistent) {
        this.setFaithfulMirror(fullText, caret.offset);
      }
      this.lastSurfaceValue = fullText;
      return;
    }

    const text = getBlockTextContent(block);
    // Only keep a live word when the caret sits at the END of one (the normal
    // typing position). Mid-word — a non-boundary char follows the caret — falls
    // back to the bare sentinel, so the surface never has to represent a caret
    // inside its text.
    const atWordEnd =
      caret.offset >= text.length || isWordBoundaryChar(text[caret.offset]);
    if (!atWordEnd) {
      this.resetSentinel();
      return;
    }
    const mirrorStart = this.clampedMirrorStart(block, text, caret.offset);
    if (mirrorStart === null) {
      this.resetSentinel();
      return;
    }
    const target = this.SENTINEL + text.slice(mirrorStart, caret.offset);

    const current = this.hiddenInput.textContent ?? "";
    // Consistent means text AND caret: the managed surface's caret always
    // belongs at the end (a mid-word caret falls back to the bare sentinel
    // above). Matching text with a misplaced caret — e.g. parked at offset 0,
    // before the sentinel, by a browser granting focus without a selection —
    // must NOT short-circuit: typing there would leak the sentinel space into
    // the document. setMirror leaves matching text untouched, so the repair is
    // caret-only and cheap.
    const consistent =
      current === target &&
      document.activeElement === this.hiddenInput &&
      this.readSurfaceCaret() === target.length;
    if (consistent) {
      // Already consistent and the keyboard owns it — don't touch the DOM (that
      // would cancel an in-flight suggestion); just keep the classifier in sync.
      this.lastSurfaceValue = target;
      return;
    }
    this.setMirror(target, false);
    this.lastSurfaceValue = target;
  };

  // Pull html/text/image out of a ClipboardEvent synchronously (clipboardData
  // detaches after the handler returns).
  private extractPendingClipboard = (
    e: ClipboardEvent,
  ): {
    html: string;
    text: string;
    imageFile: File | null;
  } | null => {
    const clipboardData = e.clipboardData;
    if (!clipboardData) return null;
    let imageFile: File | null = null;
    for (let i = 0; i < clipboardData.items.length; i++) {
      const item = clipboardData.items[i];
      if (item.type.startsWith("image/")) {
        imageFile = item.getAsFile();
        if (imageFile) break;
      }
    }
    return {
      html: clipboardData.getData("text/html") || "",
      text:
        clipboardData.getData("text/plain") ||
        clipboardData.getData("text") ||
        "",
      imageFile,
    };
  };

  // Native copy: write the selection as text/plain + text/html synchronously.
  // Copy is allowed in readonly mode. In a native shell the WebView may ignore
  // ClipboardEvent.setData, so defer to the async host-bridge path there.
  private copyHandler = (e: ClipboardEvent) => {
    if (!this._state.view.isFocused) return;

    const payload = buildClipboardPayload(this._state);
    if (!payload || !e.clipboardData) return; // nothing selected → browser default
    e.preventDefault();
    // The clipboard write MUST stay synchronous in the ClipboardEvent.
    // text/plain is for external/plain paste targets. Rich Tasfer round-trips
    // use text/html, whose hidden marker carries the canonical markdown.
    e.clipboardData.setData("text/plain", payload.plainText);
    e.clipboardData.setData("text/html", payload.html);
    // Copy produces no state/ops — fire COPY as a plain signal so hosts can
    // observe/override it (the override doesn't replace the sync write above,
    // which must run in-event; it lets a native shell react to the copy).
    this.dispatch(COPY);
  };

  // Native cut: copy, then delete the selection through the action pipeline.
  private cutHandler = (e: ClipboardEvent) => {
    if (!this._state.view.isFocused) return;
    if (
      this._state.ui.mode === "readonly" ||
      this._state.ui.mode === "suspended"
    )
      return;
    if (this._state.ui.composition?.isComposing) return;

    const payload = buildClipboardPayload(this._state);
    if (!payload || !e.clipboardData) return;
    e.preventDefault();
    // The clipboard write MUST stay synchronous in the ClipboardEvent.
    // text/plain is for external/plain paste targets — see copyHandler.
    e.clipboardData.setData("text/plain", payload.plainText);
    e.clipboardData.setData("text/html", payload.html);
    // Route the deletion through CUT so observers/overrides see it; CUT's
    // default wraps `deleteSelectedText`, so the emitted ops match the old path.
    this.executeAction(this._state.actionBus.dispatchState(CUT, this._state));
    this.resetSentinel();
  };

  // Native paste: stash the clipboard payload and queue the event so the
  // existing handlePaste flow (incl. the image-paste callback) runs in-frame.
  private pasteHandler = (e: ClipboardEvent) => {
    if (!this._state.view.isFocused) return;
    if (
      this._state.ui.mode === "readonly" ||
      this._state.ui.mode === "suspended"
    )
      return;
    e.preventDefault();
    this.pendingClipboardData = this.extractPendingClipboard(e);
    this.eventsQueue.push(e);
    this.scheduleRender();
  };

  // Enqueue a synthetic keydown so a contenteditable InputEvent is processed by
  // the same keyboard pipeline as a hardware key — preserving block/inline
  // autoformat, the TEXT_INPUT host signal, and any plugin behavior.
  private queueSyntheticKey = (key: string) => {
    const event = new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(event, "inputSource", {
      value: this.pendingTextInputSource ?? "input-surface",
    });
    this.pendingTextInputSource = null;
    this.eventsQueue.push(event);
  };

  // Apply a word-level replacement (autocorrect swap, predictive-text
  // completion, or a multi-character word delete) as ONE document edit. The
  // surface already holds the new word; diff it against the word currently in
  // the document and replace just the changed span at absolute offsets. Pending
  // keystrokes are flushed first so those offsets address an up-to-date document.
  private applySurfaceReplacement = (newSurface: string) => {
    this.flushPendingInput();

    const caret = resolvePoint(this._state, "caret");
    if (!caret) {
      this.resetSentinel();
      return;
    }
    const block = this._state.document.page.blocks[caret.blockIndex];
    if (!block || block.deleted || !isTextualBlock(block)) {
      this.resetSentinel();
      return;
    }

    // Diff against the whole mirrored region (which on Android includes the
    // sentence context before the word), matching what the surface holds. The
    // shared context is a common prefix, so the delta still localizes to the
    // changed word; absolute offsets are taken from `mirrorStart`.
    const text = getBlockTextContent(block);
    // Clamp identically to the surface builder so the replacement can never land
    // inside verbatim source (a preformatted block, or an inline math chip's
    // LaTeX) — see `clampedMirrorStart`. When it would, there is no prose word to
    // replace; drop back to the sentinel rather than corrupt the source.
    const mirrorStart = this.clampedMirrorStart(block, text, caret.offset);
    if (mirrorStart === null) {
      this.resetSentinel();
      return;
    }
    const docRegion = text.slice(mirrorStart, caret.offset);
    // Strip the leading sentinel tolerantly: the browser may have substituted
    // the regular-space sentinel with an NBSP, which must NOT be diffed into the
    // document as a leading space (see `stripSentinel`).
    const newRegion = stripSentinel(newSurface, this.SENTINEL);

    const delta = computeSurfaceDelta(docRegion, newRegion);
    if (isEmptyDelta(delta)) {
      this.lastSurfaceValue = newSurface;
      return;
    }

    const blockId = block.id;
    const from = mirrorStart + delta.deleteStart;
    const to = mirrorStart + delta.deleteEnd;
    const caretOffset = mirrorStart + newRegion.length;

    this.change((c) => {
      c.insertText(delta.insert, {
        from: { block: blockId, offset: from },
        to: { block: blockId, offset: to },
      });
      c.select({ block: blockId, offset: caretOffset });
    });

    this.lastSurfaceValue = newSurface;
  };

  // Reconcile a faithful (whole-block) surface edit into CRDT ops. The block's
  // full text lives in the surface; diff it against the last value we observed
  // (`lastSurfaceValue`) and route the change:
  //   • Enter → the proven SPLIT_BLOCK path. WebKit already processed the break
  //     natively (faithful mode doesn't preventDefault Enter), advancing its
  //     autocapitalization state to "new line" — the fix the managed surface
  //     could not deliver. Re-rendering the mirror to the new block discards
  //     WebKit's transient break.
  //   • plain typing → the synthetic-key pipeline, so block/inline autoformat and
  //     the TEXT_INPUT host signal run exactly as for a hardware key. The OS
  //     keyboard supplies already-capitalized `data` (it reads the full block as
  //     left-context), so capitalization is entirely native.
  //   • everything else (autocorrect swap, predictive completion, suggestion-strip
  //     replacement, keyboard-injected delete) → one document edit at absolute
  //     block offsets.
  // Hardware Backspace/Delete don't reach here — they stay synthetic in the
  // keydown handler — so any delete seen here is keyboard-injected and part of a
  // replacement, handled by the diff below.
  private handleFaithfulInput = (
    inputEvent: InputEvent,
    it: string,
    block: Block,
    isEnter: boolean,
  ) => {
    if (!this.hiddenInput) return;

    if (isEnter) {
      this.queueSyntheticKey("Enter");
      this.scheduleRender();
      return;
    }

    const newText = this.hiddenInput.textContent ?? "";
    const delta = computeSurfaceDelta(this.lastSurfaceValue, newText);
    if (isEmptyDelta(delta)) {
      this.lastSurfaceValue = newText;
      return;
    }

    // Plain typing — a pure insertion of exactly the event's `data`. Route through
    // the synthetic-key pipeline so autoformat/plugins run; the surface re-syncs
    // from the model on the next render (overwriting the browser's own mutation,
    // and self-healing if autoformat rewrote the text or changed the block type).
    if (
      it === "insertText" &&
      inputEvent.data != null &&
      delta.deleteStart === delta.deleteEnd &&
      delta.insert === inputEvent.data
    ) {
      for (const char of inputEvent.data) this.queueSyntheticKey(char);
      this.scheduleRender();
      this.lastSurfaceValue = newText;
      return;
    }

    const blockId = block.id;
    this.change((c) => {
      c.insertText(delta.insert, {
        from: { block: blockId, offset: delta.deleteStart },
        to: { block: blockId, offset: delta.deleteEnd },
      });
      c.select({
        block: blockId,
        offset: delta.deleteStart + delta.insert.length,
      });
    });
    this.lastSurfaceValue = newText;
  };

  // Handle input from the contenteditable surface (mobile keyboard + desktop
  // character input flow through here as InputEvents). The surface holds
  // "sentinel + current word (mobile: sentence) up to the caret"; this classifies how it changed and routes plain
  // typing / single backspaces through the synthetic-key pipeline (unchanged
  // behavior) while applying autocorrect/predictive replacements as one edit.
  private hiddenInputHandler = (e: Event) => {
    if (!this.hiddenInput) return;
    if (this.isMirrorUpdating) return;

    // Block input in readonly or suspended mode
    if (
      this._state.ui.mode === "readonly" ||
      this._state.ui.mode === "suspended"
    ) {
      this.resetSentinel();
      return;
    }

    const inputEvent = e as InputEvent;
    const it = inputEvent.inputType;

    // Skip processing during IME composition - composition events handle it.
    if (it === "insertCompositionText") return;
    if (this._state.ui.composition?.isComposing) return;

    const isBackwardDelete =
      it === "deleteContentBackward" ||
      it === "deleteWordBackward" ||
      it === "deleteSoftLineBackward" ||
      it === "deleteHardLineBackward";
    const isForwardDelete =
      it === "deleteContentForward" || it === "deleteWordForward";
    // Contenteditable favors `insertParagraph` for Enter (vs. `insertLineBreak`
    // on <input>), so accept both.
    const isEnter = it === "insertParagraph" || it === "insertLineBreak";

    // Typing over a non-collapsed selection: the surface holds the selection
    // text, so drive the edit from the event (the document insert/delete is
    // selection-aware) and let the render loop re-establish the word surface.
    const selection = this._state.document.selection;
    const contentSelection = this._state.document.contentSelection;
    if (
      (selection && !selection.isCollapsed) ||
      (contentSelection && !isContentSelectionCollapsed(contentSelection))
    ) {
      if (
        inputEvent.data != null &&
        (it === "insertText" || it === "insertReplacementText")
      ) {
        for (const char of inputEvent.data) this.queueSyntheticKey(char);
      } else if (isBackwardDelete) {
        this.queueSyntheticKey("Backspace");
      } else if (isForwardDelete) {
        this.queueSyntheticKey("Delete");
      } else if (isEnter) {
        this.queueSyntheticKey("Enter");
      }
      this.scheduleRender();
      this.resetSentinel();
      return;
    }

    // Faithful strategy: a collapsed caret in a prose block reconciles the WHOLE
    // block (not a sentinel+word region). Verbatim-source blocks (code/math,
    // inline math chips) are not eligible and fall through to the managed path.
    const caretPoint = resolvePoint(this._state, "caret");
    const caretBlock = caretPoint
      ? this._state.document.page.blocks[caretPoint.blockIndex]
      : undefined;
    if (this.faithfulEligible(caretBlock)) {
      this.handleFaithfulInput(inputEvent, it, caretBlock as Block, isEnter);
      return;
    }

    // Enter / line break: split the block; the new line's empty word resyncs.
    if (isEnter) {
      this.queueSyntheticKey("Enter");
      this.scheduleRender();
      this.resetSentinel();
      return;
    }

    // Forward delete acts on content AFTER the caret (outside the mirrored word).
    if (isForwardDelete) {
      this.queueSyntheticKey("Delete");
      this.scheduleRender();
      this.resetSentinel();
      return;
    }

    let newSurface = this.hiddenInput.textContent ?? "";

    // A keystroke that landed BEFORE the sentinel (a stale DOM caret at offset
    // 0 — e.g. focus granted without an explicit selection) turns ` ` into
    // `C `: read verbatim, the trailing sentinel space would be diffed into
    // the document as a spurious space. Reorder the surface as if the caret had
    // been where it belongs and reconcile only the typed characters; the next
    // render-frame resync rewrites the DOM surface and re-places the caret.
    const rescued = rescueCaretBeforeSentinel(
      this.lastSurfaceValue,
      newSurface,
      this.SENTINEL,
    );
    if (rescued !== null) newSurface = rescued;

    // The surface lost its leading sentinel. A browser that substituted the
    // regular-space sentinel with an NBSP still COUNTS as carrying it
    // (`hasSentinel`), so its body is read below and the substitute never leaks
    // into the document; this fires only when the sentinel is genuinely gone.
    if (!hasSentinel(newSurface, this.SENTINEL)) {
      if (isBackwardDelete) {
        // The delete consumed the whole mirrored region (it was just the bare
        // sentinel — caret at a sentence start with no context): let the
        // document Backspace handle it (char delete, or block merge / outdent at
        // offset 0), then restore the sentinel.
        this.queueSyntheticKey("Backspace");
        this.scheduleRender();
        this.resetSentinel();
        return;
      }
      // A replacement that rewrote the whole field (some keyboards do this).
      this.applySurfaceReplacement(newSurface);
      return;
    }

    // The mirrored region: the current word, plus its sentence context on
    // Android. Any context prefix is identical between frames while typing within
    // a sentence, so an append / single backspace shows up as a one-character
    // change at the end exactly as it does when the surface holds only the word.
    const prevRegion = hasSentinel(this.lastSurfaceValue, this.SENTINEL)
      ? stripSentinel(this.lastSurfaceValue, this.SENTINEL)
      : "";
    const newRegion = stripSentinel(newSurface, this.SENTINEL);

    // No textual change (e.g. a caret-only input event).
    if (newRegion === prevRegion) {
      this.lastSurfaceValue = newSurface;
      return;
    }

    // Plain typing — characters appended at the end. Route through the
    // synthetic-key path so autoformat/plugins run as for hardware keys. The OS
    // keyboard owns capitalization: it reads the mirrored sentence context and
    // emits an already-capitalized `data` at a sentence start (see SENTINEL and
    // `mirrorSentenceContext`).
    if (
      it === "insertText" &&
      inputEvent.data != null &&
      newRegion === prevRegion + inputEvent.data
    ) {
      for (const char of inputEvent.data) this.queueSyntheticKey(char);
      this.scheduleRender();
      this.lastSurfaceValue = newSurface;
      return;
    }

    // Single-character backspace at the caret — same synthetic path. (Deletes
    // the word's last char, or a context space when the word is empty; the
    // document Backspace handles either at the real caret offset.)
    if (
      isBackwardDelete &&
      newRegion.length === prevRegion.length - 1 &&
      prevRegion.startsWith(newRegion)
    ) {
      this.queueSyntheticKey("Backspace");
      this.scheduleRender();
      this.lastSurfaceValue = newSurface;
      return;
    }

    // Everything else — an autocorrect swap, a predictive-text completion, or a
    // multi-character (word) delete — is a replacement of the current word,
    // applied as one document edit.
    this.applySurfaceReplacement(newSurface);
  };

  // Handle keydown from hidden input (for special keys)
  private hiddenInputKeyDownHandler = (e: KeyboardEvent) => {
    if (!this.hiddenInput) return;

    // Check if this is a keyboard shortcut (Ctrl/Cmd + key)
    const isShortcut = e.ctrlKey || e.metaKey;

    // In readonly mode, only allow navigation and copy
    if (this._state.ui.mode === "readonly") {
      const isNavigationKey = [
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
        "PageUp",
        "PageDown",
        "Home",
        "End",
      ].includes(e.key);
      const isCopy = isShortcut && e.code === "KeyC";
      const isSelectAll = isShortcut && e.code === "KeyA";
      const isEscape = e.key === "Escape";

      if (!isNavigationKey && !isCopy && !isSelectAll && !isEscape) {
        e.preventDefault();
        return;
      }
    }

    // In suspended mode, block everything
    if (this._state.ui.mode === "suspended") {
      e.preventDefault();
      return;
    }

    // Self-heal a stranded composition flag. If we still think we're composing
    // but the browser reports this keydown is NOT part of a composition, a prior
    // `compositionend` was dropped or reordered — common on Android soft
    // keyboards after accepting an autocomplete inside a code/math block, which
    // always use the managed surface. Trust the event: clear the stale flag and
    // fall through to normal handling so Enter (and every other key) is honored
    // instead of being swallowed by the composition branch below.
    if (this._state.ui.composition?.isComposing && !e.isComposing) {
      this._state = {
        ...this._state,
        ui: { ...this._state.ui, composition: null },
      };
      this.resetSentinel();
    }

    // During composition (IME input), let the IME handle keys natively
    if (this._state.ui.composition?.isComposing) {
      // Escape cancels composition without inserting text
      if (e.key === "Escape") {
        this._state = {
          ...this._state,
          ui: {
            ...this._state.ui,
            composition: null,
          },
        };
        this.resetSentinel();
        this.scheduleRender();
        e.preventDefault();
        return;
      }
      // Enter commits composition text
      if (e.key === "Enter") {
        return;
      }
      // Backspace deletes character before cursor within composition
      if (e.key === "Backspace") {
        const comp = this._state.ui.composition;
        if (comp.cursorOffset > 0) {
          const newText =
            comp.text.slice(0, comp.cursorOffset - 1) +
            comp.text.slice(comp.cursorOffset);
          this._state = {
            ...this._state,
            document: {
              ...this._state.document,
              cursor: this._state.document.cursor
                ? {
                    ...this._state.document.cursor,
                    lastUpdate: Date.now(),
                  }
                : null,
            },
            ui: {
              ...this._state.ui,
              composition: {
                ...comp,
                text: newText,
                cursorOffset: comp.cursorOffset - 1,
              },
            },
          };
          // If all text deleted, cancel composition
          if (newText.length === 0) {
            this._state = {
              ...this._state,
              ui: { ...this._state.ui, composition: null },
            };
            this.resetSentinel();
          }
          this.scheduleRender();
        }
        e.preventDefault();
        return;
      }
      // Delete removes character after cursor within composition
      if (e.key === "Delete") {
        const comp = this._state.ui.composition;
        if (comp.cursorOffset < comp.text.length) {
          const newText =
            comp.text.slice(0, comp.cursorOffset) +
            comp.text.slice(comp.cursorOffset + 1);
          this._state = {
            ...this._state,
            document: {
              ...this._state.document,
              cursor: this._state.document.cursor
                ? {
                    ...this._state.document.cursor,
                    lastUpdate: Date.now(),
                  }
                : null,
            },
            ui: {
              ...this._state.ui,
              composition: {
                ...comp,
                text: newText,
              },
            },
          };
          // If all text deleted, cancel composition
          if (newText.length === 0) {
            this._state = {
              ...this._state,
              ui: { ...this._state.ui, composition: null },
            };
            this.resetSentinel();
          }
          this.scheduleRender();
        }
        e.preventDefault();
        return;
      }
      // Block shortcuts like Ctrl+Z (undo), Ctrl+X (cut), etc.
      if (isShortcut) {
        return;
      }
      // Handle arrow/navigation keys within composition text
      // Don't preventDefault - let the IME also handle it for candidate navigation
      // But manually track cursorOffset for visual cursor rendering on canvas
      if (
        [
          "ArrowLeft",
          "ArrowRight",
          "ArrowUp",
          "ArrowDown",
          "PageUp",
          "PageDown",
          "Home",
          "End",
        ].includes(e.key)
      ) {
        const comp = this._state.ui.composition;
        const textLen = comp.text.length;
        let newOffset = comp.cursorOffset;

        switch (e.key) {
          case "ArrowLeft":
            newOffset = Math.max(0, newOffset - 1);
            break;
          case "ArrowRight":
            newOffset = Math.min(textLen, newOffset + 1);
            break;
          case "Home":
          case "ArrowUp":
          case "PageUp":
            newOffset = 0;
            break;
          case "End":
          case "ArrowDown":
          case "PageDown":
            newOffset = textLen;
            break;
        }

        if (newOffset !== comp.cursorOffset) {
          this._state = {
            ...this._state,
            document: {
              ...this._state.document,
              cursor: this._state.document.cursor
                ? {
                    ...this._state.document.cursor,
                    lastUpdate: Date.now(),
                  }
                : null,
            },
            ui: {
              ...this._state.ui,
              composition: {
                ...comp,
                cursorOffset: newOffset,
              },
            },
          };
          this.scheduleRender();
        }
        return;
      }
    }

    // Host schema shortcuts take precedence over the built-in keymap. A matched
    // combo runs its action (a MutationAction goes through dispatch so its
    // observers fire) and consumes the key, so the built-in path below — and the
    // window listener — don't also act on it.
    if (this.handleSchemaShortcut(e)) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    // Faithful strategy: let WebKit process Enter NATIVELY so its
    // autocapitalization state advances to a new line (the next letter then
    // capitalizes — the bug the managed surface couldn't fix). We don't
    // preventDefault; the resulting `insertParagraph` input event applies the
    // SPLIT_BLOCK (see handleFaithfulInput). Only for a collapsed caret in an
    // eligible block and a plain Enter — Enter over a selection, or with a
    // modifier, falls through to the synthetic path below. `stopPropagation`
    // keeps the window listener from also acting on it.
    if (e.key === "Enter" && !isShortcut && !e.altKey) {
      const sel = this._state.document.selection;
      const caretPoint = resolvePoint(this._state, "caret");
      const caretBlock = caretPoint
        ? this._state.document.page.blocks[caretPoint.blockIndex]
        : undefined;
      if ((!sel || sel.isCollapsed) && this.faithfulEligible(caretBlock)) {
        e.stopPropagation();
        return;
      }
    }

    // Only forward special keys to avoid duplication with input event
    // Regular text input is handled by hiddenInputHandler
    if (
      [
        "Enter",
        "Tab",
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
        "Backspace",
        "Delete",
        "PageUp",
        "PageDown",
        "Home",
        "End",
        "Escape",
      ].includes(e.key)
    ) {
      e.preventDefault();
      e.stopPropagation();
      this.eventsQueue.push(e);
      this.scheduleRender();
      this.resetSentinel();
    } else if (isShortcut) {
      // Copy/cut rely on the browser firing the native `copy`/`cut` event from
      // the hidden contenteditable, which it only does when that element has a
      // live, non-collapsed DOM selection. The render-loop mirror
      // (`syncMirrorToSelection`) can drift out of sync with the model
      // selection — its `lastSelectionSig` short-circuit skips a resync when the
      // model selection is unchanged, so after focus moves to a popover/toolbar
      // and back the DOM selection is left collapsed. Cmd+C then copies nothing
      // while the OS Edit-menu Copy (which fires `copy` unconditionally) still
      // works. Force a fresh sync here, before the browser decides whether to
      // fire the event, then fall through (no preventDefault) so the native
      // copy/cut path runs as designed.
      if (e.code === "KeyC" || e.code === "KeyX") {
        this.lastSelectionSig = null;
        // Force the ranged DOM selection even on touch devices (where the
        // render-loop mirror keeps it collapsed to preserve the soft keyboard):
        // the native copy/cut event only fires when the surface holds one.
        this.syncMirrorToSelection(true);
        return;
      }

      // Save as Markdown - handle here (not in events queue) to preserve user gesture for download
      if (e.code === "KeyS") {
        e.preventDefault();
        e.stopPropagation();
        if (e.repeat) return;
        const markdown = serializeToMarkdown(
          this._state.document.page.blocks,
          undefined,
          { schema: this._state.schema },
        );
        const blob = new Blob([markdown], { type: "text/markdown" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        const firstBlock = this._state.document.page.blocks.find(
          (b) => !b.deleted && isTextualBlock(b),
        );
        const firstBlockText =
          firstBlock && "charRuns" in firstBlock
            ? firstBlock.charRuns
                .map((r) => r.text)
                .join("")
                .trim()
            : "";
        a.download = `${firstBlockText || "untitled"}.md`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        return;
      }

      // Copy/cut (KeyC/KeyX) are intentionally excluded: they must fall through
      // so the browser fires native `copy`/`cut` events (handled by
      // copyHandler/cutHandler), which write the clipboard synchronously.
      const handledShortcuts = ["KeyZ", "KeyY", "KeyA", "KeyB"];
      if (handledShortcuts.includes(e.code)) {
        // For editor shortcuts, forward to the events queue.
        e.preventDefault();
        e.stopPropagation();
        this.eventsQueue.push(e);
        this.scheduleRender();
      }
    } else {
      // For regular character keys, prevent default to stop them from being processed by window listener
      // But allow the input event to fire
      // A printable physical key is committed by that following input event,
      // not this keydown. Preserve its source for queueSyntheticKey; virtual
      // keyboards that only mutate the surface never arm this latch.
      this.pendingTextInputSource =
        e.key.length === 1 && !e.altKey && e.isTrusted
          ? "hardware-keyboard"
          : null;
      e.stopPropagation();
    }
  };

  // Handle composition events (IME input)
  private compositionStartHandler = (e: CompositionEvent) => {
    // Mark composition as starting - this will be handled in events.ts
    this.eventsQueue.push(e);
    this.scheduleRender();
  };

  private compositionUpdateHandler = (e: CompositionEvent) => {
    // Update composition text - this will be handled in events.ts
    this.eventsQueue.push(e);
    this.scheduleRender();
  };

  private compositionEndHandler = (e: CompositionEvent) => {
    if (!this.hiddenInput) return;

    // Finalize composition - this will be handled in events.ts
    this.eventsQueue.push(e);
    this.scheduleRender();

    // Restore the sentinel after composition ends.
    this.resetSentinel();
  };

  // Handler to invalidate cached rect when canvas position might change
  private invalidateRectCache = () => {
    this.rectNeedsUpdate = true;
  };

  destroy = (): void => {
    this.destroyed = true;

    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
    }

    this.cancelPendingSelectionClear();

    if (this.canvasClickHandler) {
      this.contentCanvas.removeEventListener("click", this.canvasClickHandler);
    }

    if (this.desktopPointerListenersAttached) {
      if (this.canvasClickHandler) {
        this.contentCanvas.removeEventListener(
          "mousedown",
          this.canvasClickHandler,
        );
        this.canvasClickHandler = null;
      }

      this.contentCanvas.removeEventListener("contextmenu", this.eventsHandler);
      this.contentCanvas.removeEventListener("mousedown", this.eventsHandler);
      this.contentCanvas.removeEventListener("mousemove", this.eventsHandler);
      this.contentCanvas.removeEventListener("mouseup", this.eventsHandler);
      this.contentCanvas.removeEventListener("mouseleave", this.eventsHandler);
      this.contentCanvas.removeEventListener("pointerdown", this.eventsHandler);
      this.contentCanvas.removeEventListener("pointermove", this.eventsHandler);
      this.contentCanvas.removeEventListener("pointerup", this.eventsHandler);
      this.contentCanvas.removeEventListener(
        "pointercancel",
        this.eventsHandler,
      );
      this.contentCanvas.removeEventListener("wheel", this.eventsHandler);

      window.removeEventListener("mouseup", this.windowMouseUpHandler);
      window.removeEventListener("mousemove", this.windowMouseMoveHandler);
      this.desktopPointerListenersAttached = false;
    }

    this.contentCanvas.removeEventListener(
      "touchstart",
      this.touchStartHandler,
    );
    this.contentCanvas.removeEventListener("touchmove", this.touchMoveHandler);
    this.contentCanvas.removeEventListener("touchend", this.touchEndHandler);
    this.contentCanvas.removeEventListener("touchcancel", this.eventsHandler);
    window.removeEventListener("resize", this.invalidateRectCache);
    window.removeEventListener("scroll", this.invalidateRectCache, true);
    window.removeEventListener("focus", this.browserFocusHandler);
    window.removeEventListener("blur", this.browserBlurHandler);

    // Clean up input-surface handlers
    if (this.hiddenInput) {
      this.hiddenInput.removeEventListener("focus", this.browserFocusHandler);
      this.hiddenInput.removeEventListener("blur", this.browserBlurHandler);
      this.hiddenInput.removeEventListener("input", this.hiddenInputHandler);
      this.hiddenInput.removeEventListener(
        "keydown",
        this.hiddenInputKeyDownHandler,
      );
      this.hiddenInput.removeEventListener(
        "compositionstart",
        this.compositionStartHandler,
      );
      this.hiddenInput.removeEventListener(
        "compositionupdate",
        this.compositionUpdateHandler,
      );
      this.hiddenInput.removeEventListener(
        "compositionend",
        this.compositionEndHandler,
      );
      this.hiddenInput.removeEventListener("copy", this.copyHandler);
      this.hiddenInput.removeEventListener("cut", this.cutHandler);
      this.hiddenInput.removeEventListener("paste", this.pasteHandler);
    }

    this.a11yMirror?.destroy();
  };

  updateViewport = (newViewport: Partial<ViewportState>): void => {
    const oldWidth = this.viewport.width;

    // A user-input scroll funnels through here (wheel/touch/momentum all commit
    // their offset via this callback). Dispatch SCROLL *before* applying it so a
    // node the pointer is over (e.g. a drawing board) can return true to claim
    // the scroll and keep the page from moving; if claimed, drop the offset
    // change but keep any other batched viewport fields (e.g. a resize). Hosts
    // tracking the offset observe at priority 0. Programmatic scrolls assign
    // this.viewport directly and bypass this funnel, so they aren't claimable.
    let patch = newViewport;
    if (
      patch.scrollY !== undefined &&
      patch.scrollY !== this.viewport.scrollY &&
      this.dispatch(SCROLL, {
        scrollY: patch.scrollY,
        deltaY: patch.scrollY - this.viewport.scrollY,
        source: "user",
      })
    ) {
      patch = { ...patch, scrollY: this.viewport.scrollY };
    }

    this.viewport = { ...this.viewport, ...patch };
    if (patch.scrollY !== undefined) this.pendingViewportAnchor = null;

    // Invalidate cached bounding rect since viewport dimensions changed
    this.invalidateRectCache();

    // Clear block height cache if width changed (affects text wrapping)
    if (this.viewport.width !== oldWidth) {
      clearAllBlockCaches(this._state.document.page.blocks);
      this.documentHeightDirty = true; // Width change affects text wrapping and height
      this.rebuildBlockHeightIndex();
    }

    // Schedule render for viewport changes
    this.scheduleRender();
    this.renderFrame();
  };

  private calculateDocumentHeight = (): number => {
    const styles = getEditorStyles(this._state);
    const documentHeight =
      styles.canvas.paddingTop +
      this.blockHeights.totalHeight() +
      styles.canvas.paddingBottom;
    this.viewport = { ...this.viewport, documentHeight };
    return documentHeight;
  };

  /**
   * Apply an engine-driven viewport change and notify observers after it has
   * taken effect. Unlike the user-input scroll funnel, programmatic scrolling
   * cannot be claimed by an action handler.
   */
  private applyProgrammaticScroll = (scrollY: number): void => {
    const previousScrollY = this.viewport.scrollY;
    if (scrollY === previousScrollY) return;
    this.viewport = { ...this.viewport, scrollY };
    const event = {
      scrollY,
      deltaY: scrollY - previousScrollY,
      source: "programmatic",
    } as const;
    this._state.actionBus.notify(SCROLL, event);
  };

  private rebuildBlockHeightIndex = (): void => {
    this.updateBlockHeightIndex("rebuild");
  };

  private reconcileBlockHeightIndex = (): void => {
    this.updateBlockHeightIndex("reconcile");
  };

  private updateBlockHeightIndex = (mode: "rebuild" | "reconcile"): void => {
    const styles = getEditorStyles(this._state);
    const maxWidth =
      this.viewport.width -
      (styles.canvas.paddingLeft + styles.canvas.paddingRight);
    const estimate = (
      block: Block & { originalIndex: number },
      index: number,
    ) =>
      getEstimatedBlockHeight(
        this._state.nodes,
        this._state.marks,
        block,
        block.originalIndex,
        maxWidth,
        styles,
        index === 0,
      );
    this.blockHeights[mode](this._state.view.visibleBlocks, estimate);
  };
  blur = () => {
    try {
      this.hiddenInput?.blur();
    } catch {
      // Ignore — blur can throw if the element is detached mid-teardown.
    }
    this.syncBrowserFocus();
  };
  focus = () => {
    if (this.hiddenInput) {
      const prevPointerEvents = this.hiddenInput.style.pointerEvents;
      try {
        this.hiddenInput.focus({ preventScroll: true });
        if (
          document.hasFocus() &&
          document.activeElement === this.hiddenInput
        ) {
          // Some browsers need click as well
          this.hiddenInput.style.pointerEvents = "auto";
          this.hiddenInput.focus({ preventScroll: true });
          this.hiddenInput.click();
        }
      } catch {
        // Ignore — focus can throw if the element is detached mid-teardown.
      } finally {
        this.hiddenInput.style.pointerEvents = prevPointerEvents;
      }
    }
    this.syncBrowserFocus();
  };

  // Place a collapsed caret at a DocPoint (default the document start), clearing
  // any selection. Pass `onlyIfUnset` to make it a no-op when a cursor already
  // exists (the "seed an initial caret" case, e.g. on first focus); omit it to
  // force the move.
  setCaret = (
    point: Exclude<DocPoint, "caret"> = "start",
    opts?: { onlyIfUnset?: boolean },
  ): void => {
    if (opts?.onlyIfUnset && this._state.document.cursor) return;
    const resolved = resolvePoint(this._state, point);
    if (!resolved) return;
    this._state = updateMode(
      updateSelection(
        updateCursor(this._state, {
          blockIndex: resolved.blockIndex,
          textIndex: resolved.offset,
        }),
        null,
      ),
      "edit",
    );
    const currentState = this._state;
    this.scheduleRender();
    this.listeners.forEach((listener) => listener(currentState));
  };

  // Place a selection spanning a DocRange (a bare point drops a caret). Shares
  // the `selectTarget` resolver with `ChangeApi.select`, but stands alone — no
  // ops, no undo entry — for host-driven cursor/selection placement.
  setSelection = (range: DocRange | null): void => {
    if (range === null) {
      // Clear both the selection and the caret — removing all visual
      // indicators — then notify subscribers.
      this._state = updateCursor(clearSelection(this._state), null);
    } else {
      this._state = updateMode(selectTarget(this._state, range), "edit");
    }
    const currentState = this._state;
    this.scheduleRender();
    this.listeners.forEach((listener) => listener(currentState));
  };

  // Internal: viewport coords for an index-space {@link Position} (the
  // renderer's currency). The public `coordsAtPos` resolves a DocPoint down to
  // this; `getCursorScreenPosition` feeds the live caret position directly.
  private coordsAtIndexPosition = (
    position: Position,
  ): { x: number; y: number; height: number } | null => {
    return getIndexedCursorViewportCoords(
      position,
      this._state,
      this.viewport,
      getEditorStyles(this._state),
      this.blockHeights,
    );
  };

  private coordsAtContentPoint = (
    point: ContentPoint,
  ): { x: number; y: number; height: number } | null => {
    const normalized = normalizeContentPoint(this._state.document.page, point);
    if (!normalized) return null;
    const blockIndex = findBlockIndex(
      this._state.document.page,
      normalized.blockId,
    );
    if (blockIndex < 0) return null;
    const working = updateContentSelection(this._state, {
      anchor: normalized,
      focus: normalized,
      lastUpdate: this._state.document.contentSelection?.lastUpdate,
    });
    return getIndexedCursorViewportCoords(
      { blockIndex, textIndex: 0 },
      working,
      this.viewport,
      getEditorStyles(working),
      this.blockHeights,
    );
  };

  /**
   * Scroll a (possibly off-screen) index position the minimum amount needed to
   * bring it into view, then keep correcting over the next few frames until it
   * lands exactly. The one-shot jump is computed from estimated prefix block
   * heights, so for a far-off target it lands approximately; the
   * `pendingViewportAnchor` re-measures after each paint and converges on the
   * true spot — the same mechanism {@link scrollToPosition} uses for its
   * offset target. Threaded into the event layer as `RegionCtx.
   * scrollPositionIntoView` so the out-of-view peer indicator lands a click on
   * the peer's actual caret rather than an estimate.
   */
  private scrollPositionIntoView = (position: Position): void => {
    const block = this._state.document.page.blocks[position.blockIndex];
    if (!block || block.deleted) return;
    const coords = this.coordsAtIndexPosition(position);
    if (!coords) return;

    // Match scrollToMakeCursorVisible: keep the target this far from the edge.
    const margin = 40;
    const top = margin;
    const bottom = this.viewport.height - margin;
    let viewportOffsetY: number;
    if (coords.y < top) {
      viewportOffsetY = top;
    } else if (coords.y + coords.height > bottom) {
      viewportOffsetY = bottom - coords.height;
    } else {
      return; // already comfortably in view
    }

    const maxScroll = Math.max(
      0,
      this.calculateDocumentHeight() - this.viewport.height,
    );
    const scrollY = Math.max(
      0,
      Math.min(maxScroll, this.viewport.scrollY + coords.y - viewportOffsetY),
    );
    this.applyProgrammaticScroll(scrollY);
    this.pendingViewportAnchor = {
      position,
      viewportOffsetY,
      remainingCorrections: 3,
    };
    this.scheduleRender();
  };

  coordsAtPos = (
    point: DocPoint,
  ): { x: number; y: number; height: number } | null => {
    const resolved = resolvePoint(this._state, point);
    if (!resolved) return null;
    return this.coordsAtIndexPosition({
      blockIndex: resolved.blockIndex,
      textIndex: resolved.offset,
    });
  };

  showDropIndicator = (
    client: { x: number; y: number } | null,
  ): DocPoint | null => {
    const setIndex = (index: number | null) => {
      if (this._state.ui.externalDropIndex === index) return;
      this._state = {
        ...this._state,
        ui: { ...this._state.ui, externalDropIndex: index },
      };
      const currentState = this._state;
      this.scheduleRender();
      this.listeners.forEach((listener) => listener(currentState));
    };

    if (client === null) {
      setIndex(null);
      return null;
    }

    if (this.rectNeedsUpdate) this.updateCachedRect();
    const { left, top } = this.cachedRect;
    const canvasX = client.x - left;
    const canvasY = client.y - top;
    // Outside the canvas (e.g. over the sidebar) — there is no valid gap.
    if (
      canvasX < 0 ||
      canvasX > this.viewport.width ||
      canvasY < 0 ||
      canvasY > this.viewport.height
    ) {
      setIndex(null);
      return null;
    }

    const index = dropIndexAtPoint(canvasY, this._state, this.viewport);
    setIndex(index);

    // Resolve the gap to a block-edge DocPoint: gap 0 is the document start;
    // gap i is after the (i-1)th visible block. visibleBlocks are in visual order.
    const blocks = this._state.view.visibleBlocks;
    if (index <= 0 || blocks.length === 0) return "start";
    const before = blocks[Math.min(index, blocks.length) - 1];
    return { block: before.id, side: "after" };
  };

  edgeScrollForDrag = (
    client: { x: number; y: number } | null,
  ): DocPoint | null => {
    if (client === null) return null;

    if (this.rectNeedsUpdate) this.updateCachedRect();
    const canvasX = client.x - this.cachedRect.left;
    const canvasY = client.y - this.cachedRect.top;
    // Outside the canvas (e.g. over the sidebar) — nothing to scroll or mark.
    if (
      canvasX < 0 ||
      canvasX > this.viewport.width ||
      canvasY < 0 ||
      canvasY > this.viewport.height
    ) {
      return null;
    }

    // Constant edge speed, proximity-scaled — matching the pointer-driven block
    // reorder and image-resize drags (no time-based acceleration). Clamp the new
    // offset to the document bounds before committing it as a programmatic scroll
    // (the native-drag path is host-driven, so it bypasses the SCROLL funnel).
    const delta = edgeScrollDelta(canvasY, this.viewport.height, {
      accelerate: false,
      elapsedMs: 0,
    });
    if (delta !== 0) {
      const maxScroll = Math.max(
        0,
        this.calculateDocumentHeight() - this.viewport.height,
      );
      const newScrollY = Math.max(
        0,
        Math.min(maxScroll, this.viewport.scrollY + delta),
      );
      if (newScrollY !== this.viewport.scrollY) {
        this.applyProgrammaticScroll(newScrollY);
      }
    }

    // Re-resolve the insertion line against the (possibly) scrolled viewport so
    // it tracks the content moving under a stationary pointer.
    return this.showDropIndicator(client);
  };

  // Raw state firehose (EditorWiring) — the internal primitive every public
  // subscription wraps. Engine code (`on`) and a first-party host reaching in via
  // `EditorClass` diff the full EditorState here; the public `subscribe`/`on`
  // never expose it.
  subscribeRaw = (listener: (state: EditorState) => void): (() => void) => {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index > -1) {
        this.listeners.splice(index, 1);
      }
    };
  };

  // Public subscription: deliver the EditorStateSnapshot, never raw state. The
  // raw arg is ignored — at notify time `this._state` is the just-applied state,
  // so the `state` getter builds the snapshot for it.
  subscribe = (
    listener: (snapshot: EditorStateSnapshot) => void,
  ): (() => void) => this.subscribeRaw(() => listener(this.state));

  on: EditorApi["on"] = (
    event: EditorEvent,
    callback:
      | ((tx: ChangeTransaction) => void)
      | ((snapshot: EditorStateSnapshot) => void),
  ): (() => void) => {
    // "change" rides the dedicated op channel (emitChange) so it can carry the
    // ChangeTransaction { isRemote, ops }, rather than the state-diff path.
    if (event === "change") {
      const cb = callback as (tx: ChangeTransaction) => void;
      this.changeListeners.push(cb);
      return () => {
        const i = this.changeListeners.indexOf(cb);
        if (i > -1) this.changeListeners.splice(i, 1);
      };
    }

    // selectionchange / focus / blur are pure state transitions — classify them
    // by diffing raw state (the internal firehose) against the value captured at
    // subscription time, then hand the listener the public snapshot.
    const cb = callback as (snapshot: EditorStateSnapshot) => void;
    let prev = this._state;
    return this.subscribeRaw((next) => {
      const pageChanged = prev.document.page !== next.document.page;
      const selectionChanged =
        prev.document.cursor?.position !== next.document.cursor?.position ||
        prev.document.selection !== next.document.selection ||
        prev.document.contentSelection !== next.document.contentSelection;
      const focusGained = !prev.view.isFocused && next.view.isFocused;
      const focusLost = prev.view.isFocused && !next.view.isFocused;
      prev = next;

      switch (event) {
        case "selectionchange":
          if (selectionChanged && !pageChanged) cb(this.state);
          break;
        case "focus":
          if (focusGained) cb(this.state);
          break;
        case "blur":
          if (focusLost) cb(this.state);
          break;
      }
    });
  };

  // The bus methods are stable closures across state updates (the bus reference
  // never changes), so these simply delegate to the current binding.
  // One implementation behind the two public overloads (plain ActionHandler vs.
  // a mutation action's ChangeApi-threading MutationHandler). The bus stores
  // both shapes in the same slot; `dispatch`/`dispatchMutation` invoke each with
  // the right arguments, so the registry stays handler-shape-agnostic here.
  registerAction = <P>(
    action: Action<P>,
    handler: ActionHandler<P> | MutationHandler<P>,
    priority?: number,
  ): (() => void) => {
    return this._state.actionBus.register(
      action,
      handler as ActionHandler<P>,
      priority,
    );
  };

  dispatch = <P>(action: Action<P>, ...args: DispatchArgs<P>): boolean => {
    // State action: thread the working state through its observers plus (unless
    // one claims it) its pure default transform, then commit the result — undo +
    // broadcast if it emitted ops, render + notify either way. This is the live-
    // editor entry point for the bus's lower-level kind (a cursor/selection move
    // that emits no ops, like a math chip's caret exit). Returns whether the
    // state actually changed.
    if (isStateAction(action)) {
      const prev = this._state;
      const result = this._state.actionBus.dispatchState(
        action,
        this._state,
        ...args,
      );
      this.executeAction(result);
      return result.state !== prev;
    }
    // Plain action: route straight through the bus (handler walk, override on
    // first `true`). Returns whether a handler claimed it.
    if (!isMutationAction(action)) {
      return this._state.actionBus.dispatch(action, ...args);
    }
    // Mutation action: run its observers (high→low) plus its default inside ONE
    // change() — an observer can override (return true → skip the default) or
    // contribute edits to the same transaction. Returns whether the doc changed.
    const payload = (args as unknown[])[0] as P;
    return this.change((c) => {
      let claimed = false;
      for (const handler of this._state.actionBus.handlersFor(action)) {
        if ((handler as unknown as MutationHandler<P>)(c, payload) === true) {
          claimed = true;
          break;
        }
      }
      if (!claimed) action.mutate(c, payload);
    });
  };

  getMarkdown = (): string => {
    return serializeToMarkdown(this._state.document.page.blocks, undefined, {
      schema: this._state.schema,
    });
  };

  setMarkdown = (markdown: string): void => {
    // Replace the document by diffing current → parsed blocks and emitting CRDT
    // operations (delete the current blocks, insert the new ones). Reuses the
    // snapshot-restore path, so the replace is a single undoable step and is
    // broadcast to peers — not a silent state swap. loadPage always yields a
    // fresh Page (≥1 block), so empty input is handled safely; an identical
    // result produces no ops and is a no-op. Pass the instance schema so the
    // parsed blocks are coerced to its authoring allow-list (no-op when
    // unrestricted), matching the paste path.
    this.restoreFromSnapshot(loadPage(markdown, this._state.schema).blocks);
  };

  // ── Actions & chaining (Tier B) ────────────────────────────────────────
  // Every action is a pure (state) => ActionResult transform built on the
  // same action functions the keyboard/menu paths use. `actions.X` runs one
  // immediately (its own undo step, broadcast, notify, via executeAction);
  // `chain()` threads state through several and commits them as ONE undo step.

  // toggleMark dispatch is registry-driven: any togglable mark on the schema
  // can be toggled by name (built-ins + custom). Marks that need extra input
  // (link → url, math → LaTeX) are `togglable: false` and ignored here.
  private toggleMarkAction =
    (name: MarkName): StateAction =>
    (s) =>
      toggleFormat(s, name);

  private canToggleMark = (name: MarkName): boolean =>
    this._state.marks.get(name)?.togglable === true;

  // setBlock accepts the concrete block types plus the convenience "heading",
  // mapped to heading1/2/3 by `opts.level` (clamped 1–3, the levels that render).
  private resolveBlockType = (
    type: Block["type"] | "heading",
    opts?: { level?: number },
  ): Block["type"] => {
    if (type === "heading") {
      const level = Math.min(3, Math.max(1, Math.round(opts?.level ?? 1)));
      return `heading${level}` as Block["type"];
    }
    return type;
  };

  private insertTextAction =
    (text: string): StateAction =>
    (s) =>
      insertText(s, text);

  /**
   * Give an installed feature first refusal over one explicit flat range.
   *
   * The public ChangeApi speaks block ids/source offsets for compatibility,
   * while a feature may own the target as structured content. Its read-only
   * ownership facet decides whether to route through normal input rules; core
   * never switches on a node type here. A returned result is the complete
   * replacement transaction (an inline `mark`, if requested by the caller, is
   * intentionally inapplicable to feature-owned structured content).
   */
  private featureOwnedInlineRangeInput = (
    s: EditorState,
    blockId: string,
    start: number,
    end: number,
    text: string,
  ): ActionResult | null => {
    const blockIndex = findBlockIndex(s.document.page, blockId);
    const block = s.document.page.blocks[blockIndex];
    // A block-authority document (a display equation) has no flat text, so a
    // public flat offset addresses nothing inside it. Refuse rather than
    // silently landing the edit at the equation's start; structured content is
    // edited through nested selections.
    if (block && !block.deleted && hasStructuredBlockAuthority(block)) {
      return null;
    }
    const targeted = selectTarget(s, {
      from: { block: blockId, offset: start },
      to: { block: blockId, offset: end },
    });
    if (
      block &&
      !block.deleted &&
      rangeIntersectsStructuredMark(block, start, end, s.schema)
    ) {
      // A public offset may clip a structured mark's anchor. Promote it to the
      // same whole-unit mixed selection used by interactive editing, then let
      // normal insertion replace prose plus the complete attachment atomically.
      return insertText(expandSelectionAroundStructuredMarks(targeted), text);
    }
    return targeted.schema.ownsInput("before-insert", targeted, text)
      ? insertText(targeted, text)
      : null;
  };

  // Build a ChangeApi over a working-state/ops accumulator. Each method queues
  // a StateAction by threading the accumulator forward, then returns the same
  // builder so calls chain. Nothing is committed here — commitChange does that.
  private makeChangeApi = (ctx: {
    state: EditorState;
    ops: Operation[];
  }): ChangeApi => {
    const apply = (cmd: StateAction) => {
      const r = cmd(ctx.state);
      ctx.state = r.state;
      ctx.ops.push(...r.ops);
    };
    const c: ChangeApi = {
      get identities() {
        return ctx.state.CRDTbinding;
      },
      insertText: (text, range, mark) => {
        // Hot path: typing at the caret / over the selection. The free
        // `insertText` is selection-aware (multi-block) and inherits the pending
        // caret format, so keep it byte-identical when no explicit target is given.
        if ((range === undefined || range === "selection") && !mark) {
          apply(this.insertTextAction(text));
        } else {
          apply((s) => {
            const r = resolveInlineRange(s, range);
            // Multi-block / unresolved selection: fall back to the selection-aware
            // insert (drops the mark — an explicit single-block range carries it).
            if (!r) return this.insertTextAction(text)(s);
            return this.replaceInlineRangeAction(
              r.blockId,
              r.start,
              r.end,
              text,
              mark,
            )(s);
          });
        }
        return c;
      },
      deleteRange: (range) => {
        if (range === undefined || range === "selection") {
          apply((s) =>
            s.document.contentSelection ||
            (s.document.selection &&
              !s.document.selection.isCollapsed &&
              s.schema.ownsInput("before-insert", s, ""))
              ? insertText(s, "")
              : deleteSelectedText(s),
          );
        } else {
          apply((s) => {
            const r = resolveInlineRange(s, range);
            if (!r || r.start === r.end) return { state: s, ops: [] };
            return this.deleteInlineRangeAction(r.blockId, r.start, r.end)(s);
          });
        }
        return c;
      },
      setMark: (name, opts) => {
        const isToggle =
          !opts ||
          (opts.active === undefined &&
            opts.attrs === undefined &&
            (opts.range === undefined || opts.range === "selection"));
        if (isToggle) {
          if (this.canToggleMark(name)) apply(this.toggleMarkAction(name));
        } else {
          apply((s) => {
            const r = resolveInlineRange(s, opts?.range);
            if (!r || r.start === r.end) return { state: s, ops: [] };
            const mark: Mark = opts?.attrs
              ? { type: name, attrs: opts.attrs }
              : { type: name };
            return this.setMarkRangeAction(
              r.blockId,
              r.start,
              r.end,
              mark,
              opts?.active ?? true,
            )(s);
          });
        }
        return c;
      },
      editContent: (blockId, contentId, edits) => {
        apply((s) => {
          if (!contentId) return { state: s, ops: [] };
          const blockIndex = findBlockIndex(s.document.page, blockId);
          const block = s.document.page.blocks[blockIndex];
          if (!block || block.deleted) return { state: s, ops: [] };

          let page = s.document.page;
          const ops: Operation[] = [];
          const mutations = Array.isArray(edits) ? edits : [edits];
          for (const edit of mutations) {
            const op: Operation = {
              op: "content_edit",
              id: s.CRDTbinding.nextId(),
              clock: s.CRDTbinding.getClock(),
              pageId: s.CRDTbinding.pageId,
              blockId,
              contentId,
              edit,
            };
            const next = applyOp(page, op, s.schema);
            if (next === page) continue;
            page = next;
            ops.push(op);
          }
          if (ops.length === 0) return { state: s, ops };
          invalidateBlockCache(page.blocks[blockIndex]);
          return {
            state: reconcileContentSelectionState({
              ...s,
              document: { ...s.document, page },
            }),
            ops,
          };
        });
        return c;
      },
      selectContent: (selection) => {
        apply((s) => ({
          state: updateContentSelection(s, cloneContentSelection(selection)),
          ops: [],
        }));
        return c;
      },
      insertBlock: (block: RuntimeBlockInput, at?: DocPoint) => {
        apply(this.insertBlockAction(block, at));
        return c;
      },
      setBlock: (attrs: RuntimeBlockPatch, at?: DocPoint) => {
        apply(this.setBlockAction(attrs, at));
        return c;
      },
      deleteBlock: (at) => {
        apply((s) => {
          const idx = resolveBlockIndex(s, at);
          if (idx < 0) return { state: s, ops: [] };
          return this.deleteBlockAction(s.document.page.blocks[idx].id)(s);
        });
        return c;
      },
      select: (target) => {
        apply((s) => ({ state: selectTarget(s, target), ops: [] }));
        return c;
      },
    };
    return c;
  };

  // Insert a fresh block at `at` (default: after the caret block). The block is
  // empty of text; its type seeds the default fields, and any caller-supplied
  // own attrs are synced as block_set ops.
  private insertBlockAction =
    (block: RuntimeBlockInput, at: DocPoint | undefined): StateAction =>
    (s) => {
      // Honor the authoring allow-list: inserting a disallowed block type is a
      // no-op — an explicit API insert of a forbidden type does nothing rather
      // than silently substituting a different type (mirrors convertBlockAtCursor).
      // No-op when unrestricted.
      if (!s.schema.isBlockAllowed(block.type)) return { state: s, ops: [] };
      const blocks = s.document.page.blocks;
      // The anchor block to insert after. A "before" point inserts after the
      // anchor's predecessor; "after"/default inserts after the anchor itself.
      const anchor = resolvePoint(s, at ?? "caret");
      let afterBlockId: string | null;
      if (!anchor) {
        // Empty doc (or unresolved): insert at the end.
        afterBlockId = null;
      } else if (
        typeof at === "object" &&
        "side" in at &&
        at.side === "before"
      ) {
        // Insert before the anchor → after its previous visible block.
        let prev = anchor.blockIndex - 1;
        while (prev >= 0 && blocks[prev].deleted) prev--;
        afterBlockId = prev >= 0 ? blocks[prev].id : null;
      } else {
        afterBlockId = anchor.blockId;
      }

      const blockId = block.id ?? `b-${s.CRDTbinding.nextId()}`;
      const orderKey = orderKeyAfter(blocks, afterBlockId);
      const seeded = s.schema.createDefaultBlock(block.type, blockId, orderKey);
      if (!seeded) return { state: s, ops: [] };

      // Caller-supplied own attrs beyond the structural fields become block_set.
      const reserved = new Set([
        "id",
        "type",
        "orderKey",
        "charRuns",
        "formats",
      ]);
      const extra = Object.fromEntries(
        Object.entries(block).filter(
          ([k, v]) => !reserved.has(k) && v !== undefined,
        ),
      );
      // A nested `style` object fans out to per-property `style.<key>` ops, same
      // as setBlock (each an independent LWW register).
      const entries = styleAwareEntries(extra);
      const newBlock = applyAttrEntries(seeded, entries);
      invalidateBlockCache(newBlock);

      // Place the block at its canonical sorted position (NOT an index splice):
      // `blocks` keeps tombstones, and a tombstone tied on the anchor's
      // orderKey makes "anchor index + 1" disagree with where every replica
      // sorts the minted key.
      const newBlocks = sortBlocksByOrder([...blocks, newBlock]);

      const ops: Operation[] = [
        {
          op: "block_insert",
          id: s.CRDTbinding.nextId(),
          clock: s.CRDTbinding.getClock(),
          pageId: s.CRDTbinding.pageId,
          orderKey,
          blockId,
          blockType: block.type,
        },
      ];
      for (const [field, value] of entries) {
        ops.push({
          op: "block_set",
          id: s.CRDTbinding.nextId(),
          clock: s.CRDTbinding.getClock(),
          pageId: s.CRDTbinding.pageId,
          blockId,
          field,
          value,
        });
      }

      return {
        state: {
          ...s,
          document: {
            ...s.document,
            page: { ...s.document.page, blocks: newBlocks },
          },
        },
        ops,
      };
    };

  // setBlock: reconcile one block toward `attrs`. A `type` change is structural —
  // at the caret block it uses the full caret-aware conversion (trailing
  // paragraph, void-text clearing); elsewhere it does a generic type set. Other
  // attrs are plain block_set, via setBlockAttrsAction.
  private setBlockAction =
    (attrs: RuntimeBlockPatch, at: DocPoint | undefined): StateAction =>
    (s) => {
      const idx = resolveBlockIndex(s, at);
      if (idx < 0) return { state: s, ops: [] };

      // Pull `type` (and, for the "heading" sugar, `level`) out of the attr bag.
      const rest: Record<string, unknown> = { ...attrs };
      const rawType = rest.type as string | undefined;
      delete rest.type;
      let resolvedType: string | undefined;
      if (rawType === "heading") {
        resolvedType = this.resolveBlockType("heading", {
          level: rest.level as number | undefined,
        });
        delete rest.level;
      } else if (rawType !== undefined) {
        resolvedType = rawType;
      }

      let state = s;
      const ops: Operation[] = [];
      // Honor the authoring allow-list: a disallowed target type is skipped (the
      // caret path's convertBlockAtCursor also no-ops, but gating here covers the
      // non-caret setBlockTypeAction too). Other attrs in the patch still apply.
      // No-op when unrestricted.
      if (resolvedType !== undefined && s.schema.isBlockAllowed(resolvedType)) {
        const caretIdx = s.document.cursor?.position.blockIndex;
        let r =
          idx === caretIdx
            ? convertBlockAtCursor(state, {
                type: resolvedType as Block["type"],
              })
            : this.setBlockTypeAction(idx, resolvedType)(state);
        // The caret-aware legacy conversion still knows only its built-in
        // descriptor table. If it cannot model an extension type, fall back to
        // the schema-driven generic morph instead of silently dropping the
        // public `change().setBlock({ type })` request.
        if (
          idx === caretIdx &&
          r.state === state &&
          r.ops.length === 0 &&
          state.document.page.blocks[idx]?.type !== resolvedType
        ) {
          r = this.setBlockTypeAction(idx, resolvedType)(state);
        }
        state = r.state;
        ops.push(...r.ops);
      }

      const fields = Object.keys(rest);
      if (fields.length > 0) {
        // The block index is stable across the type change (conversion mutates in
        // place), so re-read the id and apply the remaining attrs.
        const blockId = state.document.page.blocks[idx]?.id;
        if (blockId) {
          const r = this.setBlockAttrsAction(blockId, rest)(state);
          state = r.state;
          ops.push(...r.ops);
        }
      }

      return { state, ops };
    };

  // Generic (non-caret) block type change: morph the block in place to the new
  // type's defaults, preserving text/marks where the target allows, and emit the
  // type block_set plus the target type's own-field block_sets. No caret UX.
  private setBlockTypeAction =
    (blockIndex: number, type: string): StateAction =>
    (s) => {
      const blocks = s.document.page.blocks;
      const block = blocks[blockIndex];
      if (!block || block.deleted) return { state: s, ops: [] };
      // Generic morph reconstructs the block and cannot carry block-scoped
      // structured documents. This includes supplemental mark attachments: its
      // copied mark attrs would otherwise retain a now-orphaned contentId.
      // Offer the conversion to the owning feature first (which can convert
      // losslessly through CONVERT_STRUCTURED_BLOCK); refuse when unclaimed.
      if (hasStructuredContent(block)) {
        const owned = s.actionBus.dispatchState(CONVERT_STRUCTURED_BLOCK, s, {
          blockIndex,
          type,
        });
        return owned.claimed
          ? { state: owned.state, ops: owned.ops }
          : { state: s, ops: [] };
      }

      const defaults = s.schema.createDefaultBlock(
        type,
        block.id,
        block.orderKey ?? "",
      );
      if (!defaults) return { state: s, ops: [] };
      // Carry the source text/marks over only when both sides are textual;
      // otherwise the target type's defaults stand (a void block has no text).
      let newBlock: Block = defaults;
      if (
        s.schema.isTextual(type) &&
        s.schema.isTextual(block.type) &&
        hasTextStorage(defaults) &&
        hasTextStorage(block)
      ) {
        newBlock = {
          ...defaults,
          charRuns: block.charRuns,
          formats: s.schema.hasFormats(type) ? block.formats : [],
        } as Block;
      }
      invalidateBlockCache(newBlock);

      const newBlocks = [...blocks];
      newBlocks[blockIndex] = newBlock;

      const ops: Operation[] = [
        {
          op: "block_set",
          id: s.CRDTbinding.nextId(),
          clock: s.CRDTbinding.getClock(),
          pageId: s.CRDTbinding.pageId,
          blockId: block.id,
          field: "type",
          value: type,
        },
      ];
      for (const field of s.schema.getFieldNames(type)) {
        if (field === "type") continue;
        const value = (newBlock as unknown as Record<string, unknown>)[field];
        if (value === undefined) continue;
        ops.push({
          op: "block_set",
          id: s.CRDTbinding.nextId(),
          clock: s.CRDTbinding.getClock(),
          pageId: s.CRDTbinding.pageId,
          blockId: block.id,
          field,
          value,
        });
      }

      return {
        state: {
          ...s,
          document: {
            ...s.document,
            page: { ...s.document.page, blocks: newBlocks },
          },
        },
        ops,
      };
    };

  // Commit an accumulated batch as ONE undoable step: record undo, broadcast
  // once, re-render, notify. No-op (returns false) when nothing changed.
  private commitChange = (ctx: {
    state: EditorState;
    ops: Operation[];
  }): boolean => {
    const prev = this._state;
    const changed = ctx.state !== prev || ctx.ops.length > 0;
    if (!changed) return false;
    this._state =
      ctx.ops.length > 0
        ? recordUndoOps(prev, ctx.state, ctx.ops, prev.CRDTbinding.getPeerId())
        : ctx.state;
    this._state = reconcileContentSelectionState(this._state);
    if (ctx.ops.length > 0 && this.broadcastFn) this.emitLocalOps(ctx.ops);
    this.scheduleRender();
    const currentState = this._state;
    this.listeners.forEach((listener) => listener(currentState));
    return true;
  };

  change = (fn: (c: ChangeApi) => void): boolean => {
    const ctx = { state: this._state, ops: [] as Operation[] };
    fn(this.makeChangeApi(ctx));
    return this.commitChange(ctx);
  };

  canChange = (fn: (c: ChangeApi) => void): boolean => {
    const ctx = { state: this._state, ops: [] as Operation[] };
    fn(this.makeChangeApi(ctx));
    return ctx.state !== this._state || ctx.ops.length > 0;
  };

  // Names already warned about, so a typo bound to a per-keystroke shortcut
  // doesn't flood the console with the same message. Per-instance (no module
  // global), like every other piece of editor state.
  private readonly warnedUnknownActions = new Set<string>();

  // Look a schema-action name up in the per-instance registry. The single place
  // a keyboard `shortcut` resolves a *name*, so it's the one place to catch the
  // silent-no-op footgun: an unknown name resolves to `undefined` and is
  // skipped, which makes a typo vanish. In dev we warn once per name (listing
  // what *is* registered); in production it stays a quiet no-op. A non-string
  // shortcut target (an inline `EditorAction` / `MutationAction`) never reaches
  // here — it can't be mistyped.
  private lookupSchemaAction = (
    name: string,
  ): EditorAction | MutationAction<void> | undefined => {
    const named = this.schemaActions[name];
    if (!named && IS_DEV && !this.warnedUnknownActions.has(name)) {
      this.warnedUnknownActions.add(name);
      const available = Object.keys(this.schemaActions);
      console.warn(
        `[@tasfer/editor] shortcut referenced unknown action name ${JSON.stringify(
          name,
        )} — no action by that name is registered on the schema, so it was skipped. ` +
          (available.length
            ? `Registered action names: ${available.join(", ")}.`
            : `This editor's schema registers no named actions (declare them via the schema's \`actions\`).`),
      );
    }
    return named;
  };

  // Match a KeyboardEvent against a combo string like "mod+shift+b" (mod = ⌘
  // on macOS, Ctrl elsewhere; also ctrl/meta/cmd/alt/opt/shift). The final
  // token is the key, compared case-insensitively against `event.key` (so
  // "b"/"enter"/"/" all work). Returns true on an exact modifier+key match.
  private matchesShortcut = (e: KeyboardEvent, combo: string): boolean => {
    const parts = combo
      .toLowerCase()
      .split("+")
      .map((p) => p.trim())
      .filter(Boolean);
    const key = parts.pop();
    if (!key) return false;
    let wantCtrl = false;
    let wantMeta = false;
    let wantAlt = false;
    let wantShift = false;
    let wantMod = false;
    for (const mod of parts) {
      if (mod === "mod") wantMod = true;
      else if (mod === "ctrl" || mod === "control") wantCtrl = true;
      else if (mod === "meta" || mod === "cmd" || mod === "action")
        wantMeta = true;
      else if (mod === "alt" || mod === "opt" || mod === "option")
        wantAlt = true;
      else if (mod === "shift") wantShift = true;
      else return false; // unknown modifier token
    }
    const isMac = /Mac|iP(hone|ad|od)/.test(navigator.platform);
    // `mod` resolves to ⌘ on macOS and Ctrl elsewhere; the platform-native key
    // must be down and the other must not, so a combo can't double-fire.
    if (wantMod) {
      if (isMac ? !(e.metaKey && !e.ctrlKey) : !(e.ctrlKey && !e.metaKey))
        return false;
    } else {
      if (e.ctrlKey !== wantCtrl) return false;
      if (e.metaKey !== wantMeta) return false;
    }
    if (e.altKey !== wantAlt) return false;
    if (e.shiftKey !== wantShift) return false;
    return e.key.toLowerCase() === key;
  };

  // Run the first schema shortcut whose combo matches this event. Returns true
  // if one matched (so the keydown handler can preventDefault and stop the
  // built-in path). A MutationAction fires through `dispatch` so its observers
  // run; anything else is a raw mutation composed into one change().
  private handleSchemaShortcut = (e: KeyboardEvent): boolean => {
    for (const [combo, target] of Object.entries(this.schemaShortcuts)) {
      if (!this.matchesShortcut(e, combo)) continue;
      const resolved =
        typeof target === "string" ? this.lookupSchemaAction(target) : target;
      if (resolved && isMutationAction(resolved)) this.dispatch(resolved);
      else if (resolved) this.change((c) => resolved(c));
      return true;
    }
    return false;
  };

  // ── Query facet impls ──────────────────────────────────────────────────────
  // Bound instance fields bundled into the public `query` facet below (the read
  // mirror of `change`). Private — the surface a consumer holds is `query.*`.

  // Inverse of resolveBlockType: the read API speaks the same "heading" sugar
  // the write API accepts, so query.block/setBlock round-trip. The concrete
  // heading1/2/3 types (the CRDT/storage form) are projected back to
  // { type: "heading", attrs: { level } } here, at the public boundary only —
  // storage, serialization, and the wire format stay discrete.
  private presentBlock = (node: RuntimeBlockData): RuntimeBlockData => {
    const m = /^heading([1-3])$/.exec(node.type);
    if (!m) return node;
    return {
      ...node,
      type: "heading",
      attrs: { ...node.attrs, level: Number(m[1]) },
    };
  };

  private queryBlock = (at?: DocPoint): RuntimeBlockData | null => {
    const idx = resolveBlockIndex(this._state, at);
    if (idx < 0) return null;
    return this.presentBlock(
      toBlockData(this._state.document.page.blocks[idx]),
    );
  };

  private queryBlocks = (range?: DocRange): RuntimeBlockData[] => {
    const span = resolveBlockSpan(this._state, range);
    if (!span) return [];
    const blocks = this._state.document.page.blocks;
    const result: RuntimeBlockData[] = [];
    for (let i = span.startIndex; i <= span.endIndex; i++) {
      const b = blocks[i];
      if (b && !b.deleted) result.push(this.presentBlock(toBlockData(b)));
    }
    return result;
  };

  private queryContent = (
    blockId: string,
    contentId: string,
  ): StructuredDocument | null => {
    const blockIndex = findBlockIndex(this._state.document.page, blockId);
    const block = this._state.document.page.blocks[blockIndex];
    if (!block || block.deleted) return null;
    const document = block.structuredContent?.[contentId];
    return document ? canonicalizeStructuredDocument(document) : null;
  };

  copy = async (
    docRange?: DocRange | null,
    selectRange?: boolean,
  ): Promise<boolean> => {
    // `docRange` resolves to a working state whose selection is the requested
    // range; without it, copy the live selection. Copy is non-destructive, so
    // the live selection only moves when `selectRange` is set.
    const working =
      docRange != null ? selectTarget(this._state, docRange) : this._state;
    const success = await copySelectionToClipboard(
      working,
      this.clipboard ?? undefined,
    );
    const moveSelection = success && docRange != null && !!selectRange;
    this._state = closeActiveMenu(
      moveSelection ? updateMode(working, "edit") : this._state,
    );
    this.scheduleRender();
    if (moveSelection) {
      const currentState = this._state;
      this.listeners.forEach((listener) => listener(currentState));
    }
    return success;
  };

  cut = async (
    docRange?: DocRange | null,
    selectRange?: boolean,
  ): Promise<boolean> => {
    // Capture the live selection before cutting so we can restore it when the
    // caller cut an explicit range but did not ask to move the caret there.
    const originalSelection =
      docRange != null && !selectRange ? docSelection(this._state) : null;
    const working =
      docRange != null ? selectTarget(this._state, docRange) : this._state;
    const result = await cutSelectionToClipboard(
      working,
      this.clipboard ?? undefined,
    );
    if (result.success && result.result) {
      // `deleteSelectedText` collapses the caret at the cut point. Restore the
      // pre-cut selection (block-id anchored, offset-clamped) when requested.
      const finalState = originalSelection
        ? selectTarget(result.result.state, originalSelection)
        : result.result.state;
      this.executeAction({
        state: closeActiveMenu(finalState),
        ops: result.result.ops,
      });
      return true;
    }
    this._state = closeActiveMenu(this._state);
    this.scheduleRender();
    return false;
  };

  paste = async (): Promise<boolean> => {
    const result = await pasteFromSystemClipboard(
      this._state,
      this.clipboard ?? undefined,
    );
    if (result) {
      this.executeAction(result);
      // Mirror the synchronous Cmd/Ctrl+V path (see the IMAGE_PASTE dispatch in
      // handleEvents): if a raw image was pasted, let the host upload it and
      // rewrite the temporary blob url. The block is addressed by stable id.
      if (
        result.pastedImageFile &&
        result.pastedImageBlockIndex !== undefined
      ) {
        const pastedBlock =
          this._state.document.page.blocks[result.pastedImageBlockIndex];
        if (pastedBlock) {
          this.dispatch(IMAGE_PASTE, {
            file: result.pastedImageFile,
            blockId: pastedBlock.id,
          });
        }
      }
      this._state = closeActiveMenu(this._state);
      this.scheduleRender();
      return true;
    }
    this._state = closeActiveMenu(this._state);
    this.scheduleRender();
    return false;
  };

  undo = (): boolean => {
    const result = undoState(this._state);
    if (result.state === this._state) return false;
    this._state = result.state;
    this._state = reconcileContentSelectionState(this._state);
    this.scheduleRender();
    this.listeners.forEach((listener) => listener(this._state));
    // Broadcast inverse operations to sync engine
    if (result.ops.length > 0 && this.broadcastFn) {
      this.emitLocalOps(result.ops);
    }
    return true;
  };

  redo = (): boolean => {
    const result = redoState(this._state);
    if (result.state === this._state) return false;
    this._state = result.state;
    this._state = reconcileContentSelectionState(this._state);
    this.scheduleRender();
    this.listeners.forEach((listener) => listener(this._state));
    // Broadcast redo operations to sync engine
    if (result.ops.length > 0 && this.broadcastFn) {
      this.emitLocalOps(result.ops);
    }
    return true;
  };

  private setMarkRangeAction =
    (
      blockId: string,
      start: number,
      end: number,
      mark: Mark,
      active: boolean,
    ): StateAction =>
    (s) => {
      // Honor the authoring allow-list — applying a disallowed mark over a range
      // (link, math, or any ranged mark) is a no-op. No-op when unrestricted.
      if (!s.schema.isMarkAllowed(mark.type)) return { state: s, ops: [] };
      const blocks = s.document.page.blocks;
      const blockIndex = findBlockIndex(s.document.page, blockId);
      const block = blocks[blockIndex];
      if (!block || block.deleted || !isTextualBlock(block))
        return { state: s, ops: [] };
      if (hasStructuredBlockAuthority(block)) return { state: s, ops: [] };
      if (end <= start) return { state: s, ops: [] };
      if (
        rangeIntersectsStructuredMark(block, start, end, s.schema, mark.type)
      ) {
        return { state: s, ops: [] };
      }

      // The mark's per-mark data (e.g. a link url) rides on mark.attrs.
      const { newPage, op } = markCharsInRange(
        s.document.page,
        blockId,
        start,
        end,
        mark,
        active,
        s.CRDTbinding,
      );
      invalidateBlockCache(newPage.blocks[blockIndex]);

      return {
        state: { ...s, document: { ...s.document, page: newPage } },
        ops: [op],
      };
    };

  setMode = (mode: "edit" | "select" | "suspended"): void => {
    this._state = updateMode(this._state, mode);

    // Stop momentum when entering suspended mode
    if (mode === "suspended") {
      this._state = {
        ...this._state,
        view: {
          ...this._state.view,
          momentum: {
            velocity: 0,
            lastTime: Date.now(),
            isActive: false,
          },
        },
      };
    }

    const currentState = this._state;
    this.scheduleRender();
    this.listeners.forEach((listener) => listener(currentState));
  };

  private setBlockAttrsAction =
    (blockId: string, attrs: Record<string, unknown>): StateAction =>
    (s) => {
      const blocks = s.document.page.blocks;
      const blockIndex = findBlockIndex(s.document.page, blockId);
      const block = blocks[blockIndex];
      if (!block || block.deleted) return { state: s, ops: [] };

      // A nested `style` object fans out to one `style.<key>` op per property
      // (each an independent LWW register); other attrs map to one op each.
      const entries = styleAwareEntries(attrs);
      if (entries.length === 0) return { state: s, ops: [] };

      const updatedBlock = applyAttrEntries(block, entries);
      // Layout caches are keyed by content; an attr change (image URL, math
      // latex, a style font size, …) can change a block's measured height, so
      // drop its cache.
      invalidateBlockCache(updatedBlock);

      const newBlocks = [...blocks];
      newBlocks[blockIndex] = updatedBlock;

      // Each (field, value) is a block_set op. The field/value are validated
      // against the block type's registered schema when the op is applied, so
      // this stays generic — the editor needs no per-block-type knowledge here.
      const ops: Operation[] = entries.map(([field, value]): Operation => ({
        op: "block_set",
        id: s.CRDTbinding.nextId(),
        clock: s.CRDTbinding.getClock(),
        pageId: s.CRDTbinding.pageId,
        blockId,
        field,
        value,
      }));

      return {
        state: {
          ...s,
          document: {
            ...s.document,
            page: { ...s.document.page, blocks: newBlocks },
          },
        },
        ops,
      };
    };

  setNodeViewState = (blockId: string, data: unknown | null): void => {
    // Transient per-block canvas chrome (e.g. an image's upload spinner) — not
    // document content, so no CRDT op. `null` clears the block's entry.
    const next = { ...this._state.ui.nodeViewState };
    if (data == null) delete next[blockId];
    else next[blockId] = data;
    this._state = {
      ...this._state,
      ui: { ...this._state.ui, nodeViewState: next },
    };
    const currentState = this._state;
    this.scheduleRender();
    this.listeners.forEach((listener) => listener(currentState));
  };

  private deleteBlockAction =
    (blockId: string): StateAction =>
    (s) => {
      const blocks = s.document.page.blocks;
      const blockIndex = findBlockIndex(s.document.page, blockId);
      const block = blocks[blockIndex];
      if (!block || block.deleted) return { state: s, ops: [] };

      // Tombstone the block (mark deleted) instead of splicing it out, so undo
      // can locate it in state to compute the inverse block_insert.
      const newBlocks = [...blocks];
      newBlocks[blockIndex] = { ...block, deleted: true };

      const ops: Operation[] = [
        {
          op: "block_delete",
          id: s.CRDTbinding.nextId(),
          clock: s.CRDTbinding.getClock(),
          pageId: s.CRDTbinding.pageId,
          blockId,
        },
      ];

      // If that was the last visible block, keep the document editable by
      // inserting an empty paragraph in its place.
      const visibleCount = newBlocks.filter((b) => !b.deleted).length;
      if (visibleCount === 0) {
        const newParagraphBlockId = `b-${s.CRDTbinding.nextId()}`;
        const orderKey = orderKeyAfter(newBlocks, null);
        newBlocks.push({
          id: newParagraphBlockId,
          orderKey,
          type: "paragraph",
          charRuns: [],
          formats: [],
        });
        ops.push({
          op: "block_insert",
          id: s.CRDTbinding.nextId(),
          clock: s.CRDTbinding.getClock(),
          pageId: s.CRDTbinding.pageId,
          orderKey,
          blockId: newParagraphBlockId,
          blockType: "paragraph",
        });
      }

      return {
        state: {
          ...s,
          document: {
            ...s.document,
            page: { ...s.document.page, blocks: newBlocks },
          },
        },
        ops,
      };
    };

  private applyActiveMenu = (menu: Exclude<ActiveMenu, { type: "none" }>) => {
    this._state = setActiveMenu(this._state, menu);

    const currentState = this._state;
    this.scheduleRender();
    this.listeners.forEach((listener) => listener(currentState));
  };

  openOverlay = (overlay: {
    key: string;
    blockId: string;
    x: number;
    y: number;
    data?: unknown;
  }): void => {
    this.applyActiveMenu({ type: "overlay", ...overlay });
  };

  private replaceInlineRangeAction =
    (
      blockId: string,
      start: number,
      end: number,
      text: string,
      mark?: Mark,
    ): StateAction =>
    (s) => {
      const blocks = s.document.page.blocks;
      const blockIndex = findBlockIndex(s.document.page, blockId);
      const block = blocks[blockIndex];
      if (!block || block.deleted || !isTextualBlock(block))
        return { state: s, ops: [] };
      // An empty replacement is a deletion of the range.
      if (text.length === 0)
        return this.deleteInlineRangeAction(blockId, start, end)(s);

      const featureResult = this.featureOwnedInlineRangeInput(
        s,
        blockId,
        start,
        end,
        text,
      );
      if (featureResult) return featureResult;
      if (hasStructuredBlockAuthority(block)) return { state: s, ops: [] };

      const ops: Operation[] = [];

      // Replace the chars in [start, end) with `text`, then (optionally) apply
      // the mark to the freshly inserted run.
      const { newPage: p1, op: deleteOp } = deleteCharsInRange(
        s.document.page,
        blockId,
        start,
        end,
        s.CRDTbinding,
      );
      ops.push(deleteOp);

      const { newPage: p2, op: insertOp } = insertCharsAtPosition(
        p1,
        blockId,
        start,
        text,
        s.CRDTbinding,
      );
      ops.push(insertOp);

      let page = p2;
      if (mark) {
        const { newPage: p3, op: formatOp } = markCharsInRange(
          p2,
          blockId,
          start,
          start + text.length,
          mark,
          // Apply the mark; its per-mark data (e.g. a link url) rides mark.attrs.
          true,
          s.CRDTbinding,
        );
        ops.push(formatOp);
        page = p3;
      }

      invalidateBlockCache(page.blocks[blockIndex]);

      return {
        state: { ...s, document: { ...s.document, page } },
        ops,
      };
    };

  private deleteInlineRangeAction =
    (blockId: string, start: number, end: number): StateAction =>
    (s) => {
      const blocks = s.document.page.blocks;
      const blockIndex = findBlockIndex(s.document.page, blockId);
      const block = blocks[blockIndex];
      if (!block || block.deleted || !isTextualBlock(block))
        return { state: s, ops: [] };
      if (end <= start) return { state: s, ops: [] };

      const featureResult = this.featureOwnedInlineRangeInput(
        s,
        blockId,
        start,
        end,
        "",
      );
      if (featureResult) return featureResult;
      if (hasStructuredBlockAuthority(block)) return { state: s, ops: [] };

      const { newPage, op } = deleteCharsInRange(
        s.document.page,
        blockId,
        start,
        end,
        s.CRDTbinding,
      );
      invalidateBlockCache(newPage.blocks[blockIndex]);

      // Place the caret where the deleted range began.
      const movedState = moveCursorToPosition(
        { ...s, document: { ...s.document, page: newPage } },
        blockIndex,
        start,
      );

      return { state: movedState, ops: [op] };
    };

  closeActiveMenu = (): void => {
    this._state = closeActiveMenu(this._state);
    const currentState = this._state;
    this.scheduleRender();
    this.listeners.forEach((listener) => listener(currentState));
  };

  clearLinkHover = (): void => {
    if (!this._state.ui.linkHover) return;
    this._state = {
      ...this._state,
      ui: { ...this._state.ui, linkHover: null },
    };
    const currentState = this._state;
    this.scheduleRender();
    this.listeners.forEach((listener) => listener(currentState));
  };

  isHostMenuCapturing = (): boolean => this.session.hostMenuCapturing;

  updatePageFromSync = (
    page: Page,
    remoteOps: readonly Operation[] = [],
  ): void => {
    // Update the page from CRDT sync while preserving cursor/selection
    // This is called when remote operations are applied

    // Clear all block caches since page structure may have changed
    clearAllBlockCaches(page.blocks);

    // Compute visible blocks from the NEW page, not the stale view state
    const visibleBlocks = getVisibleBlocks(page, this._state.view.window);
    this._state.view.visibleBlocks = visibleBlocks;

    // Validate and adjust cursor position if needed
    let cursor = this._state.document.cursor;
    if (cursor && visibleBlocks.length > 0) {
      const { blockIndex: blockIndex, textIndex } = cursor.position;
      // Find the last visible block's index in the full array
      const lastVisibleBlock = visibleBlocks[visibleBlocks.length - 1];
      const maxBlockIndex = page.blocks.findIndex(
        (b) => b.id === lastVisibleBlock.id,
      );

      if (blockIndex > maxBlockIndex) {
        // Cursor points to a block that no longer exists, move to end of last visible block
        const lastBlock = lastVisibleBlock;
        const lastBlockText = getBlockTextContent(lastBlock);
        cursor = {
          ...cursor,
          position: {
            blockIndex: maxBlockIndex,
            textIndex: lastBlockText.length,
          },
        };
      } else {
        // Validate textIndex for the block
        const block = page.blocks[blockIndex];
        if (!block || block.deleted) {
          // Cursor's block was deleted, move to end of last visible block
          const lastBlockText = getBlockTextContent(lastVisibleBlock);
          cursor = {
            ...cursor,
            position: {
              blockIndex: maxBlockIndex,
              textIndex: lastBlockText.length,
            },
          };
        } else {
          const blockText = getBlockTextContent(block);
          if (textIndex > blockText.length) {
            cursor = {
              ...cursor,
              position: {
                blockIndex: blockIndex,
                textIndex: blockText.length,
              },
            };
          }
        }
      }
    } else if (cursor && visibleBlocks.length === 0) {
      // No visible blocks, clear cursor
      cursor = null;
    }

    // Validate selection as well
    let selection = this._state.document.selection;
    if (selection && visibleBlocks.length > 0) {
      // Find the last visible block's index in the full array
      const lastVisibleBlockForSelection =
        visibleBlocks[visibleBlocks.length - 1];
      const maxBlockIndex = page.blocks.findIndex(
        (b) => b.id === lastVisibleBlockForSelection.id,
      );
      const { anchor, focus } = selection;

      let newAnchor = anchor;
      let newFocus = focus;

      if (anchor.blockIndex > maxBlockIndex) {
        const lastBlock = page.blocks[maxBlockIndex];
        const lastBlockText = getBlockTextContent(lastBlock);
        newAnchor = {
          blockIndex: maxBlockIndex,
          textIndex: lastBlockText.length,
        };
      }

      if (focus.blockIndex > maxBlockIndex) {
        const lastBlock = page.blocks[maxBlockIndex];
        const lastBlockText = getBlockTextContent(lastBlock);
        newFocus = {
          blockIndex: maxBlockIndex,
          textIndex: lastBlockText.length,
        };
      }

      if (newAnchor !== anchor || newFocus !== focus) {
        selection = {
          ...selection,
          anchor: newAnchor,
          focus: newFocus,
          isCollapsed:
            newAnchor.blockIndex === newFocus.blockIndex &&
            newAnchor.textIndex === newFocus.textIndex,
        };
      }
    } else if (selection && visibleBlocks.length === 0) {
      selection = null;
    }

    // Update the page in state
    this._state = {
      ...this._state,
      document: {
        ...this._state.document,
        page,
        cursor,
        selection,
      },
    };

    // A remote edit can insert/delete blocks before the windowed block, shifting
    // a stale caret out of the window — snap it back (no-op when unwindowed).
    this._state = this.clampToWindow(this._state);
    this._state = reconcileContentSelectionState(this._state);

    // Mark document height as dirty since page content changed
    this.documentHeightDirty = true;

    // Re-render
    const currentState = this._state;
    this.scheduleRender();
    this.listeners.forEach((listener) => listener(currentState));
    // Fire the change event as a remote-applied edit (isRemote: true).
    this.emitChange(remoteOps, true);
  };

  /**
   * Restore from snapshot by generating operations.
   * This is for user-initiated restores - generates and broadcasts ops to peers.
   */
  restoreFromSnapshot = (newBlocks: Block[]): void => {
    const currentPage = this._state.document.page;
    const prevState = this._state;

    // Generate operations using the snapshot-diff utility
    const ops = generateRestoreOperations({
      currentBlocks: this._state.view.visibleBlocks,
      newBlocks,
      pageId: this._state.CRDTbinding.pageId,
      peerId: this._state.CRDTbinding.getPeerId(),
      nextId: this._state.CRDTbinding.nextId,
      getClock: this._state.CRDTbinding.getClock,
      schema: this._state.schema,
    });

    if (ops.length === 0) return;

    // Apply operations to local state
    const newPage = applyOps(currentPage, ops, this._state.schema);

    // Clear all block caches
    clearAllBlockCaches(newPage.blocks);

    // Update visibleBlocks from the new page so cursor targets a valid block
    this._state.view.visibleBlocks = getVisibleBlocks(
      newPage,
      this._state.view.window,
    );
    const newVisibleBlocks = this._state.view.visibleBlocks;

    // Reset cursor to beginning of first visible block
    this._state = {
      ...this._state,
      document: {
        ...this._state.document,
        page: newPage,
        cursor:
          newVisibleBlocks.length > 0
            ? {
                position: {
                  blockIndex: newVisibleBlocks[0].originalIndex,
                  textIndex: 0,
                },
                lastUpdate: Date.now(),
              }
            : null,
        selection: null,
        contentSelection: null,
      },
    };

    // Record to undo stack
    this._state = recordUndoOps(
      prevState,
      this._state,
      ops,
      this._state.CRDTbinding.getPeerId(),
    );

    // Broadcast operations to peers
    if (this.broadcastFn) {
      this.emitLocalOps(ops);
    }

    // A wholesale replace swaps the whole document; rebuild the accessible
    // mirror from the new blocks directly. This also covers the standalone
    // (no-broadcast) case, where ops never flow through `emitChange`.
    this.a11yMirror?.rebuild();

    // Mark document height as dirty and reset scroll to top
    this.documentHeightDirty = true;
    this.applyProgrammaticScroll(0);

    // Re-render and notify listeners
    const currentState = this._state;
    this.scheduleRender();
    this.listeners.forEach((listener) => listener(currentState));
  };

  setBroadcast = (fn: ((ops: Operation[]) => void) | null): void => {
    this.broadcastFn = fn;
  };

  setClipboard = (clipboard: HostClipboard | null): void => {
    this.clipboard = clipboard;
  };

  setTheme = (patch: EditorTheme): void => {
    const nextTheme = mergeTheme(this._state.theme, patch);
    this._state = {
      ...this._state,
      theme: nextTheme,
      resolvedStyles: resolveTheme(nextTheme),
      resolvedNodeStrings: resolveNodeStrings(this._state.nodes, nextTheme),
    };
    // Block layout is cached keyed by content/width; text metrics depend on the
    // theme's font sizes/weights/family, so invalidate so blocks re-measure and
    // the document height recomputes with the new styles.
    clearAllBlockCaches(this._state.document.page.blocks);
    this.documentHeightDirty = true;
    this.rebuildBlockHeightIndex();
    this.scheduleRender();
  };

  get state(): EditorStateSnapshot {
    const selection = this._state.document.selection;
    const selectedBlock =
      selection && isNodeSelection(selection)
        ? (this._state.document.page.blocks[selection.anchor.blockIndex]?.id ??
          null)
        : null;
    return {
      selection: {
        empty: !selection || selection.isCollapsed,
        range: docSelection(this._state),
        block: selectedBlock,
      },
      contentSelection: cloneContentSelection(
        this._state.document.contentSelection,
      ),
      activeMarks: docMarks(this._state, undefined),
      canUndo: canUndoState(this._state),
      canRedo: canRedoState(this._state),
      isFocused: this._state.view.isFocused,
      mode: this._state.ui.mode,
      isReadonlyBase: this._state.ui.isReadonlyBase,
      caretScratchActive: this.queryCaretScratchActive(),
    };
  }

  // Whether caret-anchored command-entry scratch is armed at the live caret.
  private queryCaretScratchActive = (): boolean => {
    const caret = resolvePoint(this._state, "caret");
    return caret
      ? isCaretScratchActive(this._state, caret.blockId, caret.offset)
      : false;
  };

  collectOverlays = (): NodeOverlay[] =>
    collectOverlays(
      this._state,
      this.viewport,
      getEditorStyles(this._state),
      this.blockHeights,
    );

  getScrollY = (): number => this.viewport.scrollY;

  getStyles = (): EditorStyles => getEditorStyles(this._state);

  setDecorations = (
    layer: string,
    decorations: readonly Decoration[],
  ): void => {
    this._state = {
      ...this._state,
      ui: {
        ...this._state.ui,
        decorations: setDecorationLayer(
          this._state.ui.decorations,
          layer,
          decorations,
        ),
      },
    };
    this.scheduleRender();
  };

  clearDecorations = (layer: string): void => {
    if (!(layer in this._state.ui.decorations)) return;
    this._state = {
      ...this._state,
      ui: {
        ...this._state.ui,
        decorations: removeDecorationLayer(this._state.ui.decorations, layer),
      },
    };
    this.scheduleRender();
  };

  scrollToPosition = (
    point: DocPoint,
    options?: { viewportOffsetY?: number },
  ): void => {
    const resolved = resolvePoint(this._state, point);
    if (!resolved) return;
    const position: Position = {
      blockIndex: resolved.blockIndex,
      textIndex: resolved.offset,
    };
    if (options?.viewportOffsetY !== undefined) {
      const current = this.coordsAtIndexPosition(position);
      if (current) {
        const maxScroll = Math.max(
          0,
          this.calculateDocumentHeight() - this.viewport.height,
        );
        const scrollY = Math.max(
          0,
          Math.min(
            maxScroll,
            this.viewport.scrollY + current.y - options.viewportOffsetY,
          ),
        );
        this.applyProgrammaticScroll(scrollY);
        this.pendingViewportAnchor = {
          position,
          viewportOffsetY: options.viewportOffsetY,
          remainingCorrections: 3,
        };
        this.scheduleRender();
        return;
      }
    }
    // Minimum scroll to bring the point into view. Must use the same indexed
    // block flow the painter positions blocks with (estimates for unmeasured
    // prefixes), not an exact layout walk — the two disagree for far-off
    // targets, which put the highlight at the wrong viewport offset. The
    // pending-anchor corrections then converge on the true spot as heights
    // become exact.
    this.scrollPositionIntoView(position);
  };

  // ── Public facets ──────────────────────────────────────────────────────────
  // `view` / `host` bundle the geometry and chrome members off the flat root
  // (see EditorViewApi / EditorHostApi). The implementations stay as the
  // instance arrow-fields above — already `this`-bound, so referencing them here
  // is safe; engine-internal callers (mountEditor, createEditor) use the
  // flat fields directly. Declared last so every referenced field is initialized
  // by the time these initializers run.
  query: QueryApi<AnySchemaDefinition> = {
    block: this.queryBlock,
    blocks: this.queryBlocks,
    marks: (at?: DocPoint) => queryMarkInfos(this._state, at),
    content: this.queryContent,
  };

  view: EditorViewApi = {
    coordsAtPos: this.coordsAtPos,
    coordsAtContent: this.coordsAtContentPoint,
    updateViewport: this.updateViewport,
    getScrollY: this.getScrollY,
    getStyles: this.getStyles,
    scrollToPosition: this.scrollToPosition,
    setDecorations: this.setDecorations,
    clearDecorations: this.clearDecorations,
    showDropIndicator: this.showDropIndicator,
    edgeScrollForDrag: this.edgeScrollForDrag,
  };

  host: EditorHostApi = {
    setMode: this.setMode,
    collectOverlays: this.collectOverlays,
    openOverlay: this.openOverlay,
    setNodeViewState: this.setNodeViewState,
    closeActiveMenu: this.closeActiveMenu,
    clearLinkHover: this.clearLinkHover,
    restoreFromSnapshot: this.restoreFromSnapshot,
  };
}
