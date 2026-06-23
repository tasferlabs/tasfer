import {
  type Action,
  type ActionHandler,
  CLOSE_CONTEXT_MENU,
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
  pasteFromSystemClipboard,
} from "../actions/clipboard";
import { COPY, CUT } from "../actions/input-actions";
import { IS_DEV } from "../env";
import { createChromeRegionRegistry } from "../events/chromeRegions";
import { handleEvents } from "../events/events";
import {
  createInteractionSession,
  isInLongPressMode,
} from "../events/interaction-session";
import { onFontsReady } from "../fonts";
import { getBlockTextContent } from "../node-shared";
import {
  type BlockData,
  docMarks,
  type DocPoint,
  type DocRange,
  docSelection,
  resolveBlockIndex,
  resolveBlockSpan,
  resolveInlineRange,
  resolvePoint,
  selectTarget,
  toBlockData,
} from "../positions";
import type { Decoration } from "../rendering/decorations";
import {
  removeDecorationLayer,
  setDecorationLayer,
} from "../rendering/decorations";
import {
  clearAllBlockCaches,
  collectOverlays,
  getBlockHeight,
  invalidateBlockCache,
  renderCursorLayer,
  renderPage,
} from "../rendering/renderer";
import {
  getCursorCoordinatesWithComposition,
  getCursorDocumentCoords,
  scrollToMakeCursorVisible,
} from "../selection";
import { moveCursorToPosition } from "../selection";
import { isCursorBlinking } from "../selection";
import { updateFocus } from "../selection";
import { updateCursor } from "../selection";
import { clearSelection } from "../selection";
import { updateSelection } from "../selection";
import {
  type Block,
  loadPage,
  type Mark,
  type Page,
} from "../serlization/loadPage";
import { serializeToMarkdown } from "../serlization/serializer";
import type {
  ActionResult,
  ActiveMenu,
  EditorState,
  EditorTheme,
  NodeOverlay,
  Position,
  ViewportState,
} from "../state-types";
import type { Operation } from "../state-types";
import {
  closeActiveMenu,
  isTouchDevice,
  setActiveMenu,
  updateMode,
} from "../state-utils";
import {
  getEditorStyles,
  mergeTheme,
  resolveNodeStrings,
  resolveTheme,
} from "../styles";
import {
  canHaveFormats,
  createDefaultBlock,
  getBlockFieldNames,
  isPlainStyleObject,
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
} from "../sync/crdt-utils";
import { applyOps } from "../sync/reducer";
import { generateRestoreOperations } from "../sync/snapshot-diff";
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
export type MarkName = string;

// The DocPoint / DocRange / BlockData position vocabulary — and the pure resolvers
// that consume it — live in `../positions` (free functions over EditorState, so
// they're unit-testable without a canvas). Re-exported here because they're part
// of the ChangeApi / read-API contract.
export type { BlockData, DocPoint, DocRange } from "../positions";

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
export interface ChangeApi {
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
  setMark(
    name: MarkName,
    opts?: { active?: boolean; attrs?: Mark["attrs"]; range?: DocRange },
  ): this;

  // ── block ───────────────────────────────────────────────────────────────
  /**
   * Insert a new block at `at` (a block-edge {@link DocPoint}; default: after the
   * caret block). The block's `type` is required; an `id` is generated when
   * absent and any extra own attrs are applied as `block_set` ops — a nested
   * `style` object seeds per-block visual overrides, fanned out per property the
   * same way {@link setBlock} does. Text content is not seeded — insert an empty
   * block, then fill it.
   */
  insertBlock(
    block: Partial<Block> & { type: Block["type"] },
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
  setBlock(
    attrs: { type?: Block["type"] | "heading"; level?: number } & Record<
      string,
      unknown
    >,
    at?: DocPoint,
  ): this;
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
export type EditorAction = (c: ChangeApi) => void;

/**
 * Read-only snapshot of editor state for UI binding (see {@link Editor.state}).
 * A fresh value is built on each read and is never mutated, so it's safe to
 * destructure and hold for the duration of one read.
 */
export interface EditorStateSnapshot {
  /**
   * The current selection: `empty` is true for a bare caret (or no caret), and
   * `range` is the selection as a {@link DocRange} (a collapsed point for a
   * caret), or `null` when there is no caret/selection — the same currency the
   * {@link ChangeApi} methods accept, surfaced reactively.
   */
  readonly selection: {
    readonly empty: boolean;
    readonly range: DocRange | null;
  };
  /** Inline marks active at the caret / across the selection. */
  readonly activeMarks: ReadonlySet<Mark["type"]>;
  /**
   * The block type at the caret — with `heading` sugar applied (`"heading"`,
   * not `heading1/2/3`), matching {@link ChangeApi.setBlock} — or `null` when
   * there is no caret/block. Lets a block-type dropdown light up reactively
   * without an imperative {@link EditorApi.getBlock} read.
   */
  readonly activeBlockType: string | null;
  /** Whether {@link EditorApi.undo} would currently change the document. */
  readonly canUndo: boolean;
  /** Whether {@link EditorApi.redo} would currently change the document. */
  readonly canRedo: boolean;
  /** Whether the editor currently has focus. */
  readonly isFocused: boolean;
}

/**
 * The viewport/geometry & ephemeral-paint facet of {@link EditorApi}, reached as
 * `editor.view`. Read-mostly host plumbing: where the caret/blocks sit on screen,
 * scroll position, and the generic decoration layers (find highlights, remote
 * cursors). Public and semver-stable — providers depend on the decoration
 * members (see `@cypherkit/provider-core/cursors`) — but kept off the flat root
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
   * Merge a partial viewport patch (e.g. width/height on a container resize) and
   * re-render. A width change clears cached block layout, since it affects text
   * wrapping and document height.
   */
  updateViewport: (viewport: Partial<ViewportState>) => void;
  /** Get current scroll position. */
  getScrollY: () => number;
  /** Scroll the viewport to make a document point visible. Speaks the same
   * public {@link DocPoint} vocabulary as {@link coordsAtPos}: an absolute
   * `{ block, offset }` (the stable, CRDT-id form), or a relative
   * `"caret"`/`"start"`/`"end"`. */
  scrollToPosition: (point: DocPoint) => void;
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
  /** Restore from snapshot - generates and broadcasts operations */
  restoreFromSnapshot: (blocks: Block[]) => void;
}

/**
 * The read facet of {@link EditorApi}, reached as `editor.query` — the mirror of
 * the {@link ChangeApi} write surface. Every method speaks the same
 * {@link DocPoint}/{@link DocRange} vocabulary and defaults to the live
 * caret/selection, so a read pairs symmetrically with its write:
 * `query.block(at)` ↔ `c.setBlock(attrs, at)`, `query.marks(range)` ↔
 * `c.setMark(name, { range })`. A host reads a {@link BlockData}'s id/attrs here
 * and hands them straight back to a {@link Editor.change} without touching
 * {@link EditorApi.getState}. The selection itself — the caret/anchor `DocRange`
 * with offsets — is read off the reactive snapshot at
 * {@link EditorStateSnapshot.selection} (`editor.state.selection.range`), the
 * one place that value lives.
 */
export interface QueryApi {
  /**
   * Plain-data view of the single block at `at` (default: the caret block), or
   * `null` when there's no such block. Address a specific block by id with
   * `block({ block: id })` (the common "find the block this overlay/menu
   * targets" pattern) — no scan of {@link EditorApi.getState}'s raw block array.
   * The point counterpart to {@link blocks}: this takes a {@link DocPoint} and
   * returns one block, that takes a {@link DocRange} and returns the span.
   */
  block(at?: DocPoint): BlockData | null;
  /**
   * The visible blocks the `range` touches, in document order — the same
   * {@link DocRange} the {@link ChangeApi} methods speak. Defaults to the
   * **selection**, so `blocks()` is "the blocks under the caret/selection"
   * (equivalently `blocks(editor.state.selection.range)`). Narrow to any span
   * without fetching-then-filtering; for the whole document pass
   * `{ from: "start", to: "end" }`. A collapsed range (or bare point) yields the
   * one block there; empty when the range can't be resolved.
   */
  blocks(range?: DocRange): BlockData[];
  /**
   * Inline marks active over `range` (default: selection). A collapsed range (or
   * the bare caret) yields the formats that will apply to text typed there —
   * explicit toggled formats, or those inherited from the preceding character —
   * handy for lighting up a toolbar.
   */
  marks(range?: DocRange): Set<MarkName>;
}

/**
 * The public action/lifecycle surface implemented by {@link Editor} — the
 * contract owed to external consumers. Kept as a standalone interface so the
 * rich documentation lives in one place and the class is compile-checked
 * (`class Editor implements EditorApi`) against it.
 *
 * Organized by audience: the flat members here are the everyday
 * content/command surface; content reads live on the {@link QueryApi} `query`
 * facet (the mirror of {@link change}), geometry & decorations on the
 * {@link EditorViewApi} `view` facet, and chrome-building plumbing on the
 * {@link EditorHostApi} `host` facet. Engine-internal doc↔editor wiring and
 * mount-only window plumbing live on the separate {@link EditorWiring}
 * interface, so neither appears in the type a consumer holds.
 */
export interface EditorApi {
  /**
   * The raw internal {@link EditorState} (escape hatch), or `null` before any
   * state exists. Prefer {@link state} for UI binding, the {@link query} facet
   * for content reads, and the {@link view} facet for geometry — reach for this
   * only when a needed read has no typed accessor.
   */
  getState: () => EditorState | null;
  /**
   * Read-only state snapshot for UI binding: `{ selection, activeMarks }`.
   * For the raw internal {@link EditorState} (escape hatch), use {@link getState}.
   */
  readonly state: EditorStateSnapshot;
  /** Content read facet (the mirror of {@link change}) — see {@link QueryApi}. */
  readonly query: QueryApi;
  /** Geometry & ephemeral-paint facet — see {@link EditorViewApi}. */
  readonly view: EditorViewApi;
  /** Chrome-lifecycle facet — see {@link EditorHostApi}. */
  readonly host: EditorHostApi;
  /**
   * Tear down the editor: cancel the render loop and remove every canvas/input/
   * window event listener. For an editor created via
   * `createEditor`, call `CypherEditor.destroy` instead — it supersedes this and
   * also tears down the mount.
   */
  destroy: () => void;
  /**
   * Set logical focus, keeping DOM focus on the input surface in lockstep so it
   * keeps receiving keystrokes/IME. Pass `shouldClearSelection` to drop the
   * selection. Fires `on("focus")`/`on("blur")` on an actual transition.
   */
  setFocus: (focused: boolean, shouldClearSelection?: boolean) => void;
  /**
   * Subscribe to state changes: the listener receives the full {@link
   * EditorState} after each render-loop diff and on direct notifications (focus,
   * mode, undo…). Returns an unsubscribe function. For a filtered, self-
   * describing alternative see {@link on}.
   */
  subscribe: (listener: (state: EditorState) => void) => () => void;
  /**
   * Convenience event subscription — a thin, self-describing filter over
   * {@link Editor.subscribe} (see {@link EditorEvent}). Returns an unsubscribe
   * function. The `"change"` listener receives a {@link ChangeTransaction}
   * (`{ isRemote, ops }`); the others receive the {@link EditorState}.
   */
  on(event: "change", callback: (tx: ChangeTransaction) => void): () => void;
  on(
    event: "selectionchange" | "focus" | "blur",
    callback: (state: EditorState) => void,
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
  change: (fn: (c: ChangeApi) => void) => boolean;
  /** Dry-run a {@link change}: would the queued mutations change anything now? */
  canChange: (fn: (c: ChangeApi) => void) => boolean;
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
 * (reachable as `EditorClass` from `@cypherkit/editor/internal`) carries them
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
export class Editor implements EditorApi, EditorWiring {
  // ── Canvas / input surface ────────────────────────────────────────────────
  private readonly contentCtx: CanvasRenderingContext2D;
  private readonly cursorCtx: CanvasRenderingContext2D;
  private readonly contentCanvas: HTMLCanvasElement;
  private readonly hiddenInput?: HTMLElement;

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
  private documentHeight = 0;
  private visibility = { start: 0, end: 0 };
  private isRendering = false;

  // Broadcast function for sending operations to peers
  private broadcastFn: ((ops: Operation[]) => void) | null = null;

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

  private lastCursorBlinkState = false; // Track cursor blink state changes

  private readonly eventsQueue: Event[] = [];
  private readonly listeners: ((state: EditorState) => void)[] = [];

  // Store clipboard data separately since it gets detached after the event handler
  private pendingClipboardData: {
    html: string;
    text: string;
    imageFile: File | null;
  } | null = null;

  // ── Accessible input-surface mirror (per-instance) ──────────────────────────
  // `hiddenInput` is a contenteditable surface that always holds either the
  // current selection's text (so native copy/cut and screen readers see real
  // content) or a single sentinel char with the caret placed AFTER it. The
  // trailing-character caret is what keeps Android GBoard emitting
  // `deleteContentBackward` on backspace (the old <input> used value=" ").
  // NBSP is used because a plain space can be collapsed/trimmed in a
  // contenteditable. All programmatic DOM mutation is wrapped in
  // `isMirrorUpdating` so the resulting input/selection events aren't mistaken
  // for user edits, and `lastSelectionSig` avoids recomputing the (potentially
  // large) selection text on every render frame.
  private readonly SENTINEL = " "; // NBSP (stable in contenteditable; a plain space can be trimmed)
  private isMirrorUpdating = false;
  private lastSelectionSig: string | null = null;

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
    },
  ) {
    // Extract contexts from layers
    this.contentCtx = layers.content.ctx;
    this.cursorCtx = layers.cursor.ctx;
    this.contentCanvas = layers.content.canvas;
    this.hiddenInput = hiddenInput;

    this.schemaActions = config?.actions ?? {};
    this.schemaShortcuts = config?.shortcuts ?? {};

    this._state = initialState;
    this.viewport = viewportProp;

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
      // Don't focus input in readonly mode (prevents keyboard from opening)
      if (this.hiddenInput && !this._state.ui.isReadonlyBase) {
        try {
          this.hiddenInput.focus({ preventScroll: true });
        } catch {
          // Ignore
        }
      }
    };
    if (!isTouchDevice()) {
      this.contentCanvas.addEventListener("mousedown", this.canvasClickHandler);

      this.contentCanvas.addEventListener("contextmenu", this.eventsHandler);
      this.contentCanvas.addEventListener("mousedown", this.eventsHandler);
      this.contentCanvas.addEventListener("mousemove", this.eventsHandler);
      this.contentCanvas.addEventListener("mouseup", this.eventsHandler);
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

    // Set up input-surface handlers (keyboard, mobile, IME, clipboard).
    if (this.hiddenInput) {
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
      this.scheduleRender();
    });
  }

  // Change-event funnel: notify "change" listeners with a ChangeTransaction.
  private emitChange = (ops: readonly Operation[], isRemote: boolean): void => {
    if (ops.length === 0 || this.changeListeners.length === 0) return;
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
  ) => {
    // Only update cursor on desktop (not touch devices)
    if (isTouchDevice()) {
      return;
    }

    if (isDragging) {
      // When dragging scrollbar, use grabbing cursor
      this.contentCanvas.style.cursor = "grabbing";
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

  // Render a single frame synchronously
  private renderFrame = async () => {
    if (this.isRendering) return;
    this.isRendering = true;

    try {
      // Check if page changed since last render (handles remote ops that bypass handleEvents)
      if (this.lastRenderedPageRef !== this._state.document.page) {
        this._state.view.visibleBlocks = getVisibleBlocks(
          this._state.document.page,
        );
        this.dirtyLayers.content = true;
        this.dirtyLayers.cursor = true;
        this.documentHeightDirty = true;
        this.lastRenderedPageRef = this._state.document.page;
      }

      // Update cached rect only when needed (avoids expensive getBoundingClientRect every frame)
      if (this.rectNeedsUpdate) {
        this.updateCachedRect();
      }

      const prevState = this._state;

      // Handle events to get state and operations
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
      );

      // Update state with the result from events
      this._state = handleEventsResult.state;

      // Record operations to undo stack (only if not from undo/redo)
      // Undo/redo already updates undoManager internally, so check if it changed
      if (handleEventsResult.ops.length > 0) {
        const undoManagerChanged =
          prevState.undoManager !== this._state.undoManager;
        if (!undoManagerChanged) {
          // Regular operation - record to undo stack (pass both before/after states for cursor restoration)
          this._state = recordUndoOps(
            prevState,
            this._state,
            handleEventsResult.ops,
            this._state.CRDTbinding.getPeerId(),
          );
        }
        // Broadcast ops to peers
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

      // Check if state changed or if there are events that require rendering
      const stateChanged = prevState !== this._state;

      // Determine what changed to decide which layers to update
      if (stateChanged) {
        // Check if page content changed (requires content layer update)
        if (prevState.document.page !== this._state.document.page) {
          this._state.view.visibleBlocks = getVisibleBlocks(
            this._state.document.page,
          ); // ADD HERE
          this.dirtyLayers.content = true;
          this.dirtyLayers.cursor = true; // Cursor position may have changed
          this.documentHeightDirty = true; // Blocks changed, need to recalculate height
        }

        // Check if selection changed (requires content layer update)
        if (prevState.document.selection !== this._state.document.selection) {
          this.dirtyLayers.content = true;
        }

        // Check if cursor position changed (requires cursor layer update)
        if (
          prevState.document.cursor?.position !==
          this._state.document.cursor?.position
        ) {
          this.dirtyLayers.cursor = true;
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
      const currentCursorBlinkState = this._state.document.cursor
        ? isCursorBlinking(
            this._state.document.cursor,
            getEditorStyles(this._state),
          )
        : false;
      const cursorBlinkChanged =
        this.lastCursorBlinkState !== currentCursorBlinkState;
      this.lastCursorBlinkState = currentCursorBlinkState;

      // Cursor blink only affects cursor layer
      if (cursorBlinkChanged) {
        this.dirtyLayers.cursor = true;
      }

      // Render dirty layers
      const needsAnyRender =
        this.dirtyLayers.content || this.dirtyLayers.cursor;

      if (needsAnyRender) {
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
            this.viewport = { ...this.viewport, scrollY: maxScroll };
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
          );

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
          );

          this.dirtyLayers.content = false;
        }

        // Render cursor layer if dirty (very cheap!)
        if (this.dirtyLayers.cursor) {
          renderCursorLayer(
            this.cursorCtx,
            this.session,
            this._state,
            this.viewport,
            getEditorStyles(this._state),
          );
          this.dirtyLayers.cursor = false;
        }

        // Update hidden input position to match cursor for IME composition toolbar
        if (
          this.hiddenInput &&
          this._state.document.cursor &&
          this._state.view.isFocused
        ) {
          const cursorCoords = getCursorCoordinatesWithComposition(
            this._state,
            this.viewport,
          );
          if (cursorCoords) {
            this.hiddenInput.style.left = `${cursorCoords.x}px`;
            this.hiddenInput.style.top = `${
              cursorCoords.y - this.viewport.scrollY + cursorCoords.height
            }px`;
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
    if (
      this._state &&
      (this._state.view.scrollbar.isDragging ||
        this._state.ui.mode === "select")
    ) {
      this.eventsQueue.push(e);
    }
  };

  // Handle touchstart - track for tap detection
  private touchStartHandler = (e: TouchEvent) => {
    // Store touch start info for tap detection
    if (e.touches.length > 0) {
      this.touchStartY = e.touches[0].clientY;
      this.touchStartTime = Date.now();
      this.touchHasMoved = false;
    }

    // Process the touch event normally (for scrolling, etc.)
    this.eventsHandler(e);
  };

  // Handle touchend - focus input if it was a tap (not a scroll)
  private touchEndHandler = (e: TouchEvent) => {
    // Check if we're ending a long press selection BEFORE processing the event
    // This allows us to focus the input synchronously with the user gesture
    const wasLongPress = isInLongPressMode(this.session);

    // Process the touch event first
    this.eventsHandler(e);

    // Check if this was a tap (not a scroll/drag)
    const touchDuration = Date.now() - this.touchStartTime;
    const wasTap =
      !this.touchHasMoved && touchDuration < this.TAP_TIME_THRESHOLD;

    // Don't focus input if a context menu just opened (it would close the menu)
    const hasContextMenu = this.session.hostMenuCapturing;

    // Focus input if ending long press or on tap (but not when context menu is open or in readonly mode)
    if (
      this.hiddenInput &&
      isTouchDevice() &&
      (wasLongPress || wasTap) &&
      !hasContextMenu &&
      !this._state.ui.isReadonlyBase
    ) {
      try {
        this.hiddenInput.focus({ preventScroll: true });
        // Some browsers need click as well
        if (document.activeElement !== this.hiddenInput) {
          const prevPointerEvents = this.hiddenInput.style.pointerEvents;
          this.hiddenInput.style.pointerEvents = "auto";
          this.hiddenInput.focus({ preventScroll: true });
          this.hiddenInput.click();
          this.hiddenInput.style.pointerEvents = prevPointerEvents;
        }
      } catch (err) {
        console.warn("Failed to focus hidden input:", err);
      }
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

  // Restore the single-sentinel-char state with the caret AFTER it (keeps
  // Android emitting deleteContentBackward). Called after every input/compose.
  private resetSentinel = () => {
    this.setMirror(this.SENTINEL, false);
  };

  // Cheap signature of the current selection/caret, to avoid recomputing the
  // (potentially large) selection text on every render frame.
  private selectionSignature = (s: EditorState): string => {
    const sel = s.document.selection;
    if (sel && !sel.isCollapsed) {
      return `sel:${sel.anchor.blockIndex}:${sel.anchor.textIndex}-${sel.focus.blockIndex}:${sel.focus.textIndex}`;
    }
    const c = s.document.cursor;
    return c
      ? `caret:${c.position.blockIndex}:${c.position.textIndex}`
      : "none";
  };

  // Keep the surface in sync with the model selection: hold the selection's
  // plain text (selected, so copy/AT see it) or fall back to the sentinel.
  // Skipped during IME composition (the browser owns the content then).
  private syncMirrorToSelection = () => {
    if (!this.hiddenInput) return;
    const sig = this.selectionSignature(this._state);
    if (sig === this.lastSelectionSig) return;
    this.lastSelectionSig = sig;
    const sel = this._state.document.selection;
    if (sel && !sel.isCollapsed) {
      const text = getSelectionPlainText(this._state);
      if (text) {
        this.setMirror(text, true);
        return;
      }
    }
    // No selection: (re)place the sentinel + caret. Runs only when the
    // selection signature changes (cheap), and re-anchors the caret after the
    // sentinel on focus and after every caret move so Android keeps emitting
    // deleteContentBackward.
    this.resetSentinel();
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
    // text/plain carries the markdown (formatted) variant: paste parses
    // text/plain as markdown, so writing markdown here round-trips formatting
    // even when text/html isn't used by the paste target.
    e.clipboardData.setData("text/plain", payload.markdown);
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
    // text/plain carries the markdown (formatted) variant — see copyHandler.
    e.clipboardData.setData("text/plain", payload.markdown);
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

  // Handle input from the contenteditable surface (mobile keyboard + desktop
  // character input flow through here as InputEvents).
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

    // Skip processing during IME composition - composition events will handle it
    if (inputEvent.inputType === "insertCompositionText") {
      // Don't process composition text here - let composition events handle it
      return;
    }

    // Block ALL input operations during composition (mobile keyboards)
    // The composition events will handle everything
    if (this._state.ui.composition?.isComposing) {
      return;
    }

    // Use inputEvent.data for precise text that was inserted (not entire input value)
    const insertedText = inputEvent.data;

    // Handle text input
    if (insertedText && inputEvent.inputType === "insertText") {
      // Process each character that was inserted
      for (const char of insertedText) {
        const keyEvent = new KeyboardEvent("keydown", {
          key: char,
          bubbles: true,
          cancelable: true,
        });
        this.eventsQueue.push(keyEvent);
      }
      this.scheduleRender();
      // Restore the sentinel (caret after a real char) so Android keeps firing
      // deleteContentBackward.
      this.resetSentinel();
      return;
    }

    // Handle special input types. Contenteditable favors `insertParagraph` for
    // Enter (vs. `insertLineBreak` on <input>), so accept both.
    if (
      inputEvent.inputType === "insertParagraph" ||
      inputEvent.inputType === "insertLineBreak"
    ) {
      const enterEvent = new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      });
      this.eventsQueue.push(enterEvent);
      this.scheduleRender();
      this.resetSentinel();
      return;
    }

    if (inputEvent.inputType === "deleteContentBackward") {
      const backspaceEvent = new KeyboardEvent("keydown", {
        key: "Backspace",
        bubbles: true,
        cancelable: true,
      });
      this.eventsQueue.push(backspaceEvent);
      this.scheduleRender();
      this.resetSentinel();
      return;
    }

    if (inputEvent.inputType === "deleteContentForward") {
      const deleteEvent = new KeyboardEvent("keydown", {
        key: "Delete",
        bubbles: true,
        cancelable: true,
      });
      this.eventsQueue.push(deleteEvent);
      this.scheduleRender();
      this.resetSentinel();
      return;
    }

    // Restore the sentinel for any other input types
    this.resetSentinel();
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
        this.syncMirrorToSelection();
        return;
      }

      // Save as Markdown - handle here (not in events queue) to preserve user gesture for download
      if (e.code === "KeyS") {
        e.preventDefault();
        e.stopPropagation();
        if (e.repeat) return;
        const markdown = serializeToMarkdown(this._state.document.page.blocks);
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

  getState = (): EditorState | null => {
    return this._state;
  };

  destroy = (): void => {
    this.destroyed = true;

    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
    }

    if (this.canvasClickHandler) {
      this.contentCanvas.removeEventListener("click", this.canvasClickHandler);
    }

    if (!isTouchDevice()) {
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

    // Clean up input-surface handlers
    if (this.hiddenInput) {
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
      })
    ) {
      patch = { ...patch, scrollY: this.viewport.scrollY };
    }

    this.viewport = { ...this.viewport, ...patch };

    // Invalidate cached bounding rect since viewport dimensions changed
    this.invalidateRectCache();

    // Clear block height cache if width changed (affects text wrapping)
    if (this.viewport.width !== oldWidth) {
      clearAllBlockCaches(this._state.document.page.blocks);
      this.documentHeightDirty = true; // Width change affects text wrapping and height
    }

    // Schedule render for viewport changes
    this.scheduleRender();
    this.renderFrame();
  };

  private calculateDocumentHeight = (): number => {
    // Calculate total document height based on all blocks
    const styles = getEditorStyles(this._state);
    const maxWidth = this.viewport.width - 2 * styles.canvas.paddingLeft;
    let totalHeight = styles.canvas.paddingTop;

    const visibleBlocks = this._state.view.visibleBlocks;
    for (let visibleIdx = 0; visibleIdx < visibleBlocks.length; visibleIdx++) {
      const block = visibleBlocks[visibleIdx];

      // Use getBlockHeight to leverage caching for performance
      const blockHeight = getBlockHeight(
        this._state.nodes,
        this._state.marks,
        block,
        maxWidth,
        styles,
        visibleIdx === 0,
      );
      totalHeight += blockHeight;
    }

    const documentHeight = totalHeight + styles.canvas.paddingBottom;
    this.viewport = { ...this.viewport, documentHeight };
    return documentHeight;
  };

  setFocus = (
    focused: boolean,
    shouldClearSelection: boolean = false,
  ): void => {
    const wasFocused = this._state.view.isFocused;
    this._state = updateFocus(this._state, focused);
    if (shouldClearSelection) {
      this._state = clearSelection(this._state);
    }
    // Keep DOM focus on the input surface in lockstep with logical focus. Since
    // keyboard input is no longer captured on `window`, the surface must own DOM
    // focus to receive keystrokes/IME. (The 'focus' event re-enters setFocus,
    // but the transition guard below makes that idempotent.)
    if (
      focused &&
      this.hiddenInput &&
      !this._state.ui.isReadonlyBase &&
      document.activeElement !== this.hiddenInput
    ) {
      try {
        this.hiddenInput.focus({ preventScroll: true });
      } catch {
        // Ignore — focus can throw if the element is detached mid-teardown.
      }
    }
    this.scheduleRender(); // Schedule render when focus changes
    // Focus is applied here, outside the render-frame diff, so the render loop
    // won't notify subscribers about it. Emit directly on an actual transition
    // — this is what makes editor.on("focus"/"blur") fire (and follows the same
    // direct-notify pattern as undo/selectAll/setMode).
    if (this._state.view.isFocused !== wasFocused) {
      const currentState = this._state;
      this.listeners.forEach((listener) => listener(currentState));
    }
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
    const coords = getCursorDocumentCoords(
      position,
      this._state,
      this.viewport,
      getEditorStyles(this._state),
    );
    if (!coords) return null;

    return {
      x: coords.x,
      y: coords.y - this.viewport.scrollY,
      height: coords.height,
    };
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

  subscribe = (listener: (state: EditorState) => void): (() => void) => {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index > -1) {
        this.listeners.splice(index, 1);
      }
    };
  };

  on: EditorApi["on"] = (
    event: EditorEvent,
    callback:
      | ((tx: ChangeTransaction) => void)
      | ((state: EditorState) => void),
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
    // by diffing the snapshot captured at subscription time on each notification.
    const cb = callback as (state: EditorState) => void;
    let prev = this._state;
    return this.subscribe((next) => {
      const pageChanged = prev.document.page !== next.document.page;
      const selectionChanged =
        prev.document.cursor?.position !== next.document.cursor?.position ||
        prev.document.selection !== next.document.selection;
      const focusGained = !prev.view.isFocused && next.view.isFocused;
      const focusLost = prev.view.isFocused && !next.view.isFocused;
      prev = next;

      switch (event) {
        case "selectionchange":
          if (selectionChanged && !pageChanged) cb(next);
          break;
        case "focus":
          if (focusGained) cb(next);
          break;
        case "blur":
          if (focusLost) cb(next);
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
    return serializeToMarkdown(this._state.document.page.blocks);
  };

  setMarkdown = (markdown: string): void => {
    // Replace the document by diffing current → parsed blocks and emitting CRDT
    // operations (delete the current blocks, insert the new ones). Reuses the
    // snapshot-restore path, so the replace is a single undoable step and is
    // broadcast to peers — not a silent state swap. loadPage always yields a
    // fresh Page (≥1 block), so empty input is handled safely; an identical
    // result produces no ops and is a no-op.
    this.restoreFromSnapshot(loadPage(markdown).blocks);
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
          apply((s) => deleteSelectedText(s));
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
      insertBlock: (block, at) => {
        apply(this.insertBlockAction(block, at));
        return c;
      },
      setBlock: (attrs, at) => {
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
    (
      block: Partial<Block> & { type: Block["type"] },
      at: DocPoint | undefined,
    ): StateAction =>
    (s) => {
      const blocks = s.document.page.blocks;
      // The anchor block to insert after. A "before" point inserts after the
      // anchor's predecessor; "after"/default inserts after the anchor itself.
      const anchor = resolvePoint(s, at ?? "caret");
      let afterBlockId: string | null;
      let insertAt: number;
      if (!anchor) {
        // Empty doc (or unresolved): insert at the end.
        afterBlockId = null;
        insertAt = blocks.length;
      } else if (
        typeof at === "object" &&
        "side" in at &&
        at.side === "before"
      ) {
        // Insert before the anchor → after its previous visible block.
        let prev = anchor.blockIndex - 1;
        while (prev >= 0 && blocks[prev].deleted) prev--;
        afterBlockId = prev >= 0 ? blocks[prev].id : null;
        insertAt = anchor.blockIndex;
      } else {
        afterBlockId = anchor.blockId;
        insertAt = anchor.blockIndex + 1;
      }

      const blockId = block.id ?? `b-${s.CRDTbinding.nextId()}`;
      const seeded = createDefaultBlock(block.type, blockId, afterBlockId);
      if (!seeded) return { state: s, ops: [] };

      // Caller-supplied own attrs beyond the structural fields become block_set.
      const reserved = new Set([
        "id",
        "type",
        "afterId",
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

      const newBlocks = [...blocks];
      newBlocks.splice(insertAt, 0, newBlock);

      const ops: Operation[] = [
        {
          op: "block_insert",
          id: s.CRDTbinding.nextId(),
          clock: s.CRDTbinding.getClock(),
          pageId: s.CRDTbinding.pageId,
          afterBlockId,
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
    (
      attrs: { type?: Block["type"] | "heading"; level?: number } & Record<
        string,
        unknown
      >,
      at: DocPoint | undefined,
    ): StateAction =>
    (s) => {
      const idx = resolveBlockIndex(s, at);
      if (idx < 0) return { state: s, ops: [] };

      // Pull `type` (and, for the "heading" sugar, `level`) out of the attr bag.
      const rest: Record<string, unknown> = { ...attrs };
      const rawType = rest.type as Block["type"] | "heading" | undefined;
      delete rest.type;
      let resolvedType: Block["type"] | undefined;
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
      if (resolvedType !== undefined) {
        const caretIdx = s.document.cursor?.position.blockIndex;
        const r =
          idx === caretIdx
            ? convertBlockAtCursor(state, { type: resolvedType })
            : this.setBlockTypeAction(idx, resolvedType)(state);
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
    (blockIndex: number, type: Block["type"]): StateAction =>
    (s) => {
      const blocks = s.document.page.blocks;
      const block = blocks[blockIndex];
      if (!block || block.deleted) return { state: s, ops: [] };

      const defaults = createDefaultBlock(
        type,
        block.id,
        block.afterId ?? null,
      );
      if (!defaults) return { state: s, ops: [] };
      // Carry the source text/marks over only when both sides are textual;
      // otherwise the target type's defaults stand (a void block has no text).
      let newBlock: Block = defaults;
      if (isTextualBlock(defaults) && isTextualBlock(block)) {
        newBlock = {
          ...defaults,
          charRuns: block.charRuns,
          formats: canHaveFormats(type) ? block.formats : [],
        };
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
      for (const field of getBlockFieldNames(type)) {
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
        `[@cypherkit/editor] shortcut referenced unknown action name ${JSON.stringify(
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
  private presentBlock = (node: BlockData): BlockData => {
    const m = /^heading([1-3])$/.exec(node.type);
    if (!m) return node;
    return {
      ...node,
      type: "heading",
      attrs: { ...node.attrs, level: Number(m[1]) },
    };
  };

  private queryBlock = (at?: DocPoint): BlockData | null => {
    const idx = resolveBlockIndex(this._state, at);
    if (idx < 0) return null;
    return this.presentBlock(
      toBlockData(this._state.document.page.blocks[idx]),
    );
  };

  private queryBlocks = (range?: DocRange): BlockData[] => {
    const span = resolveBlockSpan(this._state, range);
    if (!span) return [];
    const blocks = this._state.document.page.blocks;
    const result: BlockData[] = [];
    for (let i = span.startIndex; i <= span.endIndex; i++) {
      const b = blocks[i];
      if (b && !b.deleted) result.push(this.presentBlock(toBlockData(b)));
    }
    return result;
  };

  private queryMarks = (range?: DocRange): Set<MarkName> =>
    docMarks(this._state, range);

  copy = async (
    docRange?: DocRange | null,
    selectRange?: boolean,
  ): Promise<boolean> => {
    // `docRange` resolves to a working state whose selection is the requested
    // range; without it, copy the live selection. Copy is non-destructive, so
    // the live selection only moves when `selectRange` is set.
    const working =
      docRange != null ? selectTarget(this._state, docRange) : this._state;
    const success = await copySelectionToClipboard(working);
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
    const result = await cutSelectionToClipboard(working);
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
    const result = await pasteFromSystemClipboard(this._state);
    if (result) {
      this.executeAction(result);
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
    this.scheduleRender();
    this.listeners.forEach((listener) => listener(result.state));
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
    this.scheduleRender();
    this.listeners.forEach((listener) => listener(result.state));
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
      const blocks = s.document.page.blocks;
      const blockIndex = blocks.findIndex((b) => b.id === blockId);
      const block = blocks[blockIndex];
      if (!block || block.deleted || !isTextualBlock(block))
        return { state: s, ops: [] };
      if (end <= start) return { state: s, ops: [] };

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
      const blockIndex = blocks.findIndex((b) => b.id === blockId);
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
      const ops: Operation[] = entries.map(
        ([field, value]): Operation => ({
          op: "block_set",
          id: s.CRDTbinding.nextId(),
          clock: s.CRDTbinding.getClock(),
          pageId: s.CRDTbinding.pageId,
          blockId,
          field,
          value,
        }),
      );

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
      const blockIndex = blocks.findIndex((b) => b.id === blockId);
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
        newBlocks.push({
          id: newParagraphBlockId,
          type: "paragraph",
          charRuns: [],
          formats: [],
        });
        ops.push({
          op: "block_insert",
          id: s.CRDTbinding.nextId(),
          clock: s.CRDTbinding.getClock(),
          pageId: s.CRDTbinding.pageId,
          afterBlockId: null,
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
      const blockIndex = blocks.findIndex((b) => b.id === blockId);
      const block = blocks[blockIndex];
      if (!block || block.deleted || !isTextualBlock(block))
        return { state: s, ops: [] };
      // An empty replacement is a deletion of the range.
      if (text.length === 0)
        return this.deleteInlineRangeAction(blockId, start, end)(s);

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
      const blockIndex = blocks.findIndex((b) => b.id === blockId);
      const block = blocks[blockIndex];
      if (!block || block.deleted || !isTextualBlock(block))
        return { state: s, ops: [] };
      if (end <= start) return { state: s, ops: [] };

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
    const visibleBlocks = getVisibleBlocks(page);
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
    });

    if (ops.length === 0) return;

    // Apply operations to local state
    const newPage = applyOps(currentPage, ops);

    // Clear all block caches
    clearAllBlockCaches(newPage.blocks);

    // Update visibleBlocks from the new page so cursor targets a valid block
    this._state.view.visibleBlocks = getVisibleBlocks(newPage);
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

    // Mark document height as dirty and reset scroll to top
    this.documentHeightDirty = true;
    this.viewport = { ...this.viewport, scrollY: 0 };

    // Re-render and notify listeners
    const currentState = this._state;
    this.scheduleRender();
    this.listeners.forEach((listener) => listener(currentState));
  };

  setBroadcast = (fn: ((ops: Operation[]) => void) | null): void => {
    this.broadcastFn = fn;
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
    this.scheduleRender();
  };

  get state(): EditorStateSnapshot {
    return {
      selection: {
        empty:
          !this._state.document.selection ||
          this._state.document.selection.isCollapsed,
        range: docSelection(this._state),
      },
      activeMarks: this.queryMarks(),
      activeBlockType: this.queryBlock()?.type ?? null,
      canUndo: canUndoState(this._state),
      canRedo: canRedoState(this._state),
      isFocused: this._state.view.isFocused,
    };
  }

  collectOverlays = (): NodeOverlay[] =>
    collectOverlays(this._state, this.viewport, getEditorStyles(this._state));

  getScrollY = (): number => this.viewport.scrollY;

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

  scrollToPosition = (point: DocPoint): void => {
    const resolved = resolvePoint(this._state, point);
    if (!resolved) return;
    const newScrollY = scrollToMakeCursorVisible(
      { blockIndex: resolved.blockIndex, textIndex: resolved.offset },
      this._state,
      this.viewport,
    );
    if (newScrollY !== null) {
      this.viewport = { ...this.viewport, scrollY: newScrollY };
      this.scheduleRender();
    }
  };

  // ── Public facets ──────────────────────────────────────────────────────────
  // `view` / `host` bundle the geometry and chrome members off the flat root
  // (see EditorViewApi / EditorHostApi). The implementations stay as the
  // instance arrow-fields above — already `this`-bound, so referencing them here
  // is safe; engine-internal callers (mountEditor, createEditor) use the
  // flat fields directly. Declared last so every referenced field is initialized
  // by the time these initializers run.
  query: QueryApi = {
    block: this.queryBlock,
    blocks: this.queryBlocks,
    marks: this.queryMarks,
  };

  view: EditorViewApi = {
    coordsAtPos: this.coordsAtPos,
    updateViewport: this.updateViewport,
    getScrollY: this.getScrollY,
    scrollToPosition: this.scrollToPosition,
    setDecorations: this.setDecorations,
    clearDecorations: this.clearDecorations,
  };

  host: EditorHostApi = {
    setMode: this.setMode,
    collectOverlays: this.collectOverlays,
    openOverlay: this.openOverlay,
    setNodeViewState: this.setNodeViewState,
    closeActiveMenu: this.closeActiveMenu,
    restoreFromSnapshot: this.restoreFromSnapshot,
  };
}
