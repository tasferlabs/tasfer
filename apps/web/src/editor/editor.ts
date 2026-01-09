import type { Block } from "../deserializer/loadPage";
import { isNotImageBlock } from "../deserializer/loadPage";
import {
  applySlashCommand,
  convertBlockType,
  updateLinkInBlock,
  clearLinkInBlock,
  selectAll,
  getSelectionRange,
  mergeAdjacentSegments,
  extractSegmentsInRange,
} from "./commands";
import {
  copySelectionToClipboard,
  cutSelectionToClipboard,
  pasteFromNativeClipboardAPI,
} from "./clipboard";
import { handleEvents, isInLongPressMode } from "./events";
import {
  renderPage,
  renderCursorLayer,
  clearAllBlockCaches,
  invalidateBlockCache,
  getBlockHeight,
} from "./renderer";
import {
  getCursorCoordinates,
  getCursorCoordinatesWithComposition,
} from "./selection";
import {
  updateFocus,
  isCursorBlinking,
  closeContextMenu,
  clearSelection,
  updateMode,
  updateCursor,
  updateSelection,
  createInitialCursorState,
  setActiveMenu,
  closeActiveMenu,
  isTouchDevice,
  getBlockTextContent,
  moveCursorToPosition,
  updatePhysicalKeyboardState,
} from "./state";
import { getEditorStyles } from "./styles";
import type { EditorState, SlashCommand, ViewportState } from "./types";
import { recordUndo, undoState, redoState } from "./undo";
import type { CanvasLayers } from "./layers";
import { onFontFamilyChange } from "./fonts";

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
  setBlockType: (type: Block["type"]) => void;
  updateLink: (
    blockIndex: number,
    segmentIndex: number,
    newUrl: string,
    newText: string
  ) => void;
  clearLink: (blockIndex: number, segmentIndex: number) => void;
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
}

export default function createEditor(
  layers: CanvasLayers,
  initialState: EditorState,
  viewportProp: ViewportState,
  hiddenInput?: HTMLInputElement
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

  // Dirty flags for each layer
  let dirtyLayers = {
    content: true, // Start with true for initial render
    cursor: true,
  };

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
      // Get current canvas position for event coordinate adjustment
      const containerRect = contentCanvas.getBoundingClientRect();
      const rect = {
        left: containerRect.left,
        top: containerRect.top,
      };

      const prevState = state;
      state = handleEvents(
        state,
        viewport,
        visibility,
        eventsQueue,
        documentHeight,
        rect,
        updateViewport,
        pendingClipboardData
      );

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
          // Pre-calculate document height to clamp viewport before rendering
          const newDocumentHeight = getDocumentHeight();
          const maxScroll = Math.max(0, newDocumentHeight - viewport.height);
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
    }

    // Schedule render for viewport changes
    scheduleRender();
    renderFrame();
  }

  function getDocumentHeight(): number {
    // Calculate total document height based on all blocks
    const styles = getEditorStyles();
    const maxWidth = viewport.width - 2 * styles.canvas.paddingLeft;
    let totalHeight = styles.canvas.paddingTop;

    for (let i = 0; i < state.document.page.blocks.length; i++) {
      const block = state.document.page.blocks[i];
      // Use getBlockHeight to leverage caching for performance
      const blockHeight = getBlockHeight(block, maxWidth, styles, i);
      totalHeight += blockHeight;
    }

    return totalHeight + styles.canvas.paddingBottom;
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
      state = recordUndo(state);
      state = applySlashCommand(state, command);
      scheduleRender();
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
    if (result.success && result.newState) {
      state = result.newState;
      state = closeContextMenu(state);
      scheduleRender();
      return true;
    }
    state = closeContextMenu(state);
    scheduleRender();
    return false;
  }

  async function paste(): Promise<boolean> {
    const newState = await pasteFromNativeClipboardAPI(state);
    if (newState) {
      state = newState;
      state = closeContextMenu(state);
      scheduleRender();
      return true;
    }
    state = closeContextMenu(state);
    scheduleRender();
    return false;
  }

  function undo() {
    const newState = undoState(state);
    if (newState !== state) {
      state = newState;
      scheduleRender();
      listeners.forEach((listener) => listener(newState));
    }
  }

  function redo() {
    const newState = redoState(state);
    if (newState !== state) {
      state = newState;
      scheduleRender();
      listeners.forEach((listener) => listener(newState));
    }
  }

  function selectAllMethod() {
    state = selectAll(state);
    state = closeContextMenu(state);
    const currentState = state;
    scheduleRender();
    listeners.forEach((listener) => listener(currentState));
  }

  function setBlockType(type: Block["type"]) {
    if (!state.document.cursor) return;
    state = recordUndo(state);
    state = convertBlockType(state, type);
    const currentState = state;
    scheduleRender();
    listeners.forEach((listener) => listener(currentState));
  }

  function updateLink(
    blockIndex: number,
    segmentIndex: number,
    newUrl: string,
    newText: string
  ) {
    state = recordUndo(state);
    state = updateLinkInBlock(state, blockIndex, segmentIndex, newUrl, newText);
    const currentState = state;
    scheduleRender();
    listeners.forEach((listener) => listener(currentState));
  }

  function clearLink(blockIndex: number, segmentIndex: number) {
    state = recordUndo(state);
    state = clearLinkInBlock(state, blockIndex, segmentIndex);
    const currentState = state;
    scheduleRender();
    listeners.forEach((listener) => listener(currentState));
  }

  function createLink(url: string, text: string) {
    if (!state.document.selection || state.document.selection.isCollapsed) {
      return; // Need a selection to create a link
    }

    state = recordUndo(state);

    const range = getSelectionRange(state);
    if (!range) return;

    const { start, end } = range;

    // Only support single-block link creation for now
    if (start.blockIndex !== end.blockIndex) {
      return;
    }

    const block = state.document.page.blocks[start.blockIndex];
    if (!block || !isNotImageBlock(block)) {
      return;
    }

    // Extract content before selection, after selection, and create link in between
    const blockText = getBlockTextContent(block);
    const beforeContent = extractSegmentsInRange(block.content, 0, start.textIndex);
    const afterContent = extractSegmentsInRange(block.content, end.textIndex, blockText.length);

    // Create the new content with the link in the middle
    const newContent = [
      ...beforeContent,
      { content: text, formats: [{ type: "link" as const, url }] },
      ...afterContent,
    ];

    const newBlock = {
      ...block,
      content: mergeAdjacentSegments(newContent),
    };

    invalidateBlockCache(newBlock);

    const newBlocks = [...state.document.page.blocks];
    newBlocks[start.blockIndex] = newBlock;

    state = {
      ...state,
      document: {
        ...state.document,
        page: { ...state.document.page, blocks: newBlocks },
      },
    };

    // Clear selection and move cursor to end of inserted link
    state = clearSelection(state);
    state = moveCursorToPosition(state, start.blockIndex, start.textIndex + text.length);

    const currentState = state;
    scheduleRender();
    listeners.forEach((listener) => listener(currentState));
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

    if (!block || block.type !== "image") {
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

    state = {
      ...state,
      ui: newUIState,
      document: {
        ...state.document,
        page: { ...state.document.page, blocks: newBlocks },
      },
    };

    const currentState = state;
    scheduleRender();
    listeners.forEach((listener) => listener(currentState));
  }

  function deleteImageBlockMethod(blockIndex: number) {
    const block = state.document.page.blocks[blockIndex];

    if (!block || block.type !== "image") {
      console.error("Attempted to delete non-image block");
      return;
    }

    state = recordUndo(state);

    const newBlocks = [...state.document.page.blocks];
    newBlocks.splice(blockIndex, 1);

    // If we deleted the last block, add an empty paragraph
    if (newBlocks.length === 0) {
      newBlocks.push({
        id: `block-${Date.now()}`,
        type: "paragraph",
        content: [{ content: "", formats: undefined }],
      });
    }

    state = {
      ...state,
      document: {
        ...state.document,
        page: { ...state.document.page, blocks: newBlocks },
      },
    };

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
  };
}
