import {
  buildClipboardPayload,
  copySelectionToClipboard,
  cutSelectionToClipboard,
  getSelectionPlainText,
  pasteFromSystemClipboard,
} from "../actions/clipboard";
import {
  applySlashCommand,
  clearLinkInBlock,
  convertBlockType,
  deleteSelectedText,
  getFormatsAtPosition,
  getSelectionRange,
  insertText,
  selectAll,
  toggleFormat,
  updateLinkInBlock,
} from "../actions/commands";
import {
  type Command,
  type CommandHandler,
  DEFAULT_COMMAND_PRIORITY,
  type DispatchArgs,
  OPEN_LINK,
} from "../command-bus";
import { createChromeRegionRegistry } from "../events/chromeRegions";
import { handleEvents } from "../events/events";
import {
  createInteractionSession,
  isInLongPressMode,
} from "../events/interaction-session";
import { onFontsReady } from "../fonts";
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
import {
  moveCursorLeft,
  moveCursorRight,
  moveCursorToPosition,
} from "../selection";
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
  ActiveMenu,
  CommandResult,
  EditorState,
  EditorTheme,
  NodeOverlay,
  SlashCommand,
  ViewportState,
} from "../state-types";
import type { Operation } from "../state-types";
import {
  closeActiveMenu,
  closeContextMenu,
  createInitialCursorState,
  getBlockTextContent,
  isTouchDevice,
  setActiveMenu,
  updateMode,
  updateWindowFocused,
} from "../state-utils";
import {
  getEditorStyles,
  mergeTheme,
  resolveNodeStrings,
  resolveTheme,
} from "../styles";
import type {
  AwarenessCursor,
  AwarenessSelection,
  AwarenessState,
  AwarenessUser,
} from "../sync/awareness";
import {
  awarenessCursorsEqual,
  awarenessSelectionsEqual,
  positionToAwarenessCursor,
  selectionToAwarenessSelection,
} from "../sync/awareness";
import { isTextualBlock } from "../sync/block-registry";
import { recordUndoOps, redoState, undoState } from "../sync/crdt-undo";
import {
  deleteCharsInRange,
  insertCharsAtPosition,
  markCharsInRange,
} from "../sync/crdt-utils";
import { applyOps } from "../sync/reducer";
import { generateRestoreOperations } from "../sync/snapshot-diff";
import { getVisibleBlocks } from "../sync/sync";
import type { CanvasLayers } from "./layers";

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
 * An inline mark name accepted by {@link EditorCommands.toggleMark} — any mark
 * type registered on the editor's schema whose {@link Mark.togglable} is true
 * (the built-ins `strong`/`emphasis`/`strike`/`code`, plus any custom toggle
 * marks a host registers). `link` and `math` are valid mark types but are
 * `togglable: false` — they carry data (a url / LaTeX) and are applied through
 * their own commands, so `toggleMark` is a no-op for them.
 *
 * Typed as `string` rather than a closed union so custom marks are accepted;
 * the name is validated against the schema at call time.
 */
export type MarkName = string;

/**
 * Imperative command namespace (see {@link Editor.commands}). Each command
 * applies immediately as its own undoable step and returns whether it changed
 * the document/selection. Group several into one step with {@link Editor.chain}.
 */
export interface EditorCommands {
  /** Toggle an inline mark across the selection (or the pending caret format). */
  toggleMark: (name: MarkName) => boolean;
  /** Convert the current block to a textual block type (paragraph/heading/list). */
  setBlock: (
    type: Block["type"] | "heading",
    attrs?: { level?: number },
  ) => boolean;
  /** Insert text at the caret, replacing any selection. */
  insertText: (text: string) => boolean;
  /** Select the whole document. */
  selectAll: () => boolean;
  /** Step local history backward / forward. */
  undo: () => boolean;
  redo: () => boolean;
}

/**
 * A batch of commands committed together as a single undoable step (see
 * {@link Editor.chain}). Builder methods are chainable; `run()` commits the
 * batch (one undo entry, one broadcast), `canRun()` dry-runs it.
 */
export interface EditorCommandChain {
  toggleMark: (name: MarkName) => EditorCommandChain;
  setBlock: (
    type: Block["type"] | "heading",
    attrs?: { level?: number },
  ) => EditorCommandChain;
  insertText: (text: string) => EditorCommandChain;
  selectAll: () => EditorCommandChain;
  /** Commit every queued command as one undoable step; returns whether anything changed. */
  run: () => boolean;
  /** Dry-run: would the queued commands change anything right now? */
  canRun: () => boolean;
}

/**
 * Read-only snapshot of editor state for UI binding (see {@link Editor.state}).
 * A fresh value is built on each read and is never mutated, so it's safe to
 * destructure and hold for the duration of one read.
 */
export interface EditorStateSnapshot {
  /** The current selection. `empty` is true for a bare caret (or no caret). */
  readonly selection: { readonly empty: boolean };
  /** Inline marks active at the caret / across the selection. */
  readonly activeMarks: ReadonlySet<Mark["type"]>;
}

/**
 * The public command/lifecycle surface implemented by {@link Editor}. Kept as a
 * standalone interface so the rich documentation lives in one place and the
 * class is compile-checked (`class Editor implements EditorApi`) against it.
 */
export interface EditorApi {
  /**
   * The raw internal {@link EditorState} (escape hatch), or `null` before any
   * state exists. Prefer {@link state} for UI binding.
   */
  getState: () => EditorState | null;
  /**
   * Read-only state snapshot for UI binding: `{ selection, activeMarks }`.
   * For the raw internal {@link EditorState} (escape hatch), use {@link getState}.
   */
  readonly state: EditorStateSnapshot;
  /**
   * Tear down the editor: cancel the render loop, remove every canvas/input/
   * window event listener, and clear awareness timers. For an editor created via
   * `createEditor`, call `CypherEditor.destroy` instead — it supersedes this and
   * also tears down the mount.
   */
  destroy: () => void;
  /**
   * Merge a partial viewport patch (e.g. width/height on a container resize) and
   * re-render. A width change clears cached block layout, since it affects text
   * wrapping and document height.
   */
  updateViewport: (viewport: Partial<ViewportState>) => void;
  /**
   * Set logical focus, keeping DOM focus on the input surface in lockstep so it
   * keeps receiving keystrokes/IME. Pass `shouldClearSelection` to drop the
   * selection. Fires `on("focus")`/`on("blur")` on an actual transition.
   */
  setFocus: (focused: boolean, shouldClearSelection?: boolean) => void;
  /**
   * Place the caret at the document start if there is no cursor yet — a no-op
   * otherwise, or when the document has no visible blocks.
   */
  setInitialCursor: () => void;
  /** Place the caret at the document start or end (forces a new caret). */
  setCaret: (at: "start" | "end") => void;
  /** Update browser-window focus (affects selection color); re-renders. */
  setWindowFocused: (focused: boolean) => void;
  /**
   * The caret's position in viewport (screen) coordinates — `{ x, y, height }`
   * with scroll applied — or `null` when there is no caret or it isn't laid out.
   * Use to anchor a host overlay (IME, autocomplete) to the caret.
   */
  getCursorScreenPosition: () => {
    x: number;
    y: number;
    height: number;
  } | null;
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
   * Register a handler for a command (see `defineCommand`). Higher `priority`
   * runs first (default `0`, above the editor's built-in defaults). Return
   * `true` to handle the command and stop propagation — skipping the default —
   * or `false`/`void` to observe and pass through. Returns an unsubscribe fn.
   */
  registerCommand<P>(
    command: Command<P>,
    handler: CommandHandler<P>,
    priority?: number,
  ): () => void;
  /**
   * Dispatch a command through this editor's bus; returns whether a handler
   * claimed it (see {@link Editor.registerCommand}).
   */
  dispatch<P>(command: Command<P>, ...args: DispatchArgs<P>): boolean;
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
   * Imperative command namespace — each command applies immediately as its own
   * undoable step and returns whether it changed anything.
   */
  commands: EditorCommands;
  /** Begin a chain of commands committed together as a single undoable step. */
  chain: () => EditorCommandChain;
  /**
   * The inline formats that will apply to text typed at the caret — explicit
   * toggled formats, or those inherited from the character before it. Handy for
   * lighting up a toolbar.
   */
  getActiveMarks: () => Set<Mark["type"]>;
  /** True when there is no selection (just a caret, or nothing). */
  isSelectionEmpty: () => boolean;
  /**
   * Run the given slash command against the open slash-command menu, applying
   * its result as one undoable step. No-op unless the slash menu is open with a
   * live cursor.
   */
  executeSlashCommand: (command: SlashCommand) => void;
  /**
   * Copy the current selection to the system clipboard and close any open
   * context menu. Resolves to whether the copy succeeded.
   */
  copy: () => Promise<boolean>;
  /**
   * Cut the current selection to the system clipboard (one undoable step) and
   * close any open context menu. Resolves to whether anything was cut.
   */
  cut: () => Promise<boolean>;
  /**
   * Paste from the system clipboard at the caret/selection (one undoable step)
   * and close any open context menu. Resolves to whether anything was pasted.
   */
  paste: () => Promise<boolean>;
  /**
   * Update the URL and text of an existing link spanning `[startIndex, endIndex)`
   * in the block at `blockIndex`. One undoable step; broadcast to peers.
   */
  updateLink: (
    blockIndex: number,
    startIndex: number,
    endIndex: number,
    newUrl: string,
    newText: string,
  ) => void;
  /**
   * Remove link formatting from the range `[startIndex, endIndex)` in the block
   * at `blockIndex`, leaving the text. One undoable step; broadcast to peers.
   */
  clearLink: (blockIndex: number, startIndex: number, endIndex: number) => void;
  /**
   * Replace the current selection with `text` formatted as a link to `url`,
   * placing the caret after it. Requires a non-collapsed, single-block selection
   * (otherwise a no-op). One undoable step; broadcast to peers.
   */
  createLink: (url: string, text: string) => void;
  /**
   * Clear both the selection and the caret — removing all selection/cursor
   * visuals — and notify subscribers.
   */
  clearSelection: () => void;
  /**
   * Switch the interaction mode: `edit` (normal), `select` (selection-only, e.g.
   * mobile), or `locked` (read-only; also halts scroll momentum). Notifies
   * subscribers.
   */
  setMode: (mode: "edit" | "select" | "locked") => void;
  /**
   * Restore a previously captured cursor and selection (and return to `edit`
   * mode) — e.g. after the host temporarily moved focus away. Notifies subscribers.
   */
  restoreCursorAndSelection: (
    cursor: EditorState["document"]["cursor"],
    selection: EditorState["document"]["selection"],
  ) => void;
  /**
   * Collect the node-declared overlay descriptors for the on-screen blocks
   * (see {@link NodeOverlay}). The host maps each `key` to a component and
   * mounts it at the descriptor's `rect`; recompute on state/scroll changes.
   * Empty unless a registered node implements `overlays()`.
   */
  collectOverlays: () => NodeOverlay[];
  /**
   * Update this instance's theme. The patch is deep-merged onto the current
   * theme (tokens/fonts/strings shallow-merged, `styles` deep-merged), re-
   * resolved into the full style tree, and the editor re-renders. Use for live
   * theme changes — e.g. a host driving colors from CSS variables on a
   * dark-mode toggle calls `setTheme({ tokens })`.
   */
  setTheme: (patch: EditorTheme) => void;
  /**
   * Set one or more attributes on a block, addressed by id. Each entry becomes
   * a `block_set` CRDT op; the field/value are validated against the block
   * type's schema when applied. Generic over block type — e.g. an image block's
   * `{ url, alt }` or a math block's `{ latex, displayMode }`. One undoable
   * step; broadcast to peers. Returns false if the block is missing/deleted.
   */
  setNodeAttrs: (blockId: string, attrs: Record<string, unknown>) => boolean;
  /**
   * Delete a block, addressed by id (tombstoned, so undo can restore it). If it
   * was the last visible block, an empty paragraph is inserted in its place.
   * One undoable step; broadcast to peers. Returns false if missing/deleted.
   */
  deleteNode: (blockId: string) => boolean;
  /**
   * Replace the inline text range `[start, end)` in a block with `text`,
   * optionally applying a single inline `mark` to the inserted run (e.g. the
   * `math` mark for an inline-math chip). Empty `text` deletes the range. One
   * undoable step; broadcast to peers. Returns false if the block isn't textual.
   */
  replaceInlineRange: (
    blockId: string,
    start: number,
    end: number,
    text: string,
    mark?: Mark,
  ) => boolean;
  /**
   * Delete the inline text range `[start, end)` in a block and place the caret
   * where it began. One undoable step; broadcast to peers. Returns false if the
   * block isn't textual or the range is empty.
   */
  deleteInlineRange: (blockId: string, start: number, end: number) => boolean;
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
    blockIndex: number;
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
  /** Close the inline-math edit popover and move the caret past the chip in the
   * given visual direction. Used when the user arrows out of the popover input. */
  exitInlineMath: (
    blockIndex: number,
    startIndex: number,
    endIndex: number,
    direction: "left" | "right",
  ) => void;
  /**
   * Close whichever menu/overlay is currently open (context menu, slash menu,
   * host overlay…) and notify subscribers.
   */
  closeActiveMenu: () => void;
  /**
   * Adopt a remotely-merged page (the doc→editor channel). Pass the merged
   * `remoteOps` so `on("change")` listeners fire with `isRemote: true` and the
   * applied ops.
   * @internal — wiring detail driven by an attached `Doc` (see `mountEditor`'s
   * `doc` option). Hosts apply remote ops via `doc.applyUpdate` and never call
   * this directly.
   */
  updatePageFromSync: (page: Page, remoteOps?: readonly Operation[]) => void;
  /** Restore from snapshot - generates and broadcasts operations */
  restoreFromSnapshot: (blocks: Block[]) => void;
  /**
   * Set the function that receives this editor's locally-produced ops.
   * @internal — wiring detail set by `mountEditor` to feed an attached `Doc`
   * (`doc._ingestLocal`). Hosts observe local ops via `doc.on("update")`, not
   * by installing a callback here.
   */
  setBroadcast: (fn: ((ops: Operation[]) => void) | null) => void;
  /** Set callback for broadcasting awareness state changes */
  setAwarenessBroadcast: (
    fn: ((state: AwarenessState) => void) | null,
    user?: AwarenessUser,
  ) => void;
  /** Update a remote peer's awareness state */
  setRemoteAwareness: (peerId: string, state: AwarenessState | null) => void;
  /** Get all remote awareness states */
  getRemoteAwareness: () => Map<string, AwarenessState>;
  /** Set callback for when an image file is pasted from clipboard */
  onImagePaste: (
    callback: ((file: File, blockIndex: number) => void) | null,
  ) => void;
  /** Set callback for scroll position changes */
  onScroll: (callback: ((scrollY: number) => void) | null) => void;
  /** Get current scroll position */
  getScrollY: () => number;
  /** Set search highlights for find-in-document */
  setSearchHighlights: (
    highlights: { blockIndex: number; startIndex: number; endIndex: number }[],
    activeIndex: number,
  ) => void;
  /** Clear all search highlights */
  clearSearchHighlights: () => void;
  /** Scroll viewport to make a position visible */
  scrollToPosition: (position: {
    blockIndex: number;
    textIndex: number;
  }) => void;
}

type AwarenessBroadcastFn = (state: AwarenessState) => void;

// A pure (state) => CommandResult transform. Named distinctly from the
// command-bus `Command` type (imported above), which is a different concept.
type StateCommand = (s: EditorState) => CommandResult;

/**
 * The canvas editor instance. Attaches the engine to a set of layered canvases
 * and (optionally) an accessible contenteditable input surface, runs the render
 * loop, and exposes the imperative command/lifecycle API ({@link EditorApi}).
 *
 * Every public member is an arrow-function field (bound to the instance) so the
 * surface survives being spread into a host handle (see `createEditor`). All
 * state is per-instance — no module-level globals — so multiple editors can
 * coexist on one page.
 */
export class Editor implements EditorApi {
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

  // Awareness state for remote peers
  private readonly remoteAwareness: Map<string, AwarenessState> = new Map();
  private awarenessBroadcastFn: AwarenessBroadcastFn | null = null;

  // Idle timeout for filtering inactive peers from UI (10 seconds)
  private readonly AWARENESS_IDLE_TIMEOUT = 10000;
  // Stale timeout for removing peers from memory (30 seconds)
  private readonly AWARENESS_STALE_TIMEOUT = 30000;
  // Cleanup interval for stale awareness states (runs every 10 seconds)
  private readonly awarenessCleanupInterval: ReturnType<typeof setInterval>;

  // Local user info for awareness
  private localUser: AwarenessUser | null = null;

  // Track last broadcast awareness state to avoid redundant broadcasts
  private lastBroadcastCursor: AwarenessCursor | null = null;
  private lastBroadcastSelection: AwarenessSelection | null = null;

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

  // Callback for when an image file is pasted (set by external code to handle async upload)
  private onImagePasteCallback:
    | ((file: File, blockIndex: number) => void)
    | null = null;

  // Callback for scroll position changes
  private onScrollCallback: ((scrollY: number) => void) | null = null;
  private lastReportedScrollY = 0;

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

  constructor(
    layers: CanvasLayers,
    initialState: EditorState,
    viewportProp: ViewportState,
    hiddenInput?: HTMLElement,
  ) {
    // Extract contexts from layers
    this.contentCtx = layers.content.ctx;
    this.cursorCtx = layers.cursor.ctx;
    this.contentCanvas = layers.content.canvas;
    this.hiddenInput = hiddenInput;

    this._state = initialState;
    this.viewport = viewportProp;

    // Built-in command defaults. These sit below any host handler (registered
    // via editor.registerCommand) on the bus, so a host can override them by
    // returning true — e.g. a native shell taking over OPEN_LINK. Observe-only
    // commands (haptics, gesture milestones) have no default and are dispatched
    // as-is.
    this._state.commandBus.register(
      OPEN_LINK,
      ({ url }) => {
        window.open(url, "_blank", "noopener,noreferrer");
        return true;
      },
      DEFAULT_COMMAND_PRIORITY,
    );

    this.awarenessCleanupInterval = setInterval(
      this.cleanupStaleAwareness,
      10000,
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

  /**
   * Get remote awareness states, filtering out idle peers.
   * Peers who haven't sent updates within AWARENESS_IDLE_TIMEOUT are excluded.
   */
  private getActiveRemoteAwareness = (): Map<string, AwarenessState> => {
    const now = Date.now();
    const active = new Map<string, AwarenessState>();

    for (const [peerId, state] of this.remoteAwareness) {
      if (now - state.lastUpdate <= this.AWARENESS_IDLE_TIMEOUT) {
        active.set(peerId, state);
      }
    }

    return active;
  };

  /**
   * Cleanup stale awareness states from memory.
   * Removes peers who haven't sent updates within AWARENESS_STALE_TIMEOUT.
   */
  private cleanupStaleAwareness = (): void => {
    const now = Date.now();
    let hasChanges = false;

    for (const [peerId, state] of this.remoteAwareness) {
      if (now - state.lastUpdate > this.AWARENESS_STALE_TIMEOUT) {
        this.remoteAwareness.delete(peerId);
        hasChanges = true;
      }
    }

    if (hasChanges) {
      this.scheduleRender();
    }
  };

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
   * Broadcast local awareness state (cursor/selection) to peers.
   * Called when cursor or selection changes.
   * Only broadcasts if the position has actually changed.
   */
  private broadcastAwareness = (): void => {
    if (!this.awarenessBroadcastFn || !this.localUser) return;

    const page = this._state.document.page;
    const cursor = this._state.document.cursor;
    const selection = this._state.document.selection;

    // Convert cursor to awareness cursor (uses block IDs for stability)
    const awarenessCursor = cursor
      ? positionToAwarenessCursor(cursor.position, page)
      : null;

    // Convert selection to awareness selection
    const awarenessSelection =
      selection && !selection.isCollapsed
        ? selectionToAwarenessSelection(selection, page)
        : null;

    // Skip broadcast if cursor and selection haven't changed
    if (
      awarenessCursorsEqual(awarenessCursor, this.lastBroadcastCursor) &&
      awarenessSelectionsEqual(awarenessSelection, this.lastBroadcastSelection)
    ) {
      return;
    }

    // Update last broadcast state
    this.lastBroadcastCursor = awarenessCursor;
    this.lastBroadcastSelection = awarenessSelection;

    const awarenessState: AwarenessState = {
      user: this.localUser,
      cursor: awarenessCursor,
      selection: awarenessSelection,
      lastUpdate: Date.now(),
    };

    this.awarenessBroadcastFn(awarenessState);
  };

  /**
   * Execute a command that returns { state, ops } and broadcast operations to peers.
   * This is the central point for all state-modifying operations.
   */
  private executeCommand = (result: CommandResult): void => {
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
      // Inline math chip / math block — both are clickable
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

      // Trigger image paste callback if an image file was pasted
      if (
        this.pendingClipboardData?.imageFile &&
        this.onImagePasteCallback &&
        handleEventsResult.pastedImageBlockIndex !== undefined
      ) {
        const file = this.pendingClipboardData.imageFile;
        const blockIndex = handleEventsResult.pastedImageBlockIndex;
        // Call async — don't block the render loop
        this.onImagePasteCallback(file, blockIndex);
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

        // Broadcast awareness when cursor or selection changes
        if (
          prevState.document.cursor?.position !==
            this._state.document.cursor?.position ||
          prevState.document.selection !== this._state.document.selection
        ) {
          this.broadcastAwareness();
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
            this.getActiveRemoteAwareness(),
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
            this._state.ui.inlineMathHover !== null ||
              this._state.ui.hoveredMathBlockIndex !== null,
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
            this.getActiveRemoteAwareness(),
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

        // Notify scroll callback if scrollY changed
        if (
          this.onScrollCallback &&
          this.viewport.scrollY !== this.lastReportedScrollY
        ) {
          this.lastReportedScrollY = this.viewport.scrollY;
          this.onScrollCallback(this.viewport.scrollY);
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
    const hasContextMenu = this._state.ui.activeMenu.type === "contextMenu";

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
    e.clipboardData.setData("text/plain", payload.plainText);
    e.clipboardData.setData("text/html", payload.html);
  };

  // Native cut: copy, then delete the selection through the command pipeline.
  private cutHandler = (e: ClipboardEvent) => {
    if (!this._state.view.isFocused) return;
    if (this._state.ui.mode === "readonly" || this._state.ui.mode === "locked")
      return;
    if (this._state.ui.composition?.isComposing) return;

    const payload = buildClipboardPayload(this._state);
    if (!payload || !e.clipboardData) return;
    e.preventDefault();
    e.clipboardData.setData("text/plain", payload.plainText);
    e.clipboardData.setData("text/html", payload.html);
    this.executeCommand(deleteSelectedText(this._state));
    this.resetSentinel();
  };

  // Native paste: stash the clipboard payload and queue the event so the
  // existing handlePaste flow (incl. the image-paste callback) runs in-frame.
  private pasteHandler = (e: ClipboardEvent) => {
    if (!this._state.view.isFocused) return;
    if (this._state.ui.mode === "readonly" || this._state.ui.mode === "locked")
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

    // Block input in readonly or locked mode
    if (
      this._state.ui.mode === "readonly" ||
      this._state.ui.mode === "locked"
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

    // In locked mode, block everything
    if (this._state.ui.mode === "locked") {
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

    // Clean up awareness cleanup interval
    clearInterval(this.awarenessCleanupInterval);
  };

  updateViewport = (newViewport: Partial<ViewportState>): void => {
    const oldWidth = this.viewport.width;

    this.viewport = { ...this.viewport, ...newViewport };

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

  setInitialCursor = (): void => {
    // Only set cursor if there isn't one already
    if (
      !this._state.document.cursor &&
      this._state.view.visibleBlocks.length > 0
    ) {
      this._state = createInitialCursorState(this._state);
      this.scheduleRender();
    }
  };

  // Force the caret to the document start or end (used by `focus(at)`).
  setCaret = (at: "start" | "end"): void => {
    const visible = this._state.view.visibleBlocks;
    if (visible.length === 0) return;
    const blocks = this._state.document.page.blocks;
    const target = at === "start" ? visible[0] : visible[visible.length - 1];
    const blockIndex = blocks.findIndex((b) => b.id === target.id);
    if (blockIndex === -1) return;
    const textIndex =
      at === "start" ? 0 : getBlockTextContent(blocks[blockIndex]).length;
    this._state = {
      ...this._state,
      document: {
        ...this._state.document,
        cursor: { position: { blockIndex, textIndex }, lastUpdate: Date.now() },
        selection: null,
      },
    };
    this.scheduleRender();
  };

  getCursorScreenPosition = (): {
    x: number;
    y: number;
    height: number;
  } | null => {
    if (!this._state.document.cursor) return null;

    const coords = getCursorDocumentCoords(
      this._state.document.cursor.position,
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
  registerCommand = <P>(
    command: Command<P>,
    handler: CommandHandler<P>,
    priority?: number,
  ): (() => void) => {
    return this._state.commandBus.register(command, handler, priority);
  };

  dispatch = <P>(command: Command<P>, ...args: DispatchArgs<P>): boolean => {
    return this._state.commandBus.dispatch(command, ...args);
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

  // ── Commands & chaining (Tier B) ────────────────────────────────────────
  // Every command is a pure (state) => CommandResult transform built on the
  // same action functions the keyboard/menu paths use. `commands.X` runs one
  // immediately (its own undo step, broadcast, notify, via executeCommand);
  // `chain()` threads state through several and commits them as ONE undo step.

  // toggleMark dispatch is registry-driven: any togglable mark on the schema
  // can be toggled by name (built-ins + custom). Marks that need extra input
  // (link → url, math → LaTeX) are `togglable: false` and ignored here.
  private toggleMarkCommand =
    (name: MarkName): StateCommand =>
    (s) =>
      toggleFormat(s, name);

  private canToggleMark = (name: MarkName): boolean =>
    this._state.marks.get(name)?.togglable === true;

  private blockCommand =
    (type: Block["type"]): StateCommand =>
    (s) =>
      convertBlockType(s, type);

  // setBlock accepts the concrete block types plus the convenience "heading",
  // mapped to heading1/2/3 by `attrs.level` (clamped 1–3, the levels that render).
  private resolveBlockType = (
    type: Block["type"] | "heading",
    attrs?: { level?: number },
  ): Block["type"] => {
    if (type === "heading") {
      const level = Math.min(3, Math.max(1, Math.round(attrs?.level ?? 1)));
      return `heading${level}` as Block["type"];
    }
    return type;
  };

  private insertTextCommand =
    (text: string): StateCommand =>
    (s) =>
      insertText(s, text);

  private selectAllCommand: StateCommand = (s) => ({
    state: selectAll(s),
    ops: [],
  });

  /** Run a single command immediately; returns whether it changed anything. */
  private runCommand = (cmd: StateCommand): boolean => {
    const prev = this._state;
    const result = cmd(prev);
    if (result.state === prev && result.ops.length === 0) return false;
    this.executeCommand(result);
    return true;
  };

  commands: EditorCommands = {
    toggleMark: (name) =>
      this.canToggleMark(name)
        ? this.runCommand(this.toggleMarkCommand(name))
        : false,
    setBlock: (type, attrs) =>
      this.runCommand(this.blockCommand(this.resolveBlockType(type, attrs))),
    insertText: (text) => this.runCommand(this.insertTextCommand(text)),
    selectAll: () => this.runCommand(this.selectAllCommand),
    undo: () => {
      const before = this._state;
      this.undo();
      return this._state !== before;
    },
    redo: () => {
      const before = this._state;
      this.redo();
      return this._state !== before;
    },
  };

  chain = (): EditorCommandChain => {
    const steps: StateCommand[] = [];
    // Apply queued steps to a working copy; commit (record ONE undo step,
    // broadcast once, notify) only when `commit` is true. canRun() passes false.
    const apply = (commit: boolean): boolean => {
      const prev = this._state;
      let cur = prev;
      const allOps: Operation[] = [];
      for (const step of steps) {
        const r = step(cur);
        cur = r.state;
        allOps.push(...r.ops);
      }
      const changed = cur !== prev || allOps.length > 0;
      if (!commit || !changed) return changed;
      this._state =
        allOps.length > 0
          ? recordUndoOps(
              prev,
              cur,
              allOps,
              this._state.CRDTbinding.getPeerId(),
            )
          : cur;
      if (allOps.length > 0 && this.broadcastFn) this.emitLocalOps(allOps);
      this.scheduleRender();
      const currentState = this._state;
      this.listeners.forEach((listener) => listener(currentState));
      return true;
    };
    const builder: EditorCommandChain = {
      toggleMark: (name) => {
        if (this.canToggleMark(name)) steps.push(this.toggleMarkCommand(name));
        return builder;
      },
      setBlock: (type, attrs) => {
        steps.push(this.blockCommand(this.resolveBlockType(type, attrs)));
        return builder;
      },
      insertText: (text) => {
        steps.push(this.insertTextCommand(text));
        return builder;
      },
      selectAll: () => {
        steps.push(this.selectAllCommand);
        return builder;
      },
      run: () => apply(true),
      canRun: () => apply(false),
    };
    return builder;
  };

  getActiveMarks = (): Set<Mark["type"]> => {
    const result = new Set<Mark["type"]>();
    const mode = this._state.ui.activeMarksMode;
    if (mode.type === "explicit") {
      for (const f of mode.formats) result.add(f.type);
      return result;
    }
    // "inherit" mode: reflect the formats on the character before the caret.
    const cursor = this._state.document.cursor;
    if (!cursor) return result;
    const block = this._state.document.page.blocks[cursor.position.blockIndex];
    if (!block || block.deleted) return result;
    const formats = getFormatsAtPosition(block, cursor.position.textIndex);
    if (formats) for (const f of formats) result.add(f.type);
    return result;
  };

  isSelectionEmpty = (): boolean => {
    const sel = this._state.document.selection;
    return !sel || sel.isCollapsed;
  };

  executeSlashCommand = (command: SlashCommand): void => {
    if (
      this._state.ui.activeMenu.type === "slashCommand" &&
      this._state.document.cursor
    ) {
      const result = applySlashCommand(this._state, command);
      this.executeCommand(result);
    }
  };

  copy = async (): Promise<boolean> => {
    const success = await copySelectionToClipboard(this._state);
    this._state = closeContextMenu(this._state);
    this.scheduleRender();
    return success;
  };

  cut = async (): Promise<boolean> => {
    const result = await cutSelectionToClipboard(this._state);
    if (result.success && result.result) {
      this.executeCommand(result.result);
      this._state = closeContextMenu(this._state);
      this.scheduleRender();
      return true;
    }
    this._state = closeContextMenu(this._state);
    this.scheduleRender();
    return false;
  };

  paste = async (): Promise<boolean> => {
    const result = await pasteFromSystemClipboard(this._state);
    if (result) {
      this.executeCommand(result);
      this._state = closeContextMenu(this._state);
      this.scheduleRender();
      return true;
    }
    this._state = closeContextMenu(this._state);
    this.scheduleRender();
    return false;
  };

  private undo = () => {
    const result = undoState(this._state);
    if (result.state !== this._state) {
      this._state = result.state;
      this.scheduleRender();
      this.listeners.forEach((listener) => listener(result.state));
      // Broadcast inverse operations to sync engine
      if (result.ops.length > 0 && this.broadcastFn) {
        this.emitLocalOps(result.ops);
      }
    }
  };

  private redo = () => {
    const result = redoState(this._state);
    if (result.state !== this._state) {
      this._state = result.state;
      this.scheduleRender();
      this.listeners.forEach((listener) => listener(result.state));
      // Broadcast redo operations to sync engine
      if (result.ops.length > 0 && this.broadcastFn) {
        this.emitLocalOps(result.ops);
      }
    }
  };

  updateLink = (
    blockIndex: number,
    startIndex: number,
    endIndex: number,
    newUrl: string,
    newText: string,
  ): void => {
    const result = updateLinkInBlock(
      this._state,
      blockIndex,
      startIndex,
      endIndex,
      newUrl,
      newText,
    );
    this.executeCommand(result);
  };

  clearLink = (
    blockIndex: number,
    startIndex: number,
    endIndex: number,
  ): void => {
    const result = clearLinkInBlock(
      this._state,
      blockIndex,
      startIndex,
      endIndex,
    );
    this.executeCommand(result);
  };

  createLink = (url: string, text: string): void => {
    if (
      !this._state.document.selection ||
      this._state.document.selection.isCollapsed
    ) {
      return; // Need a selection to create a link
    }

    const range = getSelectionRange(this._state);
    if (!range) return;

    const { start, end } = range;

    // Only support single-block link creation for now
    if (start.blockIndex !== end.blockIndex) {
      return;
    }

    const block = this._state.document.page.blocks[start.blockIndex];
    if (!block || block.deleted || !isTextualBlock(block)) {
      return;
    }

    const ops: Operation[] = [];

    // Delete the selected text first
    const { newPage: p1, op: deleteOp } = deleteCharsInRange(
      this._state.document.page,
      block.id,
      start.textIndex,
      end.textIndex,
      this._state.CRDTbinding,
    );
    ops.push(deleteOp);

    // Insert the new link text
    const { newPage: p2, op: insertOp } = insertCharsAtPosition(
      p1,
      block.id,
      start.textIndex,
      text,
      this._state.CRDTbinding,
    );
    ops.push(insertOp);

    // Apply link formatting to the inserted text
    const { newPage: p3, op: formatOp } = markCharsInRange(
      p2,
      block.id,
      start.textIndex,
      start.textIndex + text.length,
      { type: "link", attrs: { url } },
      true,
      this._state.CRDTbinding,
    );
    ops.push(formatOp);

    invalidateBlockCache(p3.blocks[start.blockIndex]);

    const newState = {
      ...this._state,
      document: { ...this._state.document, page: p3 },
    };

    // Clear selection and move cursor to end of inserted link
    const stateWithClearedSelection = clearSelection(newState);
    const finalState = moveCursorToPosition(
      stateWithClearedSelection,
      start.blockIndex,
      start.textIndex + text.length,
    );

    this.executeCommand({ state: finalState, ops });
  };

  clearSelection = (): void => {
    this._state = clearSelection(this._state);
    // Also clear cursor to remove all visual indicators
    this._state = updateCursor(this._state, null);
    const currentState = this._state;
    this.scheduleRender();
    this.listeners.forEach((listener) => listener(currentState));
  };

  setMode = (mode: "edit" | "select" | "locked"): void => {
    this._state = updateMode(this._state, mode);

    // Stop momentum when entering locked mode
    if (mode === "locked") {
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

  restoreCursorAndSelection = (
    cursor: EditorState["document"]["cursor"],
    selection: EditorState["document"]["selection"],
  ): void => {
    this._state = updateMode(
      updateSelection(
        updateCursor(this._state, cursor?.position || null),
        selection
          ? {
              anchor: selection.anchor,
              focus: selection.focus,
              initialBoundary: selection.initialBoundary || null,
            }
          : null,
      ),
      "edit",
    );
    const currentState = this._state;
    this.scheduleRender();
    this.listeners.forEach((listener) => listener(currentState));
  };

  setNodeAttrs = (blockId: string, attrs: Record<string, unknown>): boolean => {
    const blocks = this._state.document.page.blocks;
    const blockIndex = blocks.findIndex((b) => b.id === blockId);
    const block = blocks[blockIndex];
    if (!block || block.deleted) return false;

    const fields = Object.keys(attrs);
    if (fields.length === 0) return false;

    const updatedBlock = { ...block, ...attrs } as typeof block;
    // Layout caches are keyed by content; an attr change (image URL, math
    // latex, …) can change a block's measured height, so drop its cache.
    invalidateBlockCache(updatedBlock);

    const newBlocks = [...blocks];
    newBlocks[blockIndex] = updatedBlock;

    // Each attribute is a block_set op. The field/value are validated against
    // the block type's registered schema when the op is applied, so this stays
    // generic — the editor needs no per-block-type knowledge here.
    const ops: Operation[] = fields.map(
      (field): Operation => ({
        op: "block_set",
        id: this._state.CRDTbinding.nextId(),
        clock: this._state.CRDTbinding.getClock(),
        pageId: this._state.CRDTbinding.pageId,
        blockId,
        field,
        value: attrs[field],
      }),
    );

    this.executeCommand({
      state: {
        ...this._state,
        document: {
          ...this._state.document,
          page: { ...this._state.document.page, blocks: newBlocks },
        },
      },
      ops,
    });
    return true;
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

  deleteNode = (blockId: string): boolean => {
    const blocks = this._state.document.page.blocks;
    const blockIndex = blocks.findIndex((b) => b.id === blockId);
    const block = blocks[blockIndex];
    if (!block || block.deleted) return false;

    // Tombstone the block (mark deleted) instead of splicing it out, so undo
    // can locate it in state to compute the inverse block_insert.
    const newBlocks = [...blocks];
    newBlocks[blockIndex] = { ...block, deleted: true };

    const ops: Operation[] = [
      {
        op: "block_delete",
        id: this._state.CRDTbinding.nextId(),
        clock: this._state.CRDTbinding.getClock(),
        pageId: this._state.CRDTbinding.pageId,
        blockId,
      },
    ];

    // If that was the last visible block, keep the document editable by
    // inserting an empty paragraph in its place.
    const visibleCount = newBlocks.filter((b) => !b.deleted).length;
    if (visibleCount === 0) {
      const newParagraphBlockId = `b-${this._state.CRDTbinding.nextId()}`;
      newBlocks.push({
        id: newParagraphBlockId,
        type: "paragraph",
        charRuns: [],
        formats: [],
      });
      ops.push({
        op: "block_insert",
        id: this._state.CRDTbinding.nextId(),
        clock: this._state.CRDTbinding.getClock(),
        pageId: this._state.CRDTbinding.pageId,
        afterBlockId: null,
        blockId: newParagraphBlockId,
        blockType: "paragraph",
      });
    }

    this.executeCommand({
      state: {
        ...this._state,
        document: {
          ...this._state.document,
          page: { ...this._state.document.page, blocks: newBlocks },
        },
      },
      ops,
    });
    return true;
  };

  private applyActiveMenu = (menu: Exclude<ActiveMenu, { type: "none" }>) => {
    this._state = setActiveMenu(this._state, menu);

    const currentState = this._state;
    this.scheduleRender();
    this.listeners.forEach((listener) => listener(currentState));
  };

  openOverlay = (overlay: {
    key: string;
    blockIndex: number;
    x: number;
    y: number;
    data?: unknown;
  }): void => {
    this.applyActiveMenu({ type: "overlay", ...overlay });
  };

  replaceInlineRange = (
    blockId: string,
    start: number,
    end: number,
    text: string,
    mark?: Mark,
  ): boolean => {
    const blocks = this._state.document.page.blocks;
    const blockIndex = blocks.findIndex((b) => b.id === blockId);
    const block = blocks[blockIndex];
    if (!block || block.deleted || !isTextualBlock(block)) return false;
    // An empty replacement is a deletion of the range.
    if (text.length === 0) return this.deleteInlineRange(blockId, start, end);

    const ops: Operation[] = [];

    // Replace the chars in [start, end) with `text`, then (optionally) apply the
    // mark to the freshly inserted run.
    const { newPage: p1, op: deleteOp } = deleteCharsInRange(
      this._state.document.page,
      blockId,
      start,
      end,
      this._state.CRDTbinding,
    );
    ops.push(deleteOp);

    const { newPage: p2, op: insertOp } = insertCharsAtPosition(
      p1,
      blockId,
      start,
      text,
      this._state.CRDTbinding,
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
        this._state.CRDTbinding,
      );
      ops.push(formatOp);
      page = p3;
    }

    invalidateBlockCache(page.blocks[blockIndex]);

    this.executeCommand({
      state: { ...this._state, document: { ...this._state.document, page } },
      ops,
    });
    return true;
  };

  deleteInlineRange = (
    blockId: string,
    start: number,
    end: number,
  ): boolean => {
    const blocks = this._state.document.page.blocks;
    const blockIndex = blocks.findIndex((b) => b.id === blockId);
    const block = blocks[blockIndex];
    if (!block || block.deleted || !isTextualBlock(block)) return false;
    if (end <= start) return false;

    const { newPage, op } = deleteCharsInRange(
      this._state.document.page,
      blockId,
      start,
      end,
      this._state.CRDTbinding,
    );
    invalidateBlockCache(newPage.blocks[blockIndex]);

    // Place the caret where the deleted range began.
    const movedState = moveCursorToPosition(
      { ...this._state, document: { ...this._state.document, page: newPage } },
      blockIndex,
      start,
    );

    this.executeCommand({ state: movedState, ops: [op] });
    return true;
  };

  exitInlineMath = (
    blockIndex: number,
    startIndex: number,
    endIndex: number,
    direction: "left" | "right",
  ): void => {
    this._state = closeActiveMenu(this._state);
    // Clear the edit highlight set when the popover opened.
    if (this._state.ui.inlineMathHover) {
      this._state = {
        ...this._state,
        ui: { ...this._state.ui, inlineMathHover: null },
      };
    }

    // Place the caret on the side we're exiting toward, then step out one
    // position so snapInlineMathPosition doesn't pull us back into the chip.
    if (direction === "left") {
      this._state = moveCursorToPosition(this._state, blockIndex, startIndex);
      this._state = moveCursorLeft(this._state);
    } else {
      this._state = moveCursorToPosition(this._state, blockIndex, endIndex);
      this._state = moveCursorRight(this._state);
    }

    const currentState = this._state;
    this.scheduleRender();
    this.listeners.forEach((listener) => listener(currentState));
  };

  closeActiveMenu = (): void => {
    this._state = closeActiveMenu(this._state);
    const currentState = this._state;
    this.scheduleRender();
    this.listeners.forEach((listener) => listener(currentState));
  };

  setWindowFocused = (focused: boolean): void => {
    if (this._state.view.isWindowFocused === focused) return;
    this._state = updateWindowFocused(this._state, focused);
    // Selection color depends on window focus; scheduleRender marks the content
    // layer dirty so it repaints with the focused/unfocused selection style.
    this.scheduleRender();
  };

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

  setAwarenessBroadcast = (
    fn: AwarenessBroadcastFn | null,
    user?: AwarenessUser,
  ): void => {
    this.awarenessBroadcastFn = fn;
    if (user) {
      this.localUser = user;
    }
    // Broadcast initial awareness state when connected
    if (fn && this.localUser) {
      this.broadcastAwareness();
    }
  };

  setRemoteAwareness = (
    peerId: string,
    awarenessState: AwarenessState | null,
  ): void => {
    if (awarenessState === null) {
      this.remoteAwareness.delete(peerId);
    } else {
      this.remoteAwareness.set(peerId, awarenessState);
    }
    // Trigger re-render to show updated remote cursors
    this.scheduleRender();
  };

  getRemoteAwareness = (): Map<string, AwarenessState> => {
    return this.getActiveRemoteAwareness();
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
      selection: { empty: this.isSelectionEmpty() },
      activeMarks: this.getActiveMarks(),
    };
  }

  collectOverlays = (): NodeOverlay[] =>
    collectOverlays(this._state, this.viewport, getEditorStyles(this._state));

  onImagePaste = (
    callback: ((file: File, blockIndex: number) => void) | null,
  ): void => {
    this.onImagePasteCallback = callback;
  };

  onScroll = (callback: ((scrollY: number) => void) | null): void => {
    this.onScrollCallback = callback;
  };

  getScrollY = (): number => this.viewport.scrollY;

  setSearchHighlights = (
    highlights: {
      blockIndex: number;
      startIndex: number;
      endIndex: number;
    }[],
    activeIndex: number,
  ): void => {
    this._state = {
      ...this._state,
      ui: { ...this._state.ui, search: { highlights, activeIndex } },
    };
    this.scheduleRender();
  };

  clearSearchHighlights = (): void => {
    this._state = {
      ...this._state,
      ui: { ...this._state.ui, search: { highlights: [], activeIndex: -1 } },
    };
    this.scheduleRender();
  };

  scrollToPosition = (position: {
    blockIndex: number;
    textIndex: number;
  }): void => {
    const newScrollY = scrollToMakeCursorVisible(
      position,
      this._state,
      this.viewport,
    );
    if (newScrollY !== null) {
      this.viewport = { ...this.viewport, scrollY: newScrollY };
      this.scheduleRender();
    }
  };
}
