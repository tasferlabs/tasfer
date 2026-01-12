import type { Block, Page } from "../deserializer/loadPage";
import { isTextualBlock } from "../deserializer/loadPage";
import type {
  BlockDelete,
  BlockInsert,
  BlockSet,
  Operation,
} from "../sync/types";
import {
  copySelectionToClipboard,
  cutSelectionToClipboard,
  pasteFromNativeClipboardAPI,
} from "./clipboard";
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
} from "./commands";
import {
  applyRemoteOps,
  deleteCharsInRange,
  formatCharsInRange,
  insertCharsAtPosition,
} from "./crdt-helpers";
import { handleEvents, isInLongPressMode } from "./events";
import { onFontFamilyChange } from "./fonts";
import type { CanvasLayers } from "./layers";
import {
  clearAllBlockCaches,
  getBlockHeight,
  invalidateBlockCache,
  renderCursorLayer,
  renderPage,
} from "./renderer";
import {
  getCursorCoordinates,
  getCursorCoordinatesWithComposition,
} from "./selection";
import {
  clearSelection,
  closeActiveMenu,
  closeContextMenu,
  createInitialCursorState,
  getBlockTextContent,
  isCursorBlinking,
  isTouchDevice,
  moveCursorToPosition,
  setActiveMenu,
  updateCursor,
  updateFocus,
  updateMode,
  updatePhysicalKeyboardState,
  updateSelection,
} from "./state";
import { getEditorStyles } from "./styles";
import type {
  CRDTContext,
  CommandResult,
  EditorState,
  SlashCommand,
  ViewportState,
} from "./types";
import { recordUndoOps, redoState, undoState } from "./undo";

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
    newText: string
  ) => void;
  clearLink: (blockIndex: number, startIndex: number, endIndex: number) => void;
  createLink: (url: string, text: string) => void;
  clearSelection: () => void;
  setMode: (mode: "edit" | "select" | "locked") => void;
  restoreCursorAndSelection: (
    cursor: EditorState["document"]["cursor"],
    selection: EditorState["document"]["selection"]
  ) => void;
  forceRender: () => void;
  updateImageBlock: (
    blockIndex: number,
    updates: {
      url?: string;
      alt?: string;
    },
    uploadStatus?: "uploading" | "complete" | "error"
  ) => void;
  deleteImageBlock: (blockIndex: number) => void;
  openImageUploadMenu: (
    blockIndex: number,
    x: number,
    y: number,
    existingUrl?: string,
    existingAlt?: string
  ) => void;
  closeActiveMenu: () => void;
  /** Update page content from CRDT sync (remote operations) */
  updatePageFromSync: (page: Page) => void;
  /** Apply remote operations to the current page state */
  applyRemoteOperations: (ops: Operation[]) => void;
  /** Set broadcast function for sending operations to peers */
  setBroadcast: (fn: ((ops: Operation[]) => void) | null) => void;
}

export default function createEditor(
  layers: CanvasLayers,
  initialState: EditorState,
  viewportProp: ViewportState,
  hiddenInput?: HTMLInputElement,
  crdtContextParam?: CRDTContext
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

  // CRDT context for generating IDs and clocks
  // Use provided context or create a default one
  const crdtContext: CRDTContext = crdtContextParam || {
    pageId: "default-page",
    idGen: () => `${Date.now()}-${Math.random()}`,
    clock: () => ({
      wall: Date.now(),
      logical: 0,
      peerId: "default-peer",
    }),
  };

  /**
   * Execute a command that returns { state, ops } and broadcast operations to peers.
   * This is the central point for all state-modifying operations.
   */
  const executeCommand = (result: CommandResult): void => {
    const { state: newState, ops } = result;
    const prevState = state;

    // Update local state and record to undo stack (pass both before/after states for cursor restoration)
    state = ops.length > 0
      ? recordUndoOps(prevState, newState, ops, crdtContext.clock().peerId)
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
  } | null = null;

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
    dragHandleHover: "left" | "right" | "bottom" | null = null
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
    } else {
      // When hovering over text, use text cursor
      contentCanvas.style.cursor = "text";
    }
  };

  // Render a single frame synchronously
  const renderFrame = async () => {
    if (isRendering) return;
    isRendering = true;

    try {
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
        crdtContext,
        updateViewport,
        pendingClipboardData
      );

      // Update state with the result from events
      state = handleEventsResult.state;

      // Record operations to undo stack (only if not from undo/redo)
      // Undo/redo already updates undoManager internally, so check if it changed
      if (handleEventsResult.ops.length > 0) {
        const undoManagerChanged = prevState.undoManager !== state.undoManager;
        if (!undoManagerChanged) {
          // Regular operation - record to undo stack (pass both before/after states for cursor restoration)
          state = recordUndoOps(prevState, state, handleEventsResult.ops, crdtContext.clock().peerId);
        }
        // Broadcast ops to peers
        if (broadcastFn) {
          broadcastFn(handleEventsResult.ops);
        }
      }

      // Clear clipboard data after it's been used
      pendingClipboardData = null;

      // Check if state changed or if there are events that require rendering
      const stateChanged = prevState !== state;

      // Determine what changed to decide which layers to update
      if (stateChanged) {
        // Check if page content changed (requires content layer update)
        if (prevState.document.page !== state.document.page) {
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
          documentHeight = renderPage(contentCtx, state, viewport, visibility);

          // Update cursor style based on scrollbar hover and drag state
          updateCursorStyle(
            state.view.scrollbar.isHovered,
            state.view.scrollbar.isDragging,
            state.ui.isHoveringLinkWithModifier,
            state.ui.imageHover?.hoveredHandle || null
          );

          dirtyLayers.content = false;
        }

        // Render cursor layer if dirty (very cheap!)
        if (dirtyLayers.cursor) {
          renderCursorLayer(cursorCtx, state, viewport);
          dirtyLayers.cursor = false;
        }

        // Update hidden input position to match cursor for IME composition toolbar
        if (hiddenInput && state.document.cursor && state.view.isFocused) {
          const cursorCoords = getCursorCoordinatesWithComposition(
            state,
            viewport
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
        e.key
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
        pendingClipboardData = {
          html: clipboardData.getData("text/html") || "",
          text:
            clipboardData.getData("text/plain") ||
            clipboardData.getData("text") ||
            "",
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

    // Focus input if ending long press or on tap (but not when context menu is open)
    if (
      hiddenInput &&
      isTouchDevice() &&
      (wasLongPress || wasTap) &&
      !hasContextMenu
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

    // During composition (IME input), block most keys
    // Let the IME handle these keys for mobile composition
    if (state.ui.composition?.isComposing) {
      // Block delete/enter keys
      if (["Backspace", "Delete", "Enter"].includes(e.key)) {
        return;
      }
      // Block shortcuts like Ctrl+Z (undo), Ctrl+X (cut), etc.
      if (isShortcut) {
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
    scheduleRender(); // Schedule initial render
    renderLoop();

    // Add click/mousedown handler to canvas as fallback for focusing input
    canvasClickHandler = () => {
      if (hiddenInput) {
        try {
          hiddenInput.focus({ preventScroll: true });
        } catch (err) {
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
        compositionUpdateHandler
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
  })(); // Execute IIFE to initialize editor

  function getState() {
    return state;
  }

  function destroy() {
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
        compositionStartHandler
      );
      hiddenInput.removeEventListener(
        "compositionupdate",
        compositionUpdateHandler
      );
      hiddenInput.removeEventListener("compositionend", compositionEndHandler);
    }
  }

  function updateViewport(newViewport: Partial<ViewportState>) {
    const oldWidth = viewport.width;

    viewport = { ...viewport, ...newViewport };

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

    for (let i = 0; i < state.document.page.blocks.length; i++) {
      const block = state.document.page.blocks[i];
      // Skip tombstoned blocks
      if (block.deleted) {
        continue;
      }
      // Use getBlockHeight to leverage caching for performance
      const blockHeight = getBlockHeight(block, maxWidth, styles, i);
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

    // Notify native platforms of editor focus state
    if (window.AndroidBridge?.setEditorFocused) {
      window.AndroidBridge.setEditorFocused(focused);
    }
    if (window.IOSBridge?.setEditorFocused) {
      window.IOSBridge.setEditorFocused(focused);
    }
  }

  function setInitialCursor() {
    // Only set cursor if there isn't one already
    if (!state.document.cursor && state.document.page.blocks.length > 0) {
      state = createInitialCursorState(state);
      scheduleRender();
    }
  }

  function getCursorScreenPosition() {
    if (!state.document.cursor) return null;

    const coords = getCursorCoordinates(
      state.document.cursor.position,
      state,
      viewport,
      getEditorStyles()
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
      state = (state);
      const result = applySlashCommand(state, command, crdtContext);
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
    const result = await cutSelectionToClipboard(state, crdtContext);
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
    const result = await pasteFromNativeClipboardAPI(state, crdtContext);
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
    const result = toggleBold(
      hasSelection ? (state) : state,
      crdtContext
    );
    executeCommand(result);
  }

  function toggleItalicMethod() {
    const hasSelection =
      state.document.selection && !state.document.selection.isCollapsed;
    const result = toggleItalic(
      hasSelection ? (state) : state,
      crdtContext
    );
    executeCommand(result);
  }

  function toggleCodeMethod() {
    const hasSelection =
      state.document.selection && !state.document.selection.isCollapsed;
    const result = toggleCode(
      hasSelection ? (state) : state,
      crdtContext
    );
    executeCommand(result);
  }

  function toggleStrikethroughMethod() {
    const hasSelection =
      state.document.selection && !state.document.selection.isCollapsed;
    const result = toggleStrikethrough(
      hasSelection ? (state) : state,
      crdtContext
    );
    executeCommand(result);
  }

  function setBlockType(type: Block["type"]) {
    if (!state.document.cursor) return;
    state = (state);
    const result = convertBlockType(state, type, crdtContext);
    executeCommand(result);
  }

  function updateLink(
    blockIndex: number,
    startIndex: number,
    endIndex: number,
    newUrl: string,
    newText: string
  ) {
    state = (state);
    const result = updateLinkInBlock(
      state,
      blockIndex,
      startIndex,
      endIndex,
      newUrl,
      newText,
      crdtContext
    );
    executeCommand(result);
  }

  function clearLink(blockIndex: number, startIndex: number, endIndex: number) {
    state = (state);
    const result = clearLinkInBlock(
      state,
      blockIndex,
      startIndex,
      endIndex,
      crdtContext
    );
    executeCommand(result);
  }

  function createLink(url: string, text: string) {
    if (!state.document.selection || state.document.selection.isCollapsed) {
      return; // Need a selection to create a link
    }

    state = (state);

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
    const { newChars: charsAfterDelete, op: deleteOp } = deleteCharsInRange(
      block.chars,
      start.textIndex,
      end.textIndex,
      block.id,
      crdtContext
    );
    ops.push(deleteOp);

    // Insert the new link text
    const { newChars: charsAfterInsert, op: insertOp } = insertCharsAtPosition(
      charsAfterDelete,
      start.textIndex,
      text,
      block.id,
      crdtContext
    );
    ops.push(insertOp);

    // Apply link formatting to the inserted text
    const { newFormats, op: formatOp } = formatCharsInRange(
      charsAfterInsert,
      block.formats,
      start.textIndex,
      start.textIndex + text.length,
      block.id,
      { type: "link", url },
      url,
      crdtContext
    );
    ops.push(formatOp);

    const newBlock = {
      ...block,
      chars: charsAfterInsert,
      formats: newFormats,
    };

    invalidateBlockCache(newBlock);

    const newBlocks = [...state.document.page.blocks];
    newBlocks[start.blockIndex] = newBlock;

    const newState = {
      ...state,
      document: {
        ...state.document,
        page: { ...state.document.page, blocks: newBlocks },
      },
    };

    // Clear selection and move cursor to end of inserted link
    const stateWithClearedSelection = clearSelection(newState);
    const finalState = moveCursorToPosition(
      stateWithClearedSelection,
      start.blockIndex,
      start.textIndex + text.length
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
    selection: EditorState["document"]["selection"]
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
          : null
      ),
      "edit"
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
    uploadStatus?: "uploading" | "complete" | "error"
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

    // Create CRDT operations for image property updates
    const ops: Operation[] = [];
    const blockId = block.id;

    if (updates.url !== undefined) {
      const op: BlockSet = {
        op: "block_set",
        id: crdtContext.idGen(),
        clock: crdtContext.clock(),
        pageId: crdtContext.pageId,
        blockId,
        field: "url",
        value: updates.url,
      };
      ops.push(op);
    }
    if (updates.alt !== undefined) {
      const op: BlockSet = {
        op: "block_set",
        id: crdtContext.idGen(),
        clock: crdtContext.clock(),
        pageId: crdtContext.pageId,
        blockId,
        field: "alt",
        value: updates.alt,
      };
      ops.push(op);
    }

    state = {
      ...state,
      ui: newUIState,
      document: {
        ...state.document,
        page: { ...state.document.page, blocks: newBlocks },
      },
    };

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

    if (!block || block.deleted || block.type !== "image") {
      console.error("Attempted to delete non-image block");
      return;
    }

    // Get block ID before deletion
    const blockId = block.id;

    state = (state);

    const newBlocks = [...state.document.page.blocks];
    newBlocks.splice(blockIndex, 1);

    // Create CRDT operations
    const ops: Operation[] = [];

    // Delete the image block
    const deleteOp: BlockDelete = {
      op: "block_delete",
      id: crdtContext.idGen(),
      clock: crdtContext.clock(),
      pageId: crdtContext.pageId,
      blockId,
    };
    ops.push(deleteOp);

    // If we deleted the last block, add an empty paragraph
    let newParagraphBlockId: string | null = null;
    if (newBlocks.length === 0) {
      newParagraphBlockId = `b-${crdtContext.idGen()}`;
      newBlocks.push({
        id: newParagraphBlockId,
        type: "paragraph",
        chars: [],
        formats: [],
      });

      // Insert new paragraph block
      const insertOp: BlockInsert = {
        op: "block_insert",
        id: crdtContext.idGen(),
        clock: crdtContext.clock(),
        pageId: crdtContext.pageId,
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
    _existingAlt?: string
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

    // Validate and adjust cursor position if needed
    let cursor = state.document.cursor;
    if (cursor && page.blocks.length > 0) {
      const { blockIndex, textIndex } = cursor.position;
      const maxBlockIndex = page.blocks.length - 1;

      if (blockIndex > maxBlockIndex) {
        // Cursor points to a block that no longer exists, move to end of last block
        const lastBlock = page.blocks[maxBlockIndex];
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
        if (block) {
          const blockText = getBlockTextContent(block);
          if (textIndex > blockText.length) {
            cursor = {
              ...cursor,
              position: {
                blockIndex,
                textIndex: blockText.length,
              },
            };
          }
        }
      }
    } else if (cursor && page.blocks.length === 0) {
      // No blocks, clear cursor
      cursor = null;
    }

    // Validate selection as well
    let selection = state.document.selection;
    if (selection && page.blocks.length > 0) {
      const maxBlockIndex = page.blocks.length - 1;
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
    } else if (selection && page.blocks.length === 0) {
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

    // Re-render
    const currentState = state;
    scheduleRender();
    listeners.forEach((listener) => listener(currentState));
  }

  function setBroadcastMethod(fn: ((ops: Operation[]) => void) | null) {
    broadcastFn = fn;
  }

  function applyRemoteOperationsMethod(ops: Operation[]) {
    if (ops.length === 0) return;

    // Apply remote operations to current page state
    const newPage = applyRemoteOps(state.document.page, ops);

    // Clear all block caches since page structure may have changed
    clearAllBlockCaches(newPage.blocks);

    // Validate and adjust cursor position if needed
    let cursor = state.document.cursor;
    if (cursor && newPage.blocks.length > 0) {
      const { blockIndex, textIndex } = cursor.position;
      const maxBlockIndex = newPage.blocks.length - 1;

      if (blockIndex > maxBlockIndex) {
        // Cursor points to a block that no longer exists, move to end of last block
        const lastBlock = newPage.blocks[maxBlockIndex];
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
        if (block) {
          const blockText = getBlockTextContent(block);
          if (textIndex > blockText.length) {
            cursor = {
              ...cursor,
              position: {
                blockIndex,
                textIndex: blockText.length,
              },
            };
          }
        }
      }
    } else if (cursor && newPage.blocks.length === 0) {
      // No blocks, clear cursor
      cursor = null;
    }

    // Validate selection as well
    let selection = state.document.selection;
    if (selection && newPage.blocks.length > 0) {
      const maxBlockIndex = newPage.blocks.length - 1;
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
    } else if (selection && newPage.blocks.length === 0) {
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
    closeActiveMenu: closeActiveMenuMethod,
    setPhysicalKeyboard,
    updatePageFromSync,
    applyRemoteOperations: applyRemoteOperationsMethod,
    setBroadcast: setBroadcastMethod,
  };
}
