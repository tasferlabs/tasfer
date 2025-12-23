import { loadPage, type Page } from "../deserializer/loadPage";
import { handleEvents } from "./events";
import { calculateBlockHeight, renderPage } from "./renderer";
import { createInitialState } from "./state";
import { defaultStyles } from "./styles";
import type { EditorState, ViewportState } from "./types";

export interface Editor {
  start: (setDocumentHeight: (height: number) => void) => void;
  getState: () => EditorState;
  destroy: () => void;
  load: (path: string) => Promise<void>;
  updateViewport: (viewport: Partial<ViewportState>) => void;
  getDocumentHeight: () => number;
}

export default function createEditor(
  canvas: HTMLCanvasElement,
  viewportProp: ViewportState,
  hiddenInput?: HTMLInputElement
): Editor {
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Could not get 2D context from canvas");
  }

  let page: Page;
  let state: EditorState;
  let viewport = viewportProp;
  let animationFrameId: number | null = null;
  let documentHeight = 0;
  let visibility = {
    start: 0,
    end: 0,
  };

  const eventsQueue: Event[] = [];

  // Detect if device has touch support
  const isTouchDevice = (): boolean => {
    return (
      typeof window !== "undefined" &&
      ("ontouchstart" in window || navigator.maxTouchPoints > 0)
    );
  };

  // Update canvas cursor style based on scrollbar hover and drag state
  const updateCursorStyle = (
    isHoveringScrollbar: boolean,
    isDragging: boolean
  ) => {
    // Only update cursor on desktop (not touch devices)
    if (isTouchDevice()) {
      return;
    }

    if (isDragging) {
      // When dragging scrollbar, use grabbing cursor
      canvas.style.cursor = "grabbing";
    } else if (isHoveringScrollbar) {
      // When hovering over scrollbar, use pointer cursor
      canvas.style.cursor = "pointer";
    } else {
      // When hovering over text, use text cursor
      canvas.style.cursor = "text";
    }
  };

  // Render loopg
  const render = (setDocumentHeight: (height: number) => void) => {
    state = handleEvents(
      state,
      viewport,
      visibility,
      eventsQueue,
      documentHeight,
      updateViewport
    );
    documentHeight = renderPage(ctx, state, viewport, visibility);

    // Update cursor style based on scrollbar hover and drag state
    updateCursorStyle(state.scrollbar.isHovered, state.scrollbar.isDragging);

    setDocumentHeight(documentHeight);
    animationFrameId = requestAnimationFrame(() => render(setDocumentHeight));
  };

  function eventsHandler(e: Event) {
    // Ignore keyboard events from hidden input - those are handled separately
    if (e instanceof KeyboardEvent && e.target === hiddenInput) {
      return;
    }

    if (
      e instanceof KeyboardEvent &&
      ["Enter", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(
        e.key
      )
    ) {
      e.preventDefault();
    }
    // Prevent default on wheel and touchmove to avoid browser interference
    if (e.type === "wheel" || e.type === "touchmove") {
      e.preventDefault();
    }
    eventsQueue.push(e);
  }

  // Window-level mouse handlers to catch events outside canvas
  function windowMouseUpHandler(e: Event) {
    eventsQueue.push(e);
  }

  function windowMouseMoveHandler(e: Event) {
    if (state && (state.scrollbar.isDragging || state.mode === "select")) {
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
    // Process the touch event first
    eventsHandler(e);

    // Check if this was a tap (not a scroll/drag)
    const touchDuration = Date.now() - touchStartTime;
    const wasTap = !touchHasMoved && touchDuration < TAP_TIME_THRESHOLD;

    // Focus input on tap to trigger keyboard (but not on scroll)
    if (hiddenInput && isTouchDevice() && wasTap) {
      // Small delay to ensure touch event is processed
      setTimeout(() => {
        try {
          hiddenInput.focus();
          // Some browsers need click as well
          if (document.activeElement !== hiddenInput) {
            hiddenInput.click();
          }
        } catch (err) {
          // Ignore focus errors
        }
      }, 50);
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
    if (!hiddenInput || !state) return;

    const inputEvent = e as InputEvent;

    // Use inputEvent.data for precise text that was inserted (not entire input value)
    const insertedText = inputEvent.data;

    // Handle text input
    if (
      insertedText &&
      (inputEvent.inputType === "insertText" ||
        inputEvent.inputType === "insertCompositionText")
    ) {
      // Process each character that was inserted
      for (const char of insertedText) {
        const keyEvent = new KeyboardEvent("keydown", {
          key: char,
          bubbles: true,
          cancelable: true,
        });
        eventsQueue.push(keyEvent);
      }
      // Clear the input value after processing
      hiddenInput.value = "";
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
      hiddenInput.value = "";
      return;
    }

    if (inputEvent.inputType === "deleteContentBackward") {
      const backspaceEvent = new KeyboardEvent("keydown", {
        key: "Backspace",
        bubbles: true,
        cancelable: true,
      });
      eventsQueue.push(backspaceEvent);
      hiddenInput.value = "";
      return;
    }

    // Clear input value for any other input types to prevent accumulation
    hiddenInput.value = "";
  }

  // Handle keydown from hidden input (for special keys)
  function hiddenInputKeyDownHandler(e: KeyboardEvent) {
    if (!hiddenInput) return;

    // Only forward special keys to avoid duplication with input event
    // Regular text input is handled by hiddenInputHandler
    if (
      [
        "Enter",
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
        "Backspace",
        "Delete",
      ].includes(e.key)
    ) {
      e.preventDefault();
      e.stopPropagation();
      eventsQueue.push(e);
      hiddenInput.value = "";
    } else {
      // For regular character keys, prevent default to stop them from being processed by window listener
      // But allow the input event to fire
      e.stopPropagation();
    }
  }

  // Click handler for focusing input (stored for cleanup)
  let canvasClickHandler: (() => void) | null = null;

  function start(setDocumentHeight: (height: number) => void) {
    if (!page) {
      throw new Error("Page not provided");
    }

    state = createInitialState(page);
    render(setDocumentHeight);

    // Add click/mousedown handler to canvas as fallback for focusing input
    canvasClickHandler = () => {
      if (hiddenInput && isTouchDevice()) {
        try {
          hiddenInput.focus();
        } catch (err) {
          // Ignore
        }
      }
    };
    if (!isTouchDevice()) {
      canvas.addEventListener("mousedown", canvasClickHandler);

      canvas.addEventListener("mousedown", eventsHandler);
      canvas.addEventListener("mousemove", eventsHandler);
      canvas.addEventListener("mouseup", eventsHandler);
      canvas.addEventListener("wheel", eventsHandler, { passive: false });

      window.addEventListener("mouseup", windowMouseUpHandler);
      window.addEventListener("mousemove", windowMouseMoveHandler);
    }
    canvas.addEventListener("click", canvasClickHandler);

    canvas.addEventListener("touchstart", touchStartHandler, {
      passive: false,
    });
    canvas.addEventListener("touchmove", touchMoveHandler, { passive: false });
    canvas.addEventListener("touchend", touchEndHandler, { passive: false });
    canvas.addEventListener("touchcancel", eventsHandler, { passive: false });
    window.addEventListener("keydown", eventsHandler);

    // Set up hidden input handlers for mobile keyboard support
    if (hiddenInput) {
      hiddenInput.addEventListener("input", hiddenInputHandler);
      hiddenInput.addEventListener("keydown", hiddenInputKeyDownHandler);

      // Ensure input is focusable (already set in mount.ts, but ensure it's correct)
      hiddenInput.setAttribute("tabindex", "0");
    }
  }

  function getState() {
    return state;
  }

  function destroy() {
    if (animationFrameId) {
      cancelAnimationFrame(animationFrameId);
    }

    if (canvasClickHandler) {
      canvas.removeEventListener("click", canvasClickHandler);
    }

    if (!isTouchDevice()) {
      if (canvasClickHandler) {
        canvas.removeEventListener("mousedown", canvasClickHandler);
        canvasClickHandler = null;
      }

      canvas.removeEventListener("mousedown", eventsHandler);
      canvas.removeEventListener("mousemove", eventsHandler);
      canvas.removeEventListener("mouseup", eventsHandler);
      canvas.removeEventListener("pointerdown", eventsHandler);
      canvas.removeEventListener("pointermove", eventsHandler);
      canvas.removeEventListener("pointerup", eventsHandler);
      canvas.removeEventListener("pointercancel", eventsHandler);
      canvas.removeEventListener("wheel", eventsHandler);

      window.removeEventListener("mouseup", windowMouseUpHandler);
      window.removeEventListener("mousemove", windowMouseMoveHandler);
    }

    canvas.removeEventListener("touchstart", touchStartHandler);
    canvas.removeEventListener("touchmove", touchMoveHandler);
    canvas.removeEventListener("touchend", touchEndHandler);
    canvas.removeEventListener("touchcancel", eventsHandler);
    window.removeEventListener("keydown", eventsHandler);

    // Clean up hidden input handlers
    if (hiddenInput) {
      hiddenInput.removeEventListener("input", hiddenInputHandler);
      hiddenInput.removeEventListener("keydown", hiddenInputKeyDownHandler);
    }
  }

  async function load(path: string) {
    const response = await fetch(path);
    const content = await response.text();

    page = loadPage(content);
  }

  function updateViewport(newViewport: Partial<ViewportState>) {
    viewport = { ...viewport, ...newViewport };
  }

  function getDocumentHeight(): number {
    if (!page || !state) return 0;

    // Calculate total document height based on all blocks
    const styles = defaultStyles;
    const maxWidth = viewport.width - 2 * styles.canvas.paddingLeft;
    let totalHeight = styles.canvas.paddingTop;

    for (const block of page.blocks) {
      totalHeight += calculateBlockHeight(block, maxWidth, styles);
    }

    return totalHeight + styles.canvas.paddingBottom;
  }

  return {
    start,
    getState,
    destroy,
    load,
    updateViewport,
    getDocumentHeight,
  };
}
