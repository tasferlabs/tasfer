import {
  copySelectionToClipboard,
  cutSelectionToClipboard,
  pasteFromNativeClipboardAPI,
} from "../actions/clipboard";
import {
  applySlashCommand,
  clearLinkInBlock,
  convertBlockType,
  getSelectionRange,
  selectAll,
  toggleBold,
  toggleCode,
  toggleItalic,
  toggleStrikethrough,
  updateLinkInBlock,
} from "../actions/commands";
import { handleEvents } from "../events/events";
import { isInLongPressMode } from "../events/touchEvents";
import { onFontFamilyChange, onFontsReady } from "../fonts";
import {
  clearAllBlockCaches,
  clearSearchHighlights as clearRendererSearchHighlights,
  getBlockHeight,
  invalidateBlockCache,
  renderCursorLayer,
  renderPage,
  setRequestRedraw,
  setSearchHighlights as setRendererSearchHighlights,
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
import type { Block, Page } from "../serlization/loadPage";
import { isTextualBlock } from "../serlization/loadPage";
import { serializeToMarkdown } from "../serlization/serializer";
import type {
  CommandResult,
  EditorState,
  SlashCommand,
  ViewportState,
} from "../state-types";
import {
  closeActiveMenu,
  closeContextMenu,
  createInitialCursorState,
  getBlockTextContent,
  isTouchDevice,
  setActiveMenu,
  updateMode,
  updatePhysicalKeyboardState,
} from "../state-utils";
import { getEditorStyles } from "../styles";
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
import {
  deleteCharsInRange,
  formatCharsInRange,
  insertCharsAtPosition,
} from "../sync/crdt-utils";
import type {
  BlockDelete,
  BlockInsert,
  HLC,
  Operation,
} from "../sync/crdt-types";
import { recordUndoOps, redoState, undoState } from "../sync/crdt-undo";
import { applyOps } from "../sync/reducer";
import { generateRestoreOperations } from "../sync/snapshot-diff";
import { createBlockSet, getVisibleBlocks } from "../sync/sync";
import { updateSelection } from "../updateSelection";
import type { CanvasLayers } from "./layers";

export interface Editor {
  getState: () => EditorState | null;
  destroy: () => void;
  updateViewport: (viewport: Partial<ViewportState>) => void;
  getDocumentHeight: () => number;
  setFocus: (focused: boolean, shouldClearSelection?: boolean) => void;
  setInitialCursor: () => void;
  setPhysicalKeyboard: (hasPhysicalKeyboard: boolean) => void;
  getCursorScreenPosition: () => {
    x: number;
    y: number;
    height: number;
  } | null;
  subscribe: (listener: (state: EditorState) => void) => () => void;
  executeSlashCommand: (command: SlashCommand) => void;
  copy: () => Promise<boolean>;
  cut: () => Promise<boolean>;
  paste: () => Promise<boolean>;
  undo: () => void;
  redo: () => void;
  selectAll: () => void;
  toggleBold: () => void;
  toggleItalic: () => void;
  toggleCode: () => void;
  toggleStrikethrough: () => void;
  setBlockType: (type: Block["type"]) => void;
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
  forceRender: () => void;
  updateImageBlock: (
    blockIndex: number,
    updates: {
      url?: string;
      alt?: string;
    },
    uploadStatus?: "uploading" | "complete" | "error",
  ) => void;
  deleteImageBlock: (blockIndex: number) => void;
  openImageUploadMenu: (
    blockIndex: number,
    x: number,
    y: number,
    existingUrl?: string,
    existingAlt?: string,
  ) => void;
  updateMathBlock: (
    blockIndex: number,
    updates: { latex?: string; displayMode?: boolean },
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
  updateInlineMath: (
    blockIndex: number,
    startIndex: number,
    endIndex: number,
    newLatex: string,
  ) => void;
  deleteInlineMath: (
    blockIndex: number,
    startIndex: number,
    endIndex: number,
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
  /** Update page content from CRDT sync (remote operations) */
  updatePageFromSync: (page: Page) => void;
  /** Restore from snapshot - generates and broadcasts operations */
  restoreFromSnapshot: (blocks: Block[]) => void;
  /** Apply remote operations to the current page state */
  applyRemoteOperations: (ops: Operation[]) => void;
  /**
   * Advance this editor's CRDT clock to be at least as recent as `clock`.
   * Call after loading persisted ops or applying remote ops so subsequent
   * local operations get HLC values that respect causality.
   */
  advanceClock: (clock: HLC) => void;
  /**
   * Bump this editor's CRDT id counter so the next generated id has
   * counter > n. Keeps RGA sibling ordering correct across sessions/peers.
   */
  advanceIdCounter: (n: number) => void;
  /** Set broadcast function for sending operations to peers */
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
  hiddenInput?: HTMLInputElement,
): Editor {
  // Extract contexts from layers
  const contentCtx = layers.content.ctx;
  const cursorCtx = layers.cursor.ctx;
  const contentCanvas = layers.content.canvas;

  let state: EditorState = initialState;
  let viewport = viewportProp;
  let animationFrameId: number | null = null;
  let documentHeight = 0;
  let visibility = {
    start: 0,
    end: 0,
  };

  let isRendering = false;

  // Broadcast function for sending operations to peers
  let broadcastFn: ((ops: Operation[]) => void) | null = null;

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
      broadcastFn(ops);
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
          broadcastFn(handleEventsResult.ops);
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
        ? isCursorBlinking(state.document.cursor, getEditorStyles())
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
            state,
            viewport,
            getEditorStyles(),
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

    // For paste events, extract clipboard data immediately since it gets detached
    if (e.type === "paste" && e instanceof ClipboardEvent) {
      e.preventDefault();
      const clipboardData = e.clipboardData;
      if (clipboardData) {
        // Check for image files in clipboard items (e.g. pasted screenshots)
        let imageFile: File | null = null;
        for (let i = 0; i < clipboardData.items.length; i++) {
          const item = clipboardData.items[i];
          if (item.type.startsWith("image/")) {
            imageFile = item.getAsFile();
            if (imageFile) break;
          }
        }

        pendingClipboardData = {
          html: clipboardData.getData("text/html") || "",
          text:
            clipboardData.getData("text/plain") ||
            clipboardData.getData("text") ||
            "",
          imageFile,
        };
      }
    }

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
    const wasLongPress = isInLongPressMode();

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

  // Handle input from hidden input element (mobile keyboard)
  function hiddenInputHandler(e: Event) {
    if (!hiddenInput) return;

    // Block input in readonly or locked mode
    if (state.ui.mode === "readonly" || state.ui.mode === "locked") {
      hiddenInput.value = " ";
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
      // Keep a dummy space to ensure Android fires deleteContentBackward events
      hiddenInput.value = " ";
      return;
    }

    // Handle special input types
    if (inputEvent.inputType === "insertLineBreak") {
      const enterEvent = new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      });
      eventsQueue.push(enterEvent);
      scheduleRender();
      hiddenInput.value = " ";
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
      hiddenInput.value = " ";
      return;
    }

    // Keep a dummy space for any other input types
    hiddenInput.value = " ";
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
        if (hiddenInput) {
          hiddenInput.value = " ";
        }
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
            if (hiddenInput) {
              hiddenInput.value = " ";
            }
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
            if (hiddenInput) {
              hiddenInput.value = " ";
            }
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
      hiddenInput.value = " ";
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

      const handledShortcuts = ["KeyZ", "KeyY", "KeyA", "KeyC", "KeyX", "KeyB"];
      if (handledShortcuts.includes(e.code)) {
        // For editor shortcuts, forward to events queue and stop propagation
        // to prevent window listener from also processing it
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

    // Keep a dummy space after composition ends
    hiddenInput.value = " ";
  }

  // Click handler for focusing input (stored for cleanup)
  let canvasClickHandler: (() => void) | null = null;

  // Handler to invalidate cached rect when canvas position might change
  const invalidateRectCache = () => {
    rectNeedsUpdate = true;
  };

  // Initialize the editor and start the render loop
  (() => {
    setRequestRedraw(scheduleRender);
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
    window.addEventListener("keydown", eventsHandler);
    window.addEventListener("paste", eventsHandler);

    // Invalidate rect cache when canvas position might change
    window.addEventListener("resize", invalidateRectCache);
    window.addEventListener("scroll", invalidateRectCache, true);

    // Set up hidden input handlers for mobile keyboard support
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

      // Ensure input is focusable (already set in mount.ts, but ensure it's correct)
      hiddenInput.setAttribute("tabindex", "0");
    }

    // Register font change callback to invalidate caches when font changes
    const handleFontChange = () => {
      // Clear all block caches since measurements will change with new font
      clearAllBlockCaches(state.document.page.blocks);
      // Trigger a re-render with the new font
      scheduleRender();
    };
    onFontFamilyChange(handleFontChange);

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
    if (animationFrameId) {
      cancelAnimationFrame(animationFrameId);
    }

    setRequestRedraw(null);

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
    window.removeEventListener("keydown", eventsHandler);
    window.removeEventListener("paste", eventsHandler);
    window.removeEventListener("resize", invalidateRectCache);
    window.removeEventListener("scroll", invalidateRectCache, true);

    // Unregister font change callback
    onFontFamilyChange(() => {});

    // Clean up hidden input handlers
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
    const styles = getEditorStyles();
    const maxWidth = viewport.width - 2 * styles.canvas.paddingLeft;
    let totalHeight = styles.canvas.paddingTop;

    const visibleBlocks = state.view.visibleBlocks;
    for (let visibleIdx = 0; visibleIdx < visibleBlocks.length; visibleIdx++) {
      const block = visibleBlocks[visibleIdx];

      // Use getBlockHeight to leverage caching for performance
      const blockHeight = getBlockHeight(
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

  function getDocumentHeight(): number {
    // Return cached height, recalculating only if dirty
    if (documentHeightDirty) {
      cachedDocumentHeight = calculateDocumentHeight();
      documentHeightDirty = false;
    }
    return cachedDocumentHeight;
  }

  function setFocus(focused: boolean, shouldClearSelection: boolean = false) {
    state = updateFocus(state, focused);
    if (shouldClearSelection) {
      state = clearSelection(state);
    }
    scheduleRender(); // Schedule render when focus changes
  }

  function setInitialCursor() {
    // Only set cursor if there isn't one already
    if (!state.document.cursor && state.view.visibleBlocks.length > 0) {
      state = createInitialCursorState(state);
      scheduleRender();
    }
  }

  function getCursorScreenPosition() {
    if (!state.document.cursor) return null;

    const coords = getCursorDocumentCoords(
      state.document.cursor.position,
      state,
      viewport,
      getEditorStyles(),
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
    const result = await pasteFromNativeClipboardAPI(state);
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
        broadcastFn(result.ops);
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
        broadcastFn(result.ops);
      }
    }
  }

  function selectAllMethod() {
    state = selectAll(state);
    state = closeContextMenu(state);
    const currentState = state;
    scheduleRender();
    listeners.forEach((listener) => listener(currentState));
  }

  function toggleBoldMethod() {
    const hasSelection =
      state.document.selection && !state.document.selection.isCollapsed;
    const result = toggleBold(hasSelection ? state : state);
    executeCommand(result);
  }

  function toggleItalicMethod() {
    const hasSelection =
      state.document.selection && !state.document.selection.isCollapsed;
    const result = toggleItalic(hasSelection ? state : state);
    executeCommand(result);
  }

  function toggleCodeMethod() {
    const hasSelection =
      state.document.selection && !state.document.selection.isCollapsed;
    const result = toggleCode(hasSelection ? state : state);
    executeCommand(result);
  }

  function toggleStrikethroughMethod() {
    const hasSelection =
      state.document.selection && !state.document.selection.isCollapsed;
    const result = toggleStrikethrough(hasSelection ? state : state);
    executeCommand(result);
  }

  function setBlockType(type: Block["type"]) {
    if (!state.document.cursor) return;
    state = state;
    const result = convertBlockType(state, type);
    executeCommand(result);
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
    const { newPage: p3, op: formatOp } = formatCharsInRange(
      p2,
      block.id,
      start.textIndex,
      start.textIndex + text.length,
      { type: "link", url },
      url,
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

  function updateImageBlock(
    blockIndex: number,
    updates: {
      url?: string;
      alt?: string;
    },
    uploadStatus?: "uploading" | "complete" | "error",
  ) {
    const block = state.document.page.blocks[blockIndex];

    if (!block || block.deleted || block.type !== "image") {
      console.error("Attempted to update non-image-cover block as image cover");
      return;
    }

    const updatedBlock = {
      ...block,
      ...updates,
    };

    // Invalidate cache when image URL changes (height changes from placeholder to full)
    invalidateBlockCache(updatedBlock);

    const newBlocks = [...state.document.page.blocks];
    newBlocks[blockIndex] = updatedBlock;

    // Update UI state with upload status if provided
    let newUIState = state.ui;
    if (
      uploadStatus !== undefined &&
      state.ui.activeMenu.type === "imageUpload"
    ) {
      newUIState = {
        ...state.ui,
        activeMenu: {
          ...state.ui.activeMenu,
          uploadStatus,
        },
      };
    }

    // Create CRDT operations for image property updates. Use the typed
    // createBlockSet helper so the field name + value are checked against
    // the image block's registered field schema at compile time.
    const ops: Operation[] = [];
    const blockId = block.id;

    if (updates.url !== undefined) {
      ops.push(
        createBlockSet<"image", "url">(
          blockId,
          "url",
          updates.url,
          state.CRDTbinding,
        ),
      );
    }
    if (updates.alt !== undefined) {
      ops.push(
        createBlockSet<"image", "alt">(
          blockId,
          "alt",
          updates.alt,
          state.CRDTbinding,
        ),
      );
    }

    const prevState = state;

    state = {
      ...state,
      ui: newUIState,
      document: {
        ...state.document,
        page: { ...state.document.page, blocks: newBlocks },
      },
    };

    // Record to undo stack
    if (ops.length > 0) {
      state = recordUndoOps(
        prevState,
        state,
        ops,
        state.CRDTbinding.getPeerId(),
      );
    }

    // Broadcast operations
    if (ops.length > 0 && broadcastFn) {
      broadcastFn(ops);
    }

    const currentState = state;
    scheduleRender();
    listeners.forEach((listener) => listener(currentState));
  }

  function deleteImageBlockMethod(blockIndex: number) {
    const block = state.document.page.blocks[blockIndex];

    if (
      !block ||
      block.deleted ||
      (block.type !== "image" && block.type !== "math")
    ) {
      console.error("Attempted to delete non-visual block");
      return;
    }

    // Get block ID before deletion
    const blockId = block.id;

    const prevState = state;

    // Tombstone the block (mark as deleted) instead of splicing it out, so
    // undo can locate it in state to compute the inverse block_insert.
    const newBlocks = [...state.document.page.blocks];
    newBlocks[blockIndex] = { ...block, deleted: true };

    // Create CRDT operations
    const ops: Operation[] = [];

    // Delete the image block
    const deleteOp: BlockDelete = {
      op: "block_delete",
      id: state.CRDTbinding.nextId(),
      clock: state.CRDTbinding.getClock(),
      pageId: state.CRDTbinding.pageId,
      blockId,
    };
    ops.push(deleteOp);

    // If this was the only visible block, add an empty paragraph
    const visibleCount = newBlocks.filter((b) => !b.deleted).length;
    let newParagraphBlockId: string | null = null;
    if (visibleCount === 0) {
      newParagraphBlockId = `b-${state.CRDTbinding.nextId()}`;
      newBlocks.push({
        id: newParagraphBlockId,
        type: "paragraph",
        charRuns: [],
        formats: [],
      });

      // Insert new paragraph block
      const insertOp: BlockInsert = {
        op: "block_insert",
        id: state.CRDTbinding.nextId(),
        clock: state.CRDTbinding.getClock(),
        pageId: state.CRDTbinding.pageId,
        afterBlockId: null,
        blockId: newParagraphBlockId,
        blockType: "paragraph",
      };
      ops.push(insertOp);
    }

    state = {
      ...state,
      document: {
        ...state.document,
        page: { ...state.document.page, blocks: newBlocks },
      },
    };

    // Record to undo stack
    if (ops.length > 0) {
      state = recordUndoOps(
        prevState,
        state,
        ops,
        state.CRDTbinding.getPeerId(),
      );
    }

    // Broadcast operations
    if (ops.length > 0 && broadcastFn) {
      broadcastFn(ops);
    }

    const currentState = state;
    scheduleRender();
    listeners.forEach((listener) => listener(currentState));
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

  function updateMathBlock(
    blockIndex: number,
    updates: { latex?: string; displayMode?: boolean },
  ) {
    const block = state.document.page.blocks[blockIndex];
    if (!block || block.deleted || block.type !== "math") {
      return;
    }

    const prevState = state;

    const updatedBlock = { ...block, ...updates };
    invalidateBlockCache(updatedBlock);

    const newBlocks = [...state.document.page.blocks];
    newBlocks[blockIndex] = updatedBlock;

    // Use the typed createBlockSet helper so the field name + value are
    // checked against the math block's registered field schema at compile
    // time.
    const ops: Operation[] = [];
    const blockId = block.id;

    if (updates.latex !== undefined) {
      ops.push(
        createBlockSet<"math", "latex">(
          blockId,
          "latex",
          updates.latex,
          state.CRDTbinding,
        ),
      );
    }
    if (updates.displayMode !== undefined) {
      ops.push(
        createBlockSet<"math", "displayMode">(
          blockId,
          "displayMode",
          updates.displayMode,
          state.CRDTbinding,
        ),
      );
    }

    state = {
      ...state,
      document: {
        ...state.document,
        page: { ...state.document.page, blocks: newBlocks },
      },
    };

    // Record to undo stack
    if (ops.length > 0) {
      state = recordUndoOps(
        prevState,
        state,
        ops,
        state.CRDTbinding.getPeerId(),
      );
    }

    if (ops.length > 0 && broadcastFn) {
      broadcastFn(ops);
    }

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

  function updateInlineMathMethod(
    blockIndex: number,
    startIndex: number,
    endIndex: number,
    newLatex: string,
  ) {
    const block = state.document.page.blocks[blockIndex];
    if (!block || block.deleted || !isTextualBlock(block)) return;
    if (newLatex.length === 0) {
      // Empty latex is treated as a delete
      deleteInlineMathMethod(blockIndex, startIndex, endIndex);
      return;
    }

    const prevState = state;
    const ops: Operation[] = [];
    const blockId = block.id;

    // Replace the existing chars in [startIndex, endIndex) with the new LaTeX,
    // then re-apply the math format to the freshly inserted chars.
    const { newPage: p1, op: deleteOp } = deleteCharsInRange(
      state.document.page,
      blockId,
      startIndex,
      endIndex,
      state.CRDTbinding,
    );
    ops.push(deleteOp);

    const { newPage: p2, op: insertOp } = insertCharsAtPosition(
      p1,
      blockId,
      startIndex,
      newLatex,
      state.CRDTbinding,
    );
    ops.push(insertOp);

    const { newPage: p3, op: formatOp } = formatCharsInRange(
      p2,
      blockId,
      startIndex,
      startIndex + newLatex.length,
      { type: "math" },
      true,
      state.CRDTbinding,
    );
    ops.push(formatOp);

    invalidateBlockCache(p3.blocks[blockIndex]);

    state = {
      ...state,
      document: { ...state.document, page: p3 },
    };

    if (ops.length > 0) {
      state = recordUndoOps(
        prevState,
        state,
        ops,
        state.CRDTbinding.getPeerId(),
      );
    }

    if (ops.length > 0 && broadcastFn) {
      broadcastFn(ops);
    }

    const currentState = state;
    scheduleRender();
    listeners.forEach((listener) => listener(currentState));
  }

  function deleteInlineMathMethod(
    blockIndex: number,
    startIndex: number,
    endIndex: number,
  ) {
    const block = state.document.page.blocks[blockIndex];
    if (!block || block.deleted || !isTextualBlock(block)) return;
    if (endIndex <= startIndex) return;

    const prevState = state;
    const blockId = block.id;
    const { newPage, op } = deleteCharsInRange(
      state.document.page,
      blockId,
      startIndex,
      endIndex,
      state.CRDTbinding,
    );
    invalidateBlockCache(newPage.blocks[blockIndex]);

    state = {
      ...state,
      document: { ...state.document, page: newPage },
    };

    state = recordUndoOps(
      prevState,
      state,
      [op],
      state.CRDTbinding.getPeerId(),
    );

    // Place caret where the chip used to be
    state = moveCursorToPosition(state, blockIndex, startIndex);

    if (broadcastFn) {
      broadcastFn([op]);
    }

    const currentState = state;
    scheduleRender();
    listeners.forEach((listener) => listener(currentState));
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

  function setPhysicalKeyboard(hasPhysicalKeyboard: boolean) {
    state = updatePhysicalKeyboardState(state, hasPhysicalKeyboard);
    scheduleRender();
  }

  function updatePageFromSync(page: Page) {
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
      broadcastFn(ops);
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

  function advanceClockMethod(clock: HLC) {
    state.CRDTbinding.advanceClock(clock);
  }

  function advanceIdCounterMethod(n: number) {
    state.CRDTbinding.advanceIdCounter(n);
  }

  function applyRemoteOperationsMethod(ops: Operation[]) {
    if (ops.length === 0) return;

    // Apply remote operations to current page state
    const newPage = applyOps(state.document.page, ops);

    // Clear all block caches since page structure may have changed
    clearAllBlockCaches(newPage.blocks);

    // Compute visible blocks from the NEW page, not the stale view state
    const visibleBlocksForOps = getVisibleBlocks(newPage);
    state.view.visibleBlocks = visibleBlocksForOps;

    // Validate and adjust cursor position if needed
    let cursor = state.document.cursor;
    if (cursor && visibleBlocksForOps.length > 0) {
      const { blockIndex: blockIndex, textIndex } = cursor.position;
      // Find the last visible block's index in the full array
      const lastVisibleBlockForOps =
        visibleBlocksForOps[visibleBlocksForOps.length - 1];
      const maxBlockIndex = newPage.blocks.findIndex(
        (b) => b.id === lastVisibleBlockForOps.id,
      );

      if (blockIndex > maxBlockIndex) {
        // Cursor points to a block that no longer exists, move to end of last visible block
        const lastBlock = lastVisibleBlockForOps;
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
        const block = newPage.blocks[blockIndex];
        if (!block || block.deleted) {
          // Cursor's block was deleted, move to end of last visible block
          const lastBlockText = getBlockTextContent(lastVisibleBlockForOps);
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
    } else if (cursor && visibleBlocksForOps.length === 0) {
      // No visible blocks, clear cursor
      cursor = null;
    }

    // Validate selection as well
    let selection = state.document.selection;
    if (selection && visibleBlocksForOps.length > 0) {
      // Find the last visible block's index in the full array
      const lastVisibleBlockForSelectionOps =
        visibleBlocksForOps[visibleBlocksForOps.length - 1];
      const maxBlockIndex = newPage.blocks.findIndex(
        (b) => b.id === lastVisibleBlockForSelectionOps.id,
      );
      const { anchor, focus } = selection;

      let newAnchor = anchor;
      let newFocus = focus;

      if (anchor.blockIndex > maxBlockIndex) {
        const lastBlock = newPage.blocks[maxBlockIndex];
        const lastBlockText = getBlockTextContent(lastBlock);
        newAnchor = {
          blockIndex: maxBlockIndex,
          textIndex: lastBlockText.length,
        };
      }

      if (focus.blockIndex > maxBlockIndex) {
        const lastBlock = newPage.blocks[maxBlockIndex];
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
    } else if (selection && visibleBlocksForOps.length === 0) {
      selection = null;
    }

    // Update the page in state
    state = {
      ...state,
      document: {
        ...state.document,
        page: newPage,
        cursor,
        selection,
      },
    };

    // Mark document height as dirty since remote ops may have added/removed content
    documentHeightDirty = true;

    // Re-render
    const currentState = state;
    scheduleRender();
    listeners.forEach((listener) => listener(currentState));
  }

  return {
    getState,
    destroy,
    updateViewport,
    getDocumentHeight,
    setFocus,
    setInitialCursor,
    getCursorScreenPosition,
    subscribe,
    executeSlashCommand,
    copy,
    cut,
    paste,
    undo,
    redo,
    selectAll: selectAllMethod,
    toggleBold: toggleBoldMethod,
    toggleItalic: toggleItalicMethod,
    toggleCode: toggleCodeMethod,
    toggleStrikethrough: toggleStrikethroughMethod,
    setBlockType,
    updateLink,
    clearLink,
    createLink,
    clearSelection: clearSelectionMethod,
    setMode,
    restoreCursorAndSelection,
    forceRender: scheduleRender,
    updateImageBlock: updateImageBlock,
    deleteImageBlock: deleteImageBlockMethod,
    openImageUploadMenu,
    updateMathBlock,
    openMathEditMenu,
    openInlineMathEditMenu,
    updateInlineMath: updateInlineMathMethod,
    deleteInlineMath: deleteInlineMathMethod,
    exitInlineMath: exitInlineMathMethod,
    closeActiveMenu: closeActiveMenuMethod,
    setPhysicalKeyboard,
    updatePageFromSync,
    restoreFromSnapshot: restoreFromSnapshotMethod,
    applyRemoteOperations: applyRemoteOperationsMethod,
    advanceClock: advanceClockMethod,
    advanceIdCounter: advanceIdCounterMethod,
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
      setRendererSearchHighlights(highlights, activeIndex);
      scheduleRender();
    },
    clearSearchHighlights: () => {
      clearRendererSearchHighlights();
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
