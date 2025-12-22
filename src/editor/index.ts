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
  viewportProp: ViewportState
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
  const updateCursorStyle = (isHoveringScrollbar: boolean, isDragging: boolean) => {
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

  // Render loop
  const render = (setDocumentHeight: (height: number) => void) => {
    state = handleEvents(state, viewport, visibility, eventsQueue, documentHeight, updateViewport);
    documentHeight = renderPage(ctx, state, viewport, visibility);
    
    // Update cursor style based on scrollbar hover and drag state
    updateCursorStyle(state.scrollbar.isHovered, state.scrollbar.isDragging);
    
    setDocumentHeight(documentHeight);
    animationFrameId = requestAnimationFrame(() => render(setDocumentHeight));
  };

  function eventsHandler(e: Event) {
    if (
      e instanceof KeyboardEvent &&
      ["Enter", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(
        e.key
      )
    ) {
      e.preventDefault();
    }
    if (e.type === "wheel" || e.type === "touchmove") {
      e.preventDefault();
    }
    
    // For pointer events, use pointer capture to ensure we get pointerup even outside canvas
    if (e instanceof PointerEvent) {
      if (e.type === "pointerdown") {
        canvas.setPointerCapture(e.pointerId);
      } else if (e.type === "pointerup" || e.type === "pointercancel") {
        if (canvas.hasPointerCapture(e.pointerId)) {
          canvas.releasePointerCapture(e.pointerId);
        }
      }
    }
    
    eventsQueue.push(e);
  }
  
  // Window-level mouse handlers to catch events outside canvas
  function windowMouseUpHandler(e: Event) {
    eventsQueue.push(e);
  }
  
  function windowMouseMoveHandler(e: Event) {
    // Only track window mousemove if we're dragging (scrollbar or selecting)
    if (state && (state.scrollbar.isDragging || state.mode === "select")) {
      eventsQueue.push(e);
    }
  }

  function start(setDocumentHeight: (height: number) => void) {
    if (!page) {
      throw new Error("Page not provided");
    }

    state = createInitialState(page);
    render(setDocumentHeight);

    canvas.addEventListener("mousedown", eventsHandler);
    canvas.addEventListener("mousemove", eventsHandler);
    canvas.addEventListener("mouseup", eventsHandler);
    canvas.addEventListener("pointerdown", eventsHandler);
    canvas.addEventListener("pointermove", eventsHandler);
    canvas.addEventListener("pointerup", eventsHandler);
    canvas.addEventListener("pointercancel", eventsHandler);
    canvas.addEventListener("wheel", eventsHandler, { passive: false });
    canvas.addEventListener("touchstart", eventsHandler, { passive: false });
    canvas.addEventListener("touchmove", eventsHandler, { passive: false });
    canvas.addEventListener("touchend", eventsHandler, { passive: false });
    canvas.addEventListener("touchcancel", eventsHandler, { passive: false });
    window.addEventListener("keydown", eventsHandler);
    // Window-level mouse handlers to catch events outside canvas
    window.addEventListener("mouseup", windowMouseUpHandler);
    window.addEventListener("mousemove", windowMouseMoveHandler);
  }

  function getState() {
    return state;
  }

  function destroy() {
    if (animationFrameId) {
      cancelAnimationFrame(animationFrameId);
    }

    canvas.removeEventListener("mousedown", eventsHandler);
    canvas.removeEventListener("mousemove", eventsHandler);
    canvas.removeEventListener("mouseup", eventsHandler);
    canvas.removeEventListener("pointerdown", eventsHandler);
    canvas.removeEventListener("pointermove", eventsHandler);
    canvas.removeEventListener("pointerup", eventsHandler);
    canvas.removeEventListener("pointercancel", eventsHandler);
    canvas.removeEventListener("wheel", eventsHandler);
    canvas.removeEventListener("touchstart", eventsHandler);
    canvas.removeEventListener("touchmove", eventsHandler);
    canvas.removeEventListener("touchend", eventsHandler);
    canvas.removeEventListener("touchcancel", eventsHandler);
    window.removeEventListener("keydown", eventsHandler);
    window.removeEventListener("mouseup", windowMouseUpHandler);
    window.removeEventListener("mousemove", windowMouseMoveHandler);
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
