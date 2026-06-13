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

export interface Editor {
  getState: () => EditorState | null;
  /**
   * Read-only state snapshot for UI binding: `{ selection, activeMarks }`.
   * For the raw internal {@link EditorState} (escape hatch), use {@link getState}.
   */
  readonly state: EditorStateSnapshot;
  destroy: () => void;
  updateViewport: (viewport: Partial<ViewportState>) => void;
  setFocus: (focused: boolean, shouldClearSelection?: boolean) => void;
  setInitialCursor: () => void;
  /** Place the caret at the document start or end (forces a new caret). */
  setCaret: (at: "start" | "end") => void;
  /** Update browser-window focus (affects selection color); re-renders. */
  setWindowFocused: (focused: boolean) => void;
  getCursorScreenPosition: () => {
    x: number;
    y: number;
    height: number;
  } | null;
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
  executeSlashCommand: (command: SlashCommand) => void;
  copy: () => Promise<boolean>;
  cut: () => Promise<boolean>;
  paste: () => Promise<boolean>;
  updateLink: (
    blockIndex: number,
    startIndex: number,
    endIndex: number,
    newUrl: string,
    newText: string,
  ) => void;
  clearLink: (blockIndex: number, startIndex: number, endIndex: number) => void;
  createLink: (url: string, text: string) => void;
  clearSelection: () => void;
  setMode: (mode: "edit" | "select" | "locked") => void;
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
  openImageUploadMenu: (
    blockIndex: number,
    x: number,
    y: number,
    existingUrl?: string,
    existingAlt?: string,
  ) => void;
  /**
   * Set the upload-status chrome the canvas paints over the active image-upload
   * menu's block (spinner / error). No-op unless an image-upload menu is open.
   * This is transient UI status, not document content — it produces no CRDT op.
   */
  setImageUploadStatus: (
    status: "idle" | "uploading" | "complete" | "error",
  ) => void;
  openMathEditMenu: (blockIndex: number, x: number, y: number) => void;
  openInlineMathEditMenu: (
    blockIndex: number,
    startIndex: number,
    endIndex: number,
    latex: string,
    x: number,
    y: number,
  ) => void;
  /** Close the inline-math edit popover and move the caret past the chip in the
   * given visual direction. Used when the user arrows out of the popover input. */
  exitInlineMath: (
    blockIndex: number,
    startIndex: number,
    endIndex: number,
    direction: "left" | "right",
  ) => void;
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

//NOTE - maybe we should make this as class instead.
export default function createEditor(
  layers: CanvasLayers,
  initialState: EditorState,
  viewportProp: ViewportState,
  hiddenInput?: HTMLElement,
): Editor {
  // Extract contexts from layers
  const contentCtx = layers.content.ctx;
  const cursorCtx = layers.cursor.ctx;
  const contentCanvas = layers.content.canvas;

  let state: EditorState = initialState;
  let viewport = viewportProp;

  // Built-in command defaults. These sit below any host handler (registered via
  // editor.registerCommand) on the bus, so a host can override them by returning
  // true — e.g. a native shell taking over OPEN_LINK. Observe-only commands
  // (haptics, gesture milestones) have no default and are dispatched as-is.
  state.commandBus.register(
    OPEN_LINK,
    ({ url }) => {
      window.open(url, "_blank", "noopener,noreferrer");
      return true;
    },
    DEFAULT_COMMAND_PRIORITY,
  );
  // Per-instance pointer interaction state (in-flight gestures, auto-scroll,
  // tap tracking) and this editor's built-in chrome regions (scrollbar,
  // selection handles, peer indicators) — threaded into handleEvents so two
  // mounted editors never share gesture state.
  const regionRegistry = createChromeRegionRegistry();
  const session = createInteractionSession(regionRegistry);
  let animationFrameId: number | null = null;
  let documentHeight = 0;
  let visibility = {
    start: 0,
    end: 0,
  };

  let isRendering = false;

  // Broadcast function for sending operations to peers
  let broadcastFn: ((ops: Operation[]) => void) | null = null;

  // Change-event channel. `on("change")` listeners receive a ChangeTransaction
  // ({ isRemote, ops }); this is distinct from the state-diff subscribe() path
  // that backs selectionchange/focus/blur.
  const changeListeners: ((tx: ChangeTransaction) => void)[] = [];
  const emitChange = (ops: readonly Operation[], isRemote: boolean): void => {
    if (ops.length === 0 || changeListeners.length === 0) return;
    const tx: ChangeTransaction = { isRemote, ops };
    for (const listener of changeListeners) listener(tx);
  };
  // Single funnel for locally-produced ops: broadcast to peers (when wired) and
  // notify change listeners as a local edit. Replaces the bare emitLocalOps(ops)
  // calls at every op site below.
  const emitLocalOps = (ops: Operation[]): void => {
    if (ops.length === 0) return;
    broadcastFn?.(ops);
    emitChange(ops, false);
  };

  // Awareness state for remote peers
  const remoteAwareness: Map<string, AwarenessState> = new Map();
  type AwarenessBroadcastFn = (state: AwarenessState) => void;
  let awarenessBroadcastFn: AwarenessBroadcastFn | null = null;

  // Idle timeout for filtering inactive peers from UI (10 seconds)
  const AWARENESS_IDLE_TIMEOUT = 10000;
  // Stale timeout for removing peers from memory (30 seconds)
  const AWARENESS_STALE_TIMEOUT = 30000;

  /**
   * Get remote awareness states, filtering out idle peers.
   * Peers who haven't sent updates within AWARENESS_IDLE_TIMEOUT are excluded.
   */
  const getActiveRemoteAwareness = (): Map<string, AwarenessState> => {
    const now = Date.now();
    const active = new Map<string, AwarenessState>();

    for (const [peerId, state] of remoteAwareness) {
      if (now - state.lastUpdate <= AWARENESS_IDLE_TIMEOUT) {
        active.set(peerId, state);
      }
    }

    return active;
  };

  /**
   * Cleanup stale awareness states from memory.
   * Removes peers who haven't sent updates within AWARENESS_STALE_TIMEOUT.
   */
  const cleanupStaleAwareness = (): void => {
    const now = Date.now();
    let hasChanges = false;

    for (const [peerId, state] of remoteAwareness) {
      if (now - state.lastUpdate > AWARENESS_STALE_TIMEOUT) {
        remoteAwareness.delete(peerId);
        hasChanges = true;
      }
    }

    if (hasChanges) {
      scheduleRender();
    }
  };

  // Cleanup interval for stale awareness states (runs every 10 seconds)
  const awarenessCleanupInterval = setInterval(cleanupStaleAwareness, 10000);

  // Local user info for awareness
  let localUser: AwarenessUser | null = null;

  // Track last broadcast awareness state to avoid redundant broadcasts
  let lastBroadcastCursor: AwarenessCursor | null = null;
  let lastBroadcastSelection: AwarenessSelection | null = null;

  /**
   * Broadcast local awareness state (cursor/selection) to peers.
   * Called when cursor or selection changes.
   * Only broadcasts if the position has actually changed.
   */
  const broadcastAwareness = (): void => {
    if (!awarenessBroadcastFn || !localUser) return;

    const page = state.document.page;
    const cursor = state.document.cursor;
    const selection = state.document.selection;

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
      awarenessCursorsEqual(awarenessCursor, lastBroadcastCursor) &&
      awarenessSelectionsEqual(awarenessSelection, lastBroadcastSelection)
    ) {
      return;
    }

    // Update last broadcast state
    lastBroadcastCursor = awarenessCursor;
    lastBroadcastSelection = awarenessSelection;

    const awarenessState: AwarenessState = {
      user: localUser,
      cursor: awarenessCursor,
      selection: awarenessSelection,
      lastUpdate: Date.now(),
    };

    awarenessBroadcastFn(awarenessState);
  };

  /**
   * Execute a command that returns { state, ops } and broadcast operations to peers.
   * This is the central point for all state-modifying operations.
   */
  const executeCommand = (result: CommandResult): void => {
    const { state: newState, ops } = result;
    const prevState = state;

    // Update local state and record to undo stack (pass both before/after states for cursor restoration)
    state =
      ops.length > 0
        ? recordUndoOps(prevState, newState, ops, state.CRDTbinding.getPeerId())
        : newState;

    // Broadcast ops to peers (if any)
    if (ops.length > 0 && broadcastFn) {
      emitLocalOps(ops);
    }

    // Trigger re-render
    scheduleRender();

    // Notify listeners
    const currentState = state;
    listeners.forEach((listener) => listener(currentState));
  };

  // Cache for canvas bounding rect to avoid getBoundingClientRect in render loop
  let cachedRect = { left: 0, top: 0 };
  let rectNeedsUpdate = true;

  const updateCachedRect = () => {
    const containerRect = contentCanvas.getBoundingClientRect();
    cachedRect = {
      left: containerRect.left,
      top: containerRect.top,
    };
    rectNeedsUpdate = false;
  };

  // Dirty flags for each layer
  let dirtyLayers = {
    content: true, // Start with true for initial render
    cursor: true,
  };

  // Cache for document height (expensive to calculate)
  let cachedDocumentHeight = 0;
  let documentHeightDirty = true;

  let lastCursorBlinkState = false; // Track cursor blink state changes

  const eventsQueue: Event[] = [];
  const listeners: ((state: EditorState) => void)[] = [];

  // Store clipboard data separately since it gets detached after the event handler
  let pendingClipboardData: {
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
  const SENTINEL = "\u00A0"; // NBSP (stable in contenteditable; a plain space can be trimmed)
  let isMirrorUpdating = false;
  let lastSelectionSig: string | null = null;

  // Callback for when an image file is pasted (set by external code to handle async upload)
  let onImagePasteCallback: ((file: File, blockIndex: number) => void) | null =
    null;

  // Callback for scroll position changes
  let onScrollCallback: ((scrollY: number) => void) | null = null;
  let lastReportedScrollY = 0;

  /**
   * Mark that content layer needs re-rendering (expensive operation).
   * This is called when page content, selection, or viewport changes.
   */
  const scheduleRender = () => {
    dirtyLayers.content = true;
    dirtyLayers.cursor = true; // Cursor position may have changed too
  };

  // Passed into the renderer so async work (image decode, math typeset) can
  // request a repaint when its cache populates. Guarded so a promise that
  // settles after destroy() is a no-op instead of poking a torn-down loop.
  let destroyed = false;
  const requestRedraw = () => {
    if (!destroyed) scheduleRender();
  };

  // Update canvas cursor style based on scrollbar hover and drag state
  const updateCursorStyle = (
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
      contentCanvas.style.cursor = "grabbing";
    } else if (dragHandleHover) {
      // When hovering over a drag handle, use resize cursor
      if (dragHandleHover === "left" || dragHandleHover === "right") {
        contentCanvas.style.cursor = "ew-resize"; // Horizontal resize
      } else if (dragHandleHover === "bottom") {
        contentCanvas.style.cursor = "ns-resize"; // Vertical resize
      }
    } else if (isHoveringScrollbar) {
      // When hovering over scrollbar, use pointer cursor
      contentCanvas.style.cursor = "pointer";
    } else if (isHoveringLinkWithModifier) {
      // When hovering over link with Ctrl/Cmd held, use pointer cursor
      contentCanvas.style.cursor = "pointer";
    } else if (isHoveringCheckbox) {
      // When hovering over todo checkbox, use pointer cursor
      contentCanvas.style.cursor = "pointer";
    } else if (isHoveringPeerIndicator) {
      // When hovering over out-of-view peer indicator, use pointer cursor
      contentCanvas.style.cursor = "pointer";
    } else if (isHoveringMath) {
      // Inline math chip / math block — both are clickable
      contentCanvas.style.cursor = "pointer";
    } else {
      // When hovering over text, use text cursor
      contentCanvas.style.cursor = "text";
    }
  };

  // Track last rendered page to detect remote operation changes
  let lastRenderedPageRef: Page | null = null;

  // Render a single frame synchronously
  const renderFrame = async () => {
    if (isRendering) return;
    isRendering = true;

    try {
      // Check if page changed since last render (handles remote ops that bypass handleEvents)
      if (lastRenderedPageRef !== state.document.page) {
        state.view.visibleBlocks = getVisibleBlocks(state.document.page);
        dirtyLayers.content = true;
        dirtyLayers.cursor = true;
        documentHeightDirty = true;
        lastRenderedPageRef = state.document.page;
      }

      // Update cached rect only when needed (avoids expensive getBoundingClientRect every frame)
      if (rectNeedsUpdate) {
        updateCachedRect();
      }

      const prevState = state;

      // Handle events to get state and operations
      const handleEventsResult = handleEvents(
        state,
        viewport,
        visibility,
        eventsQueue,
        documentHeight,
        cachedRect,
        session,
        updateViewport,
        pendingClipboardData,
      );

      // Update state with the result from events
      state = handleEventsResult.state;

      // Record operations to undo stack (only if not from undo/redo)
      // Undo/redo already updates undoManager internally, so check if it changed
      if (handleEventsResult.ops.length > 0) {
        const undoManagerChanged = prevState.undoManager !== state.undoManager;
        if (!undoManagerChanged) {
          // Regular operation - record to undo stack (pass both before/after states for cursor restoration)
          state = recordUndoOps(
            prevState,
            state,
            handleEventsResult.ops,
            state.CRDTbinding.getPeerId(),
          );
        }
        // Broadcast ops to peers
        if (broadcastFn) {
          emitLocalOps(handleEventsResult.ops);
        }
      }

      // Trigger image paste callback if an image file was pasted
      if (
        pendingClipboardData?.imageFile &&
        onImagePasteCallback &&
        handleEventsResult.pastedImageBlockIndex !== undefined
      ) {
        const file = pendingClipboardData.imageFile;
        const blockIndex = handleEventsResult.pastedImageBlockIndex;
        // Call async — don't block the render loop
        onImagePasteCallback(file, blockIndex);
      }

      // Clear clipboard data after it's been used
      pendingClipboardData = null;

      // Check if state changed or if there are events that require rendering
      const stateChanged = prevState !== state;

      // Determine what changed to decide which layers to update
      if (stateChanged) {
        // Check if page content changed (requires content layer update)
        if (prevState.document.page !== state.document.page) {
          state.view.visibleBlocks = getVisibleBlocks(state.document.page); // ADD HERE
          dirtyLayers.content = true;
          dirtyLayers.cursor = true; // Cursor position may have changed
          documentHeightDirty = true; // Blocks changed, need to recalculate height
        }

        // Check if selection changed (requires content layer update)
        if (prevState.document.selection !== state.document.selection) {
          dirtyLayers.content = true;
        }

        // Check if cursor position changed (requires cursor layer update)
        if (
          prevState.document.cursor?.position !==
          state.document.cursor?.position
        ) {
          dirtyLayers.cursor = true;
        }

        // Check if focus changed (affects cursor visibility)
        if (prevState.view.isFocused !== state.view.isFocused) {
          dirtyLayers.cursor = true;
        }

        // Check if scrollbar state changed (for fade animation)
        if (prevState.view.scrollbar !== state.view.scrollbar) {
          dirtyLayers.content = true;
        }

        // Math hover state changes affect rendered chip/block backgrounds.
        // The inline-math edit popover also styles its chip as hovered.
        if (
          prevState.ui.inlineMathHover !== state.ui.inlineMathHover ||
          prevState.ui.hoveredMathBlockIndex !==
            state.ui.hoveredMathBlockIndex ||
          (prevState.ui.activeMenu.type === "inlineMathEdit") !==
            (state.ui.activeMenu.type === "inlineMathEdit") ||
          (prevState.ui.activeMenu.type === "inlineMathEdit" &&
            state.ui.activeMenu.type === "inlineMathEdit" &&
            (prevState.ui.activeMenu.blockIndex !==
              state.ui.activeMenu.blockIndex ||
              prevState.ui.activeMenu.startIndex !==
                state.ui.activeMenu.startIndex ||
              prevState.ui.activeMenu.endIndex !==
                state.ui.activeMenu.endIndex))
        ) {
          dirtyLayers.content = true;
        }

        // Broadcast awareness when cursor or selection changes
        if (
          prevState.document.cursor?.position !==
            state.document.cursor?.position ||
          prevState.document.selection !== state.document.selection
        ) {
          broadcastAwareness();
        }
      }

      // Check if cursor blink state changed (for cursor animation)
      const currentCursorBlinkState = state.document.cursor
        ? isCursorBlinking(state.document.cursor, getEditorStyles(state))
        : false;
      const cursorBlinkChanged =
        lastCursorBlinkState !== currentCursorBlinkState;
      lastCursorBlinkState = currentCursorBlinkState;

      // Cursor blink only affects cursor layer
      if (cursorBlinkChanged) {
        dirtyLayers.cursor = true;
      }

      // Render dirty layers
      const needsAnyRender = dirtyLayers.content || dirtyLayers.cursor;

      if (needsAnyRender) {
        // Render content layer if dirty (expensive)
        if (dirtyLayers.content) {
          // Recalculate document height only when needed
          if (documentHeightDirty) {
            cachedDocumentHeight = calculateDocumentHeight();
            documentHeightDirty = false;
          }

          // Pre-calculate document height to clamp viewport before rendering
          const maxScroll = Math.max(0, cachedDocumentHeight - viewport.height);
          if (viewport.scrollY > maxScroll) {
            viewport = { ...viewport, scrollY: maxScroll };
          }

          // Render the page content (text, blocks, selection, scrollbar)
          // Drag handles are now rendered within renderImageBlock for consistency
          documentHeight = renderPage(
            contentCtx,
            state,
            viewport,
            visibility,
            undefined,
            getActiveRemoteAwareness(),
            requestRedraw,
          );

          // Update cursor style based on scrollbar hover and drag state
          updateCursorStyle(
            state.view.scrollbar.isHovered,
            state.view.scrollbar.isDragging,
            state.ui.isHoveringLinkWithModifier,
            state.ui.imageHover?.hoveredHandle || null,
            state.ui.isHoveringCheckbox,
            state.ui.isHoveringPeerIndicator,
            state.ui.inlineMathHover !== null ||
              state.ui.hoveredMathBlockIndex !== null,
          );

          dirtyLayers.content = false;
        }

        // Render cursor layer if dirty (very cheap!)
        if (dirtyLayers.cursor) {
          renderCursorLayer(
            cursorCtx,
            session,
            state,
            viewport,
            getEditorStyles(state),
            getActiveRemoteAwareness(),
          );
          dirtyLayers.cursor = false;
        }

        // Update hidden input position to match cursor for IME composition toolbar
        if (hiddenInput && state.document.cursor && state.view.isFocused) {
          const cursorCoords = getCursorCoordinatesWithComposition(
            state,
            viewport,
          );
          if (cursorCoords) {
            hiddenInput.style.left = `${cursorCoords.x}px`;
            hiddenInput.style.top = `${
              cursorCoords.y - viewport.scrollY + cursorCoords.height
            }px`;
          }
        }

        // Mirror the model selection into the input surface so native copy/cut
        // and screen readers operate on real text. Skipped during IME
        // composition (the browser owns the surface content then).
        if (
          hiddenInput &&
          state.view.isFocused &&
          !state.ui.composition?.isComposing
        ) {
          syncMirrorToSelection();
        }

        // Notify listeners only if state changed
        if (stateChanged) {
          const currentState = state;
          listeners.forEach((listener) => listener(currentState));
        }

        // Notify scroll callback if scrollY changed
        if (onScrollCallback && viewport.scrollY !== lastReportedScrollY) {
          lastReportedScrollY = viewport.scrollY;
          onScrollCallback(viewport.scrollY);
        }
      }
    } finally {
      isRendering = false;
    }
  };

  // Render loop
  // The loop continues running via requestAnimationFrame for smooth interactions,
  // but the actual canvas rendering only happens when needed (via the needsRender flag)
  const renderLoop = () => {
    renderFrame();
    animationFrameId = requestAnimationFrame(renderLoop);
  };

  function eventsHandler(e: Event) {
    // Ignore keyboard events from hidden input - those are handled separately
    if (e instanceof KeyboardEvent && e.target === hiddenInput) {
      return;
    }

    // Don't process keyboard/paste events targeting other interactive elements
    // (e.g., dialog inputs, search bars) — those belong to the other element
    if (
      (e instanceof KeyboardEvent || e.type === "paste") &&
      e.target instanceof HTMLElement &&
      e.target !== hiddenInput
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
      document.activeElement === hiddenInput
    ) {
      return;
    }

    // Only process keyboard and paste events if editor is focused
    if (e instanceof KeyboardEvent || e.type === "paste") {
      // Check if editor is focused before handling keyboard/paste events
      if (!state.view.isFocused) {
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

    eventsQueue.push(e);
    scheduleRender(); // Mark that we need to render due to this event
  }

  // Window-level mouse handlers to catch events outside canvas
  function windowMouseUpHandler(e: Event) {
    eventsQueue.push(e);
  }

  function windowMouseMoveHandler(e: Event) {
    if (
      state &&
      (state.view.scrollbar.isDragging || state.ui.mode === "select")
    ) {
      eventsQueue.push(e);
    }
  }

  // Track touch state to distinguish taps from scrolls
  let touchStartY = 0;
  let touchStartTime = 0;
  let touchHasMoved = false;
  const TAP_THRESHOLD = 10; // pixels
  const TAP_TIME_THRESHOLD = 300; // milliseconds

  // Handle touchstart - track for tap detection
  function touchStartHandler(e: TouchEvent) {
    // Store touch start info for tap detection
    if (e.touches.length > 0) {
      touchStartY = e.touches[0].clientY;
      touchStartTime = Date.now();
      touchHasMoved = false;
    }

    // Process the touch event normally (for scrolling, etc.)
    eventsHandler(e);
  }

  // Handle touchend - focus input if it was a tap (not a scroll)
  function touchEndHandler(e: TouchEvent) {
    // Check if we're ending a long press selection BEFORE processing the event
    // This allows us to focus the input synchronously with the user gesture
    const wasLongPress = isInLongPressMode(session);

    // Process the touch event first
    eventsHandler(e);

    // Check if this was a tap (not a scroll/drag)
    const touchDuration = Date.now() - touchStartTime;
    const wasTap = !touchHasMoved && touchDuration < TAP_TIME_THRESHOLD;

    // Don't focus input if a context menu just opened (it would close the menu)
    const hasContextMenu = state.ui.activeMenu.type === "contextMenu";

    // Focus input if ending long press or on tap (but not when context menu is open or in readonly mode)
    if (
      hiddenInput &&
      isTouchDevice() &&
      (wasLongPress || wasTap) &&
      !hasContextMenu &&
      !state.ui.isReadonlyBase
    ) {
      try {
        hiddenInput.focus({ preventScroll: true });
        // Some browsers need click as well
        if (document.activeElement !== hiddenInput) {
          const prevPointerEvents = hiddenInput.style.pointerEvents;
          hiddenInput.style.pointerEvents = "auto";
          hiddenInput.focus({ preventScroll: true });
          hiddenInput.click();
          hiddenInput.style.pointerEvents = prevPointerEvents;
        }
      } catch (err) {
        console.warn("Failed to focus hidden input:", err);
      }
    }
  }

  // Handle touchmove - track movement to distinguish taps from scrolls
  function touchMoveHandler(e: TouchEvent) {
    // Track if touch has moved significantly
    if (e.touches.length > 0) {
      const deltaY = Math.abs(e.touches[0].clientY - touchStartY);
      if (deltaY > TAP_THRESHOLD) {
        touchHasMoved = true;
      }
    }

    // Process the touch event normally (for scrolling)
    eventsHandler(e);
  }

  // ── Input-surface mirror + clipboard helpers ───────────────────────────────

  // Write `text` into the contenteditable surface and, when it's the focused
  // element, set the DOM selection: spanning the whole text (so a screen reader
  // announces it and the browser has real content to copy) or collapsed after
  // it (the sentinel caret). Wrapped in `isMirrorUpdating` so the resulting DOM
  // events are ignored by our own handlers.
  function setMirror(text: string, selectText: boolean) {
    if (!hiddenInput) return;
    isMirrorUpdating = true;
    try {
      if (hiddenInput.textContent !== text) {
        hiddenInput.textContent = text;
      }
      const node = hiddenInput.firstChild;
      if (node && document.activeElement === hiddenInput) {
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
      isMirrorUpdating = false;
    }
  }

  // Restore the single-sentinel-char state with the caret AFTER it (keeps
  // Android emitting deleteContentBackward). Called after every input/compose.
  function resetSentinel() {
    setMirror(SENTINEL, false);
  }

  // Cheap signature of the current selection/caret, to avoid recomputing the
  // (potentially large) selection text on every render frame.
  function selectionSignature(s: EditorState): string {
    const sel = s.document.selection;
    if (sel && !sel.isCollapsed) {
      return `sel:${sel.anchor.blockIndex}:${sel.anchor.textIndex}-${sel.focus.blockIndex}:${sel.focus.textIndex}`;
    }
    const c = s.document.cursor;
    return c
      ? `caret:${c.position.blockIndex}:${c.position.textIndex}`
      : "none";
  }

  // Keep the surface in sync with the model selection: hold the selection's
  // plain text (selected, so copy/AT see it) or fall back to the sentinel.
  // Skipped during IME composition (the browser owns the content then).
  function syncMirrorToSelection() {
    if (!hiddenInput) return;
    const sig = selectionSignature(state);
    if (sig === lastSelectionSig) return;
    lastSelectionSig = sig;
    const sel = state.document.selection;
    if (sel && !sel.isCollapsed) {
      const text = getSelectionPlainText(state);
      if (text) {
        setMirror(text, true);
        return;
      }
    }
    // No selection: (re)place the sentinel + caret. Runs only when the
    // selection signature changes (cheap), and re-anchors the caret after the
    // sentinel on focus and after every caret move so Android keeps emitting
    // deleteContentBackward.
    resetSentinel();
  }

  // Pull html/text/image out of a ClipboardEvent synchronously (clipboardData
  // detaches after the handler returns).
  function extractPendingClipboard(e: ClipboardEvent): {
    html: string;
    text: string;
    imageFile: File | null;
  } | null {
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
  }

  // Native copy: write the selection as text/plain + text/html synchronously.
  // Copy is allowed in readonly mode. In a native shell the WebView may ignore
  // ClipboardEvent.setData, so defer to the async host-bridge path there.
  function copyHandler(e: ClipboardEvent) {
    if (!state.view.isFocused) return;

    const payload = buildClipboardPayload(state);
    if (!payload || !e.clipboardData) return; // nothing selected → browser default
    e.preventDefault();
    e.clipboardData.setData("text/plain", payload.plainText);
    e.clipboardData.setData("text/html", payload.html);
  }

  // Native cut: copy, then delete the selection through the command pipeline.
  function cutHandler(e: ClipboardEvent) {
    if (!state.view.isFocused) return;
    if (state.ui.mode === "readonly" || state.ui.mode === "locked") return;
    if (state.ui.composition?.isComposing) return;

    const payload = buildClipboardPayload(state);
    if (!payload || !e.clipboardData) return;
    e.preventDefault();
    e.clipboardData.setData("text/plain", payload.plainText);
    e.clipboardData.setData("text/html", payload.html);
    executeCommand(deleteSelectedText(state));
    resetSentinel();
  }

  // Native paste: stash the clipboard payload and queue the event so the
  // existing handlePaste flow (incl. the image-paste callback) runs in-frame.
  function pasteHandler(e: ClipboardEvent) {
    if (!state.view.isFocused) return;
    if (state.ui.mode === "readonly" || state.ui.mode === "locked") return;
    e.preventDefault();
    pendingClipboardData = extractPendingClipboard(e);
    eventsQueue.push(e);
    scheduleRender();
  }

  // Handle input from the contenteditable surface (mobile keyboard + desktop
  // character input flow through here as InputEvents).
  function hiddenInputHandler(e: Event) {
    if (!hiddenInput) return;
    if (isMirrorUpdating) return;

    // Block input in readonly or locked mode
    if (state.ui.mode === "readonly" || state.ui.mode === "locked") {
      resetSentinel();
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
    if (state.ui.composition?.isComposing) {
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
        eventsQueue.push(keyEvent);
      }
      scheduleRender();
      // Restore the sentinel (caret after a real char) so Android keeps firing
      // deleteContentBackward.
      resetSentinel();
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
      eventsQueue.push(enterEvent);
      scheduleRender();
      resetSentinel();
      return;
    }

    if (inputEvent.inputType === "deleteContentBackward") {
      const backspaceEvent = new KeyboardEvent("keydown", {
        key: "Backspace",
        bubbles: true,
        cancelable: true,
      });
      eventsQueue.push(backspaceEvent);
      scheduleRender();
      resetSentinel();
      return;
    }

    if (inputEvent.inputType === "deleteContentForward") {
      const deleteEvent = new KeyboardEvent("keydown", {
        key: "Delete",
        bubbles: true,
        cancelable: true,
      });
      eventsQueue.push(deleteEvent);
      scheduleRender();
      resetSentinel();
      return;
    }

    // Restore the sentinel for any other input types
    resetSentinel();
  }

  // Handle keydown from hidden input (for special keys)
  function hiddenInputKeyDownHandler(e: KeyboardEvent) {
    if (!hiddenInput) return;

    // Check if this is a keyboard shortcut (Ctrl/Cmd + key)
    const isShortcut = e.ctrlKey || e.metaKey;

    // In readonly mode, only allow navigation and copy
    if (state.ui.mode === "readonly") {
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
    if (state.ui.mode === "locked") {
      e.preventDefault();
      return;
    }

    // During composition (IME input), let the IME handle keys natively
    if (state.ui.composition?.isComposing) {
      // Escape cancels composition without inserting text
      if (e.key === "Escape") {
        state = {
          ...state,
          ui: {
            ...state.ui,
            composition: null,
          },
        };
        resetSentinel();
        scheduleRender();
        e.preventDefault();
        return;
      }
      // Enter commits composition text
      if (e.key === "Enter") {
        return;
      }
      // Backspace deletes character before cursor within composition
      if (e.key === "Backspace") {
        const comp = state.ui.composition;
        if (comp.cursorOffset > 0) {
          const newText =
            comp.text.slice(0, comp.cursorOffset - 1) +
            comp.text.slice(comp.cursorOffset);
          state = {
            ...state,
            document: {
              ...state.document,
              cursor: state.document.cursor
                ? {
                    ...state.document.cursor,
                    lastUpdate: Date.now(),
                  }
                : null,
            },
            ui: {
              ...state.ui,
              composition: {
                ...comp,
                text: newText,
                cursorOffset: comp.cursorOffset - 1,
              },
            },
          };
          // If all text deleted, cancel composition
          if (newText.length === 0) {
            state = {
              ...state,
              ui: { ...state.ui, composition: null },
            };
            resetSentinel();
          }
          scheduleRender();
        }
        e.preventDefault();
        return;
      }
      // Delete removes character after cursor within composition
      if (e.key === "Delete") {
        const comp = state.ui.composition;
        if (comp.cursorOffset < comp.text.length) {
          const newText =
            comp.text.slice(0, comp.cursorOffset) +
            comp.text.slice(comp.cursorOffset + 1);
          state = {
            ...state,
            document: {
              ...state.document,
              cursor: state.document.cursor
                ? {
                    ...state.document.cursor,
                    lastUpdate: Date.now(),
                  }
                : null,
            },
            ui: {
              ...state.ui,
              composition: {
                ...comp,
                text: newText,
              },
            },
          };
          // If all text deleted, cancel composition
          if (newText.length === 0) {
            state = {
              ...state,
              ui: { ...state.ui, composition: null },
            };
            resetSentinel();
          }
          scheduleRender();
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
        const comp = state.ui.composition;
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
          state = {
            ...state,
            document: {
              ...state.document,
              cursor: state.document.cursor
                ? {
                    ...state.document.cursor,
                    lastUpdate: Date.now(),
                  }
                : null,
            },
            ui: {
              ...state.ui,
              composition: {
                ...comp,
                cursorOffset: newOffset,
              },
            },
          };
          scheduleRender();
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
      eventsQueue.push(e);
      scheduleRender();
      resetSentinel();
    } else if (isShortcut) {
      // Save as Markdown - handle here (not in events queue) to preserve user gesture for download
      if (e.code === "KeyS") {
        e.preventDefault();
        e.stopPropagation();
        if (e.repeat) return;
        const markdown = serializeToMarkdown(state.document.page.blocks);
        const blob = new Blob([markdown], { type: "text/markdown" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        const firstBlock = state.document.page.blocks.find(
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
        eventsQueue.push(e);
        scheduleRender();
      }
    } else {
      // For regular character keys, prevent default to stop them from being processed by window listener
      // But allow the input event to fire
      e.stopPropagation();
    }
  }

  // Handle composition events (IME input)
  function compositionStartHandler(e: CompositionEvent) {
    // Mark composition as starting - this will be handled in events.ts
    eventsQueue.push(e);
    scheduleRender();
  }

  function compositionUpdateHandler(e: CompositionEvent) {
    // Update composition text - this will be handled in events.ts
    eventsQueue.push(e);
    scheduleRender();
  }

  function compositionEndHandler(e: CompositionEvent) {
    if (!hiddenInput) return;

    // Finalize composition - this will be handled in events.ts
    eventsQueue.push(e);
    scheduleRender();

    // Restore the sentinel after composition ends.
    resetSentinel();
  }

  // Click handler for focusing input (stored for cleanup)
  let canvasClickHandler: (() => void) | null = null;

  // Handler to invalidate cached rect when canvas position might change
  const invalidateRectCache = () => {
    rectNeedsUpdate = true;
  };

  // Initialize the editor and start the render loop
  (() => {
    scheduleRender(); // Schedule initial render
    renderLoop();

    // Add click/mousedown handler to canvas as fallback for focusing input
    canvasClickHandler = () => {
      // Don't focus input in readonly mode (prevents keyboard from opening)
      if (hiddenInput && !state.ui.isReadonlyBase) {
        try {
          hiddenInput.focus({ preventScroll: true });
        } catch {
          // Ignore
        }
      }
    };
    if (!isTouchDevice()) {
      contentCanvas.addEventListener("mousedown", canvasClickHandler);

      contentCanvas.addEventListener("contextmenu", eventsHandler);
      contentCanvas.addEventListener("mousedown", eventsHandler);
      contentCanvas.addEventListener("mousemove", eventsHandler);
      contentCanvas.addEventListener("mouseup", eventsHandler);
      contentCanvas.addEventListener("wheel", eventsHandler, {
        passive: false,
      });

      window.addEventListener("mouseup", windowMouseUpHandler);
      window.addEventListener("mousemove", windowMouseMoveHandler);
    }
    contentCanvas.addEventListener("click", canvasClickHandler);

    contentCanvas.addEventListener("touchstart", touchStartHandler, {
      passive: false,
    });
    contentCanvas.addEventListener("touchmove", touchMoveHandler, {
      passive: false,
    });
    contentCanvas.addEventListener("touchend", touchEndHandler, {
      passive: false,
    });
    contentCanvas.addEventListener("touchcancel", eventsHandler, {
      passive: false,
    });

    // Keyboard, IME, and clipboard are NOT captured on `window` — they flow
    // through the per-instance contenteditable surface below. This keeps two
    // editors on one page from clobbering each other's input (the old global
    // window keydown/paste listeners fired for every instance).

    // Invalidate rect cache when canvas position might change
    window.addEventListener("resize", invalidateRectCache);
    window.addEventListener("scroll", invalidateRectCache, true);

    // Set up input-surface handlers (keyboard, mobile, IME, clipboard).
    if (hiddenInput) {
      hiddenInput.addEventListener("input", hiddenInputHandler);
      hiddenInput.addEventListener("keydown", hiddenInputKeyDownHandler);

      // Add composition event listeners for IME support
      hiddenInput.addEventListener("compositionstart", compositionStartHandler);
      hiddenInput.addEventListener(
        "compositionupdate",
        compositionUpdateHandler,
      );
      hiddenInput.addEventListener("compositionend", compositionEndHandler);

      // Native clipboard events — synchronous copy/cut/paste on the selection.
      hiddenInput.addEventListener("copy", copyHandler);
      hiddenInput.addEventListener("cut", cutHandler);
      hiddenInput.addEventListener("paste", pasteHandler);

      // Ensure input is focusable (already set in mount.ts, but ensure it's correct)
      hiddenInput.setAttribute("tabindex", "0");

      // Seed the sentinel content so the surface is never empty before focus.
      resetSentinel();
    }

    // Font-family changes now flow through `setTheme` (which clears block caches
    // and re-renders), so there's no separate font-change subscription.

    // If fonts haven't loaded yet, re-render once they're ready
    // so text measurements use the correct font metrics
    onFontsReady(() => {
      clearAllBlockCaches(state.document.page.blocks);
      scheduleRender();
    });
  })(); // Execute IIFE to initialize editor

  function getState() {
    return state;
  }

  function destroy() {
    destroyed = true;

    if (animationFrameId) {
      cancelAnimationFrame(animationFrameId);
    }

    if (canvasClickHandler) {
      contentCanvas.removeEventListener("click", canvasClickHandler);
    }

    if (!isTouchDevice()) {
      if (canvasClickHandler) {
        contentCanvas.removeEventListener("mousedown", canvasClickHandler);
        canvasClickHandler = null;
      }

      contentCanvas.removeEventListener("contextmenu", eventsHandler);
      contentCanvas.removeEventListener("mousedown", eventsHandler);
      contentCanvas.removeEventListener("mousemove", eventsHandler);
      contentCanvas.removeEventListener("mouseup", eventsHandler);
      contentCanvas.removeEventListener("pointerdown", eventsHandler);
      contentCanvas.removeEventListener("pointermove", eventsHandler);
      contentCanvas.removeEventListener("pointerup", eventsHandler);
      contentCanvas.removeEventListener("pointercancel", eventsHandler);
      contentCanvas.removeEventListener("wheel", eventsHandler);

      window.removeEventListener("mouseup", windowMouseUpHandler);
      window.removeEventListener("mousemove", windowMouseMoveHandler);
    }

    contentCanvas.removeEventListener("touchstart", touchStartHandler);
    contentCanvas.removeEventListener("touchmove", touchMoveHandler);
    contentCanvas.removeEventListener("touchend", touchEndHandler);
    contentCanvas.removeEventListener("touchcancel", eventsHandler);
    window.removeEventListener("resize", invalidateRectCache);
    window.removeEventListener("scroll", invalidateRectCache, true);

    // Clean up input-surface handlers
    if (hiddenInput) {
      hiddenInput.removeEventListener("input", hiddenInputHandler);
      hiddenInput.removeEventListener("keydown", hiddenInputKeyDownHandler);
      hiddenInput.removeEventListener(
        "compositionstart",
        compositionStartHandler,
      );
      hiddenInput.removeEventListener(
        "compositionupdate",
        compositionUpdateHandler,
      );
      hiddenInput.removeEventListener("compositionend", compositionEndHandler);
      hiddenInput.removeEventListener("copy", copyHandler);
      hiddenInput.removeEventListener("cut", cutHandler);
      hiddenInput.removeEventListener("paste", pasteHandler);
    }

    // Clean up awareness cleanup interval
    clearInterval(awarenessCleanupInterval);
  }

  function updateViewport(newViewport: Partial<ViewportState>) {
    const oldWidth = viewport.width;

    viewport = { ...viewport, ...newViewport };

    // Invalidate cached bounding rect since viewport dimensions changed
    invalidateRectCache();

    // Clear block height cache if width changed (affects text wrapping)
    if (viewport.width !== oldWidth) {
      clearAllBlockCaches(state.document.page.blocks);
      documentHeightDirty = true; // Width change affects text wrapping and height
    }

    // Schedule render for viewport changes
    scheduleRender();
    renderFrame();
  }

  function calculateDocumentHeight(): number {
    // Calculate total document height based on all blocks
    const styles = getEditorStyles(state);
    const maxWidth = viewport.width - 2 * styles.canvas.paddingLeft;
    let totalHeight = styles.canvas.paddingTop;

    const visibleBlocks = state.view.visibleBlocks;
    for (let visibleIdx = 0; visibleIdx < visibleBlocks.length; visibleIdx++) {
      const block = visibleBlocks[visibleIdx];

      // Use getBlockHeight to leverage caching for performance
      const blockHeight = getBlockHeight(
        state.nodes,
        block,
        maxWidth,
        styles,
        visibleIdx === 0,
      );
      totalHeight += blockHeight;
    }

    const documentHeight = totalHeight + styles.canvas.paddingBottom;
    viewport = { ...viewport, documentHeight };
    return documentHeight;
  }

  function setFocus(focused: boolean, shouldClearSelection: boolean = false) {
    const wasFocused = state.view.isFocused;
    state = updateFocus(state, focused);
    if (shouldClearSelection) {
      state = clearSelection(state);
    }
    // Keep DOM focus on the input surface in lockstep with logical focus. Since
    // keyboard input is no longer captured on `window`, the surface must own DOM
    // focus to receive keystrokes/IME. (The 'focus' event re-enters setFocus,
    // but the transition guard below makes that idempotent.)
    if (
      focused &&
      hiddenInput &&
      !state.ui.isReadonlyBase &&
      document.activeElement !== hiddenInput
    ) {
      try {
        hiddenInput.focus({ preventScroll: true });
      } catch {
        // Ignore — focus can throw if the element is detached mid-teardown.
      }
    }
    scheduleRender(); // Schedule render when focus changes
    // Focus is applied here, outside the render-frame diff, so the render loop
    // won't notify subscribers about it. Emit directly on an actual transition
    // — this is what makes editor.on("focus"/"blur") fire (and follows the same
    // direct-notify pattern as undo/selectAll/setMode).
    if (state.view.isFocused !== wasFocused) {
      const currentState = state;
      listeners.forEach((listener) => listener(currentState));
    }
  }

  function setInitialCursor() {
    // Only set cursor if there isn't one already
    if (!state.document.cursor && state.view.visibleBlocks.length > 0) {
      state = createInitialCursorState(state);
      scheduleRender();
    }
  }

  // Force the caret to the document start or end (used by `focus(at)`).
  function setCaret(at: "start" | "end") {
    const visible = state.view.visibleBlocks;
    if (visible.length === 0) return;
    const blocks = state.document.page.blocks;
    const target = at === "start" ? visible[0] : visible[visible.length - 1];
    const blockIndex = blocks.findIndex((b) => b.id === target.id);
    if (blockIndex === -1) return;
    const textIndex =
      at === "start" ? 0 : getBlockTextContent(blocks[blockIndex]).length;
    state = {
      ...state,
      document: {
        ...state.document,
        cursor: { position: { blockIndex, textIndex }, lastUpdate: Date.now() },
        selection: null,
      },
    };
    scheduleRender();
  }

  function getCursorScreenPosition() {
    if (!state.document.cursor) return null;

    const coords = getCursorDocumentCoords(
      state.document.cursor.position,
      state,
      viewport,
      getEditorStyles(state),
    );
    if (!coords) return null;

    return {
      x: coords.x,
      y: coords.y - viewport.scrollY,
      height: coords.height,
    };
  }

  function subscribe(listener: (state: EditorState) => void) {
    listeners.push(listener);
    return () => {
      const index = listeners.indexOf(listener);
      if (index > -1) {
        listeners.splice(index, 1);
      }
    };
  }

  function on(
    event: EditorEvent,
    callback:
      | ((tx: ChangeTransaction) => void)
      | ((state: EditorState) => void),
  ): () => void {
    // "change" rides the dedicated op channel (emitChange) so it can carry the
    // ChangeTransaction { isRemote, ops }, rather than the state-diff path.
    if (event === "change") {
      const cb = callback as (tx: ChangeTransaction) => void;
      changeListeners.push(cb);
      return () => {
        const i = changeListeners.indexOf(cb);
        if (i > -1) changeListeners.splice(i, 1);
      };
    }

    // selectionchange / focus / blur are pure state transitions — classify them
    // by diffing the snapshot captured at subscription time on each notification.
    const cb = callback as (state: EditorState) => void;
    let prev = state;
    return subscribe((next) => {
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
  }

  function getMarkdown(): string {
    return serializeToMarkdown(state.document.page.blocks);
  }

  function setMarkdown(markdown: string): void {
    // Replace the document by diffing current → parsed blocks and emitting CRDT
    // operations (delete the current blocks, insert the new ones). Reuses the
    // snapshot-restore path, so the replace is a single undoable step and is
    // broadcast to peers — not a silent state swap. loadPage always yields a
    // fresh Page (≥1 block), so empty input is handled safely; an identical
    // result produces no ops and is a no-op.
    restoreFromSnapshotMethod(loadPage(markdown).blocks);
  }

  // ── Commands & chaining (Tier B) ────────────────────────────────────────
  // Every command is a pure (state) => CommandResult transform built on the
  // same action functions the keyboard/menu paths use. `commands.X` runs one
  // immediately (its own undo step, broadcast, notify, via executeCommand);
  // `chain()` threads state through several and commits them as ONE undo step.
  type Command = (s: EditorState) => CommandResult;

  // toggleMark dispatch is registry-driven: any togglable mark on the schema
  // can be toggled by name (built-ins + custom). Marks that need extra input
  // (link → url, math → LaTeX) are `togglable: false` and ignored here.
  const toggleMarkCommand =
    (name: MarkName): Command =>
    (s) =>
      toggleFormat(s, name);
  const canToggleMark = (name: MarkName): boolean =>
    state.marks.get(name)?.togglable === true;

  const blockCommand =
    (type: Block["type"]): Command =>
    (s) =>
      convertBlockType(s, type);
  // setBlock accepts the concrete block types plus the convenience "heading",
  // mapped to heading1/2/3 by `attrs.level` (clamped 1–3, the levels that render).
  const resolveBlockType = (
    type: Block["type"] | "heading",
    attrs?: { level?: number },
  ): Block["type"] => {
    if (type === "heading") {
      const level = Math.min(3, Math.max(1, Math.round(attrs?.level ?? 1)));
      return `heading${level}` as Block["type"];
    }
    return type;
  };
  const insertTextCommand =
    (text: string): Command =>
    (s) =>
      insertText(s, text);
  const selectAllCommand: Command = (s) => ({ state: selectAll(s), ops: [] });

  /** Run a single command immediately; returns whether it changed anything. */
  function runCommand(cmd: Command): boolean {
    const prev = state;
    const result = cmd(prev);
    if (result.state === prev && result.ops.length === 0) return false;
    executeCommand(result);
    return true;
  }

  const commands: EditorCommands = {
    toggleMark: (name) =>
      canToggleMark(name) ? runCommand(toggleMarkCommand(name)) : false,
    setBlock: (type, attrs) =>
      runCommand(blockCommand(resolveBlockType(type, attrs))),
    insertText: (text) => runCommand(insertTextCommand(text)),
    selectAll: () => runCommand(selectAllCommand),
    undo: () => {
      const before = state;
      undo();
      return state !== before;
    },
    redo: () => {
      const before = state;
      redo();
      return state !== before;
    },
  };

  function chain(): EditorCommandChain {
    const steps: Command[] = [];
    // Apply queued steps to a working copy; commit (record ONE undo step,
    // broadcast once, notify) only when `commit` is true. canRun() passes false.
    const apply = (commit: boolean): boolean => {
      const prev = state;
      let cur = prev;
      const allOps: Operation[] = [];
      for (const step of steps) {
        const r = step(cur);
        cur = r.state;
        allOps.push(...r.ops);
      }
      const changed = cur !== prev || allOps.length > 0;
      if (!commit || !changed) return changed;
      state =
        allOps.length > 0
          ? recordUndoOps(prev, cur, allOps, state.CRDTbinding.getPeerId())
          : cur;
      if (allOps.length > 0 && broadcastFn) emitLocalOps(allOps);
      scheduleRender();
      const currentState = state;
      listeners.forEach((listener) => listener(currentState));
      return true;
    };
    const builder: EditorCommandChain = {
      toggleMark: (name) => {
        if (canToggleMark(name)) steps.push(toggleMarkCommand(name));
        return builder;
      },
      setBlock: (type, attrs) => {
        steps.push(blockCommand(resolveBlockType(type, attrs)));
        return builder;
      },
      insertText: (text) => {
        steps.push(insertTextCommand(text));
        return builder;
      },
      selectAll: () => {
        steps.push(selectAllCommand);
        return builder;
      },
      run: () => apply(true),
      canRun: () => apply(false),
    };
    return builder;
  }

  function getActiveMarks(): Set<Mark["type"]> {
    const result = new Set<Mark["type"]>();
    const mode = state.ui.activeMarksMode;
    if (mode.type === "explicit") {
      for (const f of mode.formats) result.add(f.type);
      return result;
    }
    // "inherit" mode: reflect the formats on the character before the caret.
    const cursor = state.document.cursor;
    if (!cursor) return result;
    const block = state.document.page.blocks[cursor.position.blockIndex];
    if (!block || block.deleted) return result;
    const formats = getFormatsAtPosition(block, cursor.position.textIndex);
    if (formats) for (const f of formats) result.add(f.type);
    return result;
  }

  function isSelectionEmpty(): boolean {
    const sel = state.document.selection;
    return !sel || sel.isCollapsed;
  }

  function executeSlashCommand(command: SlashCommand) {
    if (state.ui.activeMenu.type === "slashCommand" && state.document.cursor) {
      state = state;
      const result = applySlashCommand(state, command);
      executeCommand(result);
    }
  }

  async function copy(): Promise<boolean> {
    const success = await copySelectionToClipboard(state);
    state = closeContextMenu(state);
    scheduleRender();
    return success;
  }

  async function cut(): Promise<boolean> {
    const result = await cutSelectionToClipboard(state);
    if (result.success && result.result) {
      executeCommand(result.result);
      state = closeContextMenu(state);
      scheduleRender();
      return true;
    }
    state = closeContextMenu(state);
    scheduleRender();
    return false;
  }

  async function paste(): Promise<boolean> {
    const result = await pasteFromSystemClipboard(state);
    if (result) {
      executeCommand(result);
      state = closeContextMenu(state);
      scheduleRender();
      return true;
    }
    state = closeContextMenu(state);
    scheduleRender();
    return false;
  }

  function undo() {
    const result = undoState(state);
    if (result.state !== state) {
      state = result.state;
      scheduleRender();
      listeners.forEach((listener) => listener(result.state));
      // Broadcast inverse operations to sync engine
      if (result.ops.length > 0 && broadcastFn) {
        emitLocalOps(result.ops);
      }
    }
  }

  function redo() {
    const result = redoState(state);
    if (result.state !== state) {
      state = result.state;
      scheduleRender();
      listeners.forEach((listener) => listener(result.state));
      // Broadcast redo operations to sync engine
      if (result.ops.length > 0 && broadcastFn) {
        emitLocalOps(result.ops);
      }
    }
  }

  function updateLink(
    blockIndex: number,
    startIndex: number,
    endIndex: number,
    newUrl: string,
    newText: string,
  ) {
    state = state;
    const result = updateLinkInBlock(
      state,
      blockIndex,
      startIndex,
      endIndex,
      newUrl,
      newText,
    );
    executeCommand(result);
  }

  function clearLink(blockIndex: number, startIndex: number, endIndex: number) {
    state = state;
    const result = clearLinkInBlock(state, blockIndex, startIndex, endIndex);
    executeCommand(result);
  }

  function createLink(url: string, text: string) {
    if (!state.document.selection || state.document.selection.isCollapsed) {
      return; // Need a selection to create a link
    }

    state = state;

    const range = getSelectionRange(state);
    if (!range) return;

    const { start, end } = range;

    // Only support single-block link creation for now
    if (start.blockIndex !== end.blockIndex) {
      return;
    }

    const block = state.document.page.blocks[start.blockIndex];
    if (!block || block.deleted || !isTextualBlock(block)) {
      return;
    }

    const ops: Operation[] = [];

    // Delete the selected text first
    const { newPage: p1, op: deleteOp } = deleteCharsInRange(
      state.document.page,
      block.id,
      start.textIndex,
      end.textIndex,
      state.CRDTbinding,
    );
    ops.push(deleteOp);

    // Insert the new link text
    const { newPage: p2, op: insertOp } = insertCharsAtPosition(
      p1,
      block.id,
      start.textIndex,
      text,
      state.CRDTbinding,
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
      state.CRDTbinding,
    );
    ops.push(formatOp);

    invalidateBlockCache(p3.blocks[start.blockIndex]);

    const newState = {
      ...state,
      document: { ...state.document, page: p3 },
    };

    // Clear selection and move cursor to end of inserted link
    const stateWithClearedSelection = clearSelection(newState);
    const finalState = moveCursorToPosition(
      stateWithClearedSelection,
      start.blockIndex,
      start.textIndex + text.length,
    );

    executeCommand({ state: finalState, ops });
  }

  function clearSelectionMethod() {
    state = clearSelection(state);
    // Also clear cursor to remove all visual indicators
    state = updateCursor(state, null);
    const currentState = state;
    scheduleRender();
    listeners.forEach((listener) => listener(currentState));
  }

  function setMode(mode: "edit" | "select" | "locked") {
    state = updateMode(state, mode);

    // Stop momentum when entering locked mode
    if (mode === "locked") {
      state = {
        ...state,
        view: {
          ...state.view,
          momentum: {
            velocity: 0,
            lastTime: Date.now(),
            isActive: false,
          },
        },
      };
    }

    const currentState = state;
    scheduleRender();
    listeners.forEach((listener) => listener(currentState));
  }

  function restoreCursorAndSelection(
    cursor: EditorState["document"]["cursor"],
    selection: EditorState["document"]["selection"],
  ) {
    state = updateMode(
      updateSelection(
        updateCursor(state, cursor?.position || null),
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
    const currentState = state;
    scheduleRender();
    listeners.forEach((listener) => listener(currentState));
  }

  function setNodeAttrs(
    blockId: string,
    attrs: Record<string, unknown>,
  ): boolean {
    const blocks = state.document.page.blocks;
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
        id: state.CRDTbinding.nextId(),
        clock: state.CRDTbinding.getClock(),
        pageId: state.CRDTbinding.pageId,
        blockId,
        field,
        value: attrs[field],
      }),
    );

    executeCommand({
      state: {
        ...state,
        document: {
          ...state.document,
          page: { ...state.document.page, blocks: newBlocks },
        },
      },
      ops,
    });
    return true;
  }

  function setImageUploadStatus(
    status: "idle" | "uploading" | "complete" | "error",
  ): void {
    // Transient canvas chrome (spinner / error) painted over the active
    // image-upload menu's block — not document content, so no CRDT op. No-op
    // unless an image-upload menu is open.
    if (state.ui.activeMenu.type !== "imageUpload") return;
    state = {
      ...state,
      ui: {
        ...state.ui,
        activeMenu: {
          ...state.ui.activeMenu,
          // The field is optional; undefined means "idle".
          uploadStatus: status === "idle" ? undefined : status,
        },
      },
    };
    const currentState = state;
    scheduleRender();
    listeners.forEach((listener) => listener(currentState));
  }

  function deleteNode(blockId: string): boolean {
    const blocks = state.document.page.blocks;
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
        id: state.CRDTbinding.nextId(),
        clock: state.CRDTbinding.getClock(),
        pageId: state.CRDTbinding.pageId,
        blockId,
      },
    ];

    // If that was the last visible block, keep the document editable by
    // inserting an empty paragraph in its place.
    const visibleCount = newBlocks.filter((b) => !b.deleted).length;
    if (visibleCount === 0) {
      const newParagraphBlockId = `b-${state.CRDTbinding.nextId()}`;
      newBlocks.push({
        id: newParagraphBlockId,
        type: "paragraph",
        charRuns: [],
        formats: [],
      });
      ops.push({
        op: "block_insert",
        id: state.CRDTbinding.nextId(),
        clock: state.CRDTbinding.getClock(),
        pageId: state.CRDTbinding.pageId,
        afterBlockId: null,
        blockId: newParagraphBlockId,
        blockType: "paragraph",
      });
    }

    executeCommand({
      state: {
        ...state,
        document: {
          ...state.document,
          page: { ...state.document.page, blocks: newBlocks },
        },
      },
      ops,
    });
    return true;
  }

  function openImageUploadMenu(
    blockIndex: number,
    x: number,
    y: number,
    _existingUrl?: string,
    _existingAlt?: string,
  ) {
    state = setActiveMenu(state, {
      type: "imageUpload",
      blockIndex,
      x,
      y,
    });

    const currentState = state;
    scheduleRender();
    listeners.forEach((listener) => listener(currentState));
  }

  function openMathEditMenu(blockIndex: number, x: number, y: number) {
    state = setActiveMenu(state, {
      type: "mathEdit",
      blockIndex,
      x,
      y,
    });

    const currentState = state;
    scheduleRender();
    listeners.forEach((listener) => listener(currentState));
  }

  function openInlineMathEditMenu(
    blockIndex: number,
    startIndex: number,
    endIndex: number,
    latex: string,
    x: number,
    y: number,
  ) {
    state = setActiveMenu(state, {
      type: "inlineMathEdit",
      blockIndex,
      startIndex,
      endIndex,
      latex,
      x,
      y,
    });

    const currentState = state;
    scheduleRender();
    listeners.forEach((listener) => listener(currentState));
  }

  function replaceInlineRange(
    blockId: string,
    start: number,
    end: number,
    text: string,
    mark?: Mark,
  ): boolean {
    const blocks = state.document.page.blocks;
    const blockIndex = blocks.findIndex((b) => b.id === blockId);
    const block = blocks[blockIndex];
    if (!block || block.deleted || !isTextualBlock(block)) return false;
    // An empty replacement is a deletion of the range.
    if (text.length === 0) return deleteInlineRange(blockId, start, end);

    const ops: Operation[] = [];

    // Replace the chars in [start, end) with `text`, then (optionally) apply the
    // mark to the freshly inserted run.
    const { newPage: p1, op: deleteOp } = deleteCharsInRange(
      state.document.page,
      blockId,
      start,
      end,
      state.CRDTbinding,
    );
    ops.push(deleteOp);

    const { newPage: p2, op: insertOp } = insertCharsAtPosition(
      p1,
      blockId,
      start,
      text,
      state.CRDTbinding,
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
        state.CRDTbinding,
      );
      ops.push(formatOp);
      page = p3;
    }

    invalidateBlockCache(page.blocks[blockIndex]);

    executeCommand({
      state: { ...state, document: { ...state.document, page } },
      ops,
    });
    return true;
  }

  function deleteInlineRange(
    blockId: string,
    start: number,
    end: number,
  ): boolean {
    const blocks = state.document.page.blocks;
    const blockIndex = blocks.findIndex((b) => b.id === blockId);
    const block = blocks[blockIndex];
    if (!block || block.deleted || !isTextualBlock(block)) return false;
    if (end <= start) return false;

    const { newPage, op } = deleteCharsInRange(
      state.document.page,
      blockId,
      start,
      end,
      state.CRDTbinding,
    );
    invalidateBlockCache(newPage.blocks[blockIndex]);

    // Place the caret where the deleted range began.
    const movedState = moveCursorToPosition(
      { ...state, document: { ...state.document, page: newPage } },
      blockIndex,
      start,
    );

    executeCommand({ state: movedState, ops: [op] });
    return true;
  }

  function exitInlineMathMethod(
    blockIndex: number,
    startIndex: number,
    endIndex: number,
    direction: "left" | "right",
  ) {
    state = closeActiveMenu(state);

    // Place the caret on the side we're exiting toward, then step out one
    // position so snapInlineMathPosition doesn't pull us back into the chip.
    if (direction === "left") {
      state = moveCursorToPosition(state, blockIndex, startIndex);
      state = moveCursorLeft(state);
    } else {
      state = moveCursorToPosition(state, blockIndex, endIndex);
      state = moveCursorRight(state);
    }

    const currentState = state;
    scheduleRender();
    listeners.forEach((listener) => listener(currentState));
  }

  function closeActiveMenuMethod() {
    state = closeActiveMenu(state);
    const currentState = state;
    scheduleRender();
    listeners.forEach((listener) => listener(currentState));
  }

  function setWindowFocused(focused: boolean) {
    if (state.view.isWindowFocused === focused) return;
    state = updateWindowFocused(state, focused);
    // Selection color depends on window focus; scheduleRender marks the content
    // layer dirty so it repaints with the focused/unfocused selection style.
    scheduleRender();
  }

  function updatePageFromSync(
    page: Page,
    remoteOps: readonly Operation[] = [],
  ) {
    // Update the page from CRDT sync while preserving cursor/selection
    // This is called when remote operations are applied

    // Clear all block caches since page structure may have changed
    clearAllBlockCaches(page.blocks);

    // Compute visible blocks from the NEW page, not the stale view state
    const visibleBlocks = getVisibleBlocks(page);
    state.view.visibleBlocks = visibleBlocks;

    // Validate and adjust cursor position if needed
    let cursor = state.document.cursor;
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
    let selection = state.document.selection;
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
    state = {
      ...state,
      document: {
        ...state.document,
        page,
        cursor,
        selection,
      },
    };

    // Mark document height as dirty since page content changed
    documentHeightDirty = true;

    // Re-render
    const currentState = state;
    scheduleRender();
    listeners.forEach((listener) => listener(currentState));
    // Fire the change event as a remote-applied edit (isRemote: true).
    emitChange(remoteOps, true);
  }

  /**
   * Restore from snapshot by generating operations.
   * This is for user-initiated restores - generates and broadcasts ops to peers.
   */
  function restoreFromSnapshotMethod(newBlocks: Block[]) {
    const currentPage = state.document.page;
    const prevState = state;

    // Generate operations using the snapshot-diff utility
    const ops = generateRestoreOperations({
      currentBlocks: state.view.visibleBlocks,
      newBlocks,
      pageId: state.CRDTbinding.pageId,
      peerId: state.CRDTbinding.getPeerId(),
      nextId: state.CRDTbinding.nextId,
      getClock: state.CRDTbinding.getClock,
    });

    if (ops.length === 0) return;

    // Apply operations to local state
    const newPage = applyOps(currentPage, ops);

    // Clear all block caches
    clearAllBlockCaches(newPage.blocks);

    // Update visibleBlocks from the new page so cursor targets a valid block
    state.view.visibleBlocks = getVisibleBlocks(newPage);
    const newVisibleBlocks = state.view.visibleBlocks;

    // Reset cursor to beginning of first visible block
    state = {
      ...state,
      document: {
        ...state.document,
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
    state = recordUndoOps(prevState, state, ops, state.CRDTbinding.getPeerId());

    // Broadcast operations to peers
    if (broadcastFn) {
      emitLocalOps(ops);
    }

    // Mark document height as dirty and reset scroll to top
    documentHeightDirty = true;
    viewport = { ...viewport, scrollY: 0 };

    // Re-render and notify listeners
    const currentState = state;
    scheduleRender();
    listeners.forEach((listener) => listener(currentState));
  }

  function setBroadcastMethod(fn: ((ops: Operation[]) => void) | null) {
    broadcastFn = fn;
  }

  function setAwarenessBroadcastMethod(
    fn: AwarenessBroadcastFn | null,
    user?: AwarenessUser,
  ) {
    awarenessBroadcastFn = fn;
    if (user) {
      localUser = user;
    }
    // Broadcast initial awareness state when connected
    if (fn && localUser) {
      broadcastAwareness();
    }
  }

  function setRemoteAwarenessMethod(
    peerId: string,
    awarenessState: AwarenessState | null,
  ) {
    if (awarenessState === null) {
      remoteAwareness.delete(peerId);
    } else {
      remoteAwareness.set(peerId, awarenessState);
    }
    // Trigger re-render to show updated remote cursors
    scheduleRender();
  }

  function getRemoteAwarenessMethod(): Map<string, AwarenessState> {
    return getActiveRemoteAwareness();
  }

  function setTheme(patch: EditorTheme) {
    const nextTheme = mergeTheme(state.theme, patch);
    state = {
      ...state,
      theme: nextTheme,
      resolvedStyles: resolveTheme(nextTheme),
      resolvedNodeStrings: resolveNodeStrings(state.nodes, nextTheme),
    };
    // Block layout is cached keyed by content/width; text metrics depend on the
    // theme's font sizes/weights/family, so invalidate so blocks re-measure and
    // the document height recomputes with the new styles.
    clearAllBlockCaches(state.document.page.blocks);
    documentHeightDirty = true;
    scheduleRender();
  }

  return {
    getState,
    destroy,
    updateViewport,
    setFocus,
    setInitialCursor,
    setCaret,
    getCursorScreenPosition,
    get state(): EditorStateSnapshot {
      return {
        selection: { empty: isSelectionEmpty() },
        activeMarks: getActiveMarks(),
      };
    },
    subscribe,
    on,
    // The bus methods are closures (no `this`), so exposing them directly is
    // safe — the bus reference is stable across state updates.
    registerCommand: state.commandBus.register,
    dispatch: state.commandBus.dispatch,
    getMarkdown,
    setMarkdown,
    commands,
    chain,
    getActiveMarks,
    isSelectionEmpty,
    executeSlashCommand,
    copy,
    cut,
    paste,
    updateLink,
    clearLink,
    createLink,
    clearSelection: clearSelectionMethod,
    setMode,
    restoreCursorAndSelection,
    collectOverlays: () =>
      collectOverlays(state, viewport, getEditorStyles(state)),
    setTheme,
    setNodeAttrs,
    deleteNode,
    replaceInlineRange,
    deleteInlineRange,
    openImageUploadMenu,
    setImageUploadStatus,
    openMathEditMenu,
    openInlineMathEditMenu,
    exitInlineMath: exitInlineMathMethod,
    closeActiveMenu: closeActiveMenuMethod,
    setWindowFocused,
    updatePageFromSync,
    restoreFromSnapshot: restoreFromSnapshotMethod,
    setBroadcast: setBroadcastMethod,
    setAwarenessBroadcast: setAwarenessBroadcastMethod,
    setRemoteAwareness: setRemoteAwarenessMethod,
    getRemoteAwareness: getRemoteAwarenessMethod,
    onImagePaste: (
      callback: ((file: File, blockIndex: number) => void) | null,
    ) => {
      onImagePasteCallback = callback;
    },
    onScroll: (callback: ((scrollY: number) => void) | null) => {
      onScrollCallback = callback;
    },
    getScrollY: () => viewport.scrollY,
    setSearchHighlights: (
      highlights: {
        blockIndex: number;
        startIndex: number;
        endIndex: number;
      }[],
      activeIndex: number,
    ) => {
      state = {
        ...state,
        ui: { ...state.ui, search: { highlights, activeIndex } },
      };
      scheduleRender();
    },
    clearSearchHighlights: () => {
      state = {
        ...state,
        ui: { ...state.ui, search: { highlights: [], activeIndex: -1 } },
      };
      scheduleRender();
    },
    scrollToPosition: (position: { blockIndex: number; textIndex: number }) => {
      const newScrollY = scrollToMakeCursorVisible(position, state, viewport);
      if (newScrollY !== null) {
        viewport = { ...viewport, scrollY: newScrollY };
        scheduleRender();
      }
    },
  };
}
