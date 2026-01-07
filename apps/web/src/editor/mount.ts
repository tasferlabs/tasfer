import type { ViewportState } from "./types";
import createEditor, { type Editor } from "./editor";
import { loadPage } from "../deserializer/loadPage";
import { createInitialState, isTouchDevice } from "./state";
import { setWindowFocused } from "./styles";
import {
  createCanvasLayers,
  resizeCanvasLayers,
  destroyCanvasLayers,
} from "./layers";

export interface MountedEditor {
  readonly editor: Editor;
  /** Container for React portals (e.g., slash command menu) */
  readonly portalContainer: HTMLDivElement;
  destroy: () => void;
}

function measure(container: HTMLElement): { width: number; height: number } {
  const rect = container.getBoundingClientRect();
  return {
    width: Math.max(rect.width, 1),
    height: Math.max(rect.height, 1),
  };
}

/**
 * Create a canvas container with proper positioning for layered canvases
 */
function createCanvasContainer(parentContainer: HTMLElement): HTMLDivElement {
  const canvasContainer = document.createElement("div");
  canvasContainer.style.position = "relative";
  canvasContainer.style.width = "100%";
  canvasContainer.style.height = "100%";
  canvasContainer.style.overflow = "hidden";
  parentContainer.appendChild(canvasContainer);
  return canvasContainer;
}

/**
 * Imperatively mounts the canvas editor into a container element.
 * React/Vue/etc can call this from lifecycle hooks; no framework state required.
 */
export function mountEditor(
  container: HTMLElement,
  content: string
): MountedEditor {
  // Create a container for the layered canvases
  const canvasContainer = createCanvasContainer(container);

  // Get initial dimensions
  const initial = measure(container);

  // Create layered canvases (content + cursor)
  const layers = createCanvasLayers(
    canvasContainer,
    initial.width,
    initial.height
  );

  // Apply common canvas styles to content layer (which handles events)
  const contentCanvas = layers.content.canvas;
  contentCanvas.style.display = "block";
  contentCanvas.style.userSelect = "none";
  (
    contentCanvas.style as unknown as { WebkitUserSelect?: string }
  ).WebkitUserSelect = "none";
  (contentCanvas.style as unknown as { MozUserSelect?: string }).MozUserSelect =
    "none";
  (contentCanvas.style as unknown as { msUserSelect?: string }).msUserSelect =
    "none";
  contentCanvas.setAttribute("draggable", "false");
  const preventSelectStart = (e: Event) => e.preventDefault();
  const preventDragStart = (e: Event) => e.preventDefault();
  contentCanvas.addEventListener("selectstart", preventSelectStart);
  contentCanvas.addEventListener("dragstart", preventDragStart);

  // Create a hidden input element for mobile keyboard support
  // Note: Mobile browsers require the input to receive the touch event to show keyboard
  const hiddenInput = document.createElement("input");
  hiddenInput.type = "text";
  hiddenInput.style.position = "absolute";
  hiddenInput.style.opacity = "0";
  hiddenInput.style.width = "1px";
  hiddenInput.style.height = "1px";
  hiddenInput.style.top = "0";
  hiddenInput.style.left = "0";
  hiddenInput.style.overflow = "hidden";
  hiddenInput.style.border = "none";
  hiddenInput.style.padding = "0";
  hiddenInput.style.margin = "0";
  hiddenInput.style.background = "transparent";
  hiddenInput.style.outline = "none";
  hiddenInput.style.zIndex = "1"; // Above canvas but below UI elements
  hiddenInput.style.pointerEvents = "none"; // Don't intercept touches - we'll focus programmatically
  hiddenInput.style.caretColor = "transparent"; // Hide caret
  hiddenInput.style.color = "transparent"; // Hide text
  hiddenInput.setAttribute("aria-hidden", "true");
  hiddenInput.setAttribute("tabindex", "0");
  hiddenInput.setAttribute("autocomplete", "off");
  hiddenInput.setAttribute("autocorrect", "off");
  hiddenInput.setAttribute("autocapitalize", "off");
  hiddenInput.setAttribute("spellcheck", "false");
  hiddenInput.setAttribute("inputmode", "text");

  // Add hidden input to the canvas container
  canvasContainer.appendChild(hiddenInput);

  // Create portal container for React components (like slash command menu)
  const portalContainer = document.createElement("div");
  portalContainer.style.position = "absolute";
  portalContainer.style.top = "0";
  portalContainer.style.left = "0";
  portalContainer.style.width = "100%";
  portalContainer.style.height = "100%";
  portalContainer.style.pointerEvents = "none"; // Allow clicks through except on menu
  portalContainer.style.zIndex = "1000";
  container.appendChild(portalContainer);

  const initialViewport: ViewportState = {
    width: initial.width,
    height: initial.height,
    scrollY: 0,
  };

  // Load the page and create initial state before creating the editor
  const page = loadPage(content);
  const initialState = createInitialState(page);

  // Create editor with initial state and layered canvases
  const editor = createEditor(
    layers,
    initialState,
    initialViewport,
    hiddenInput
  );

  let keyboardHeight = 0;
  let baseWidth = initial.width;
  let baseHeight = initial.height;

  const resizeCanvasForKeyboard = () => {
    const availableHeight = Math.max(baseHeight - keyboardHeight, 100);

    // Resize the canvas container
    canvasContainer.style.width = `${baseWidth}px`;
    canvasContainer.style.height = `${availableHeight}px`;

    // Also resize portal container so Radix UI knows the available space
    portalContainer.style.width = `${baseWidth}px`;
    portalContainer.style.height = `${availableHeight}px`;

    // Resize all canvas layers
    resizeCanvasLayers(layers, baseWidth, availableHeight);

    editor.updateViewport({ width: baseWidth, height: availableHeight });
  };

  const handleKeyboardMessage = (event: MessageEvent) => {
    if (event.data?.type === "keyboard-show") {
      keyboardHeight = event.data.height || 0;
      resizeCanvasForKeyboard();
    } else if (event.data?.type === "keyboard-hide") {
      keyboardHeight = 0;
      resizeCanvasForKeyboard();
    }
  };

  window.addEventListener("message", handleKeyboardMessage);

  let destroyed = false;
  const resizeObserver = new ResizeObserver(() => {
    if (destroyed) return;
    const rect = container.getBoundingClientRect();
    baseWidth = Math.max(rect.width, 1);
    baseHeight = Math.max(rect.height, 1);
    resizeCanvasForKeyboard();
  });
  resizeObserver.observe(container);

  // Handle click outside
  const handleDocumentClick = (e: MouseEvent | TouchEvent) => {
    const target = e.target as Node;
    if (!target) return;

    // If click is on canvas container or hidden input, do nothing (editor handles it)
    if (canvasContainer.contains(target) || hiddenInput.contains(target)) {
      return;
    }

    if (editor.getState()?.ui.activeMenu.type === "contextMenu") {
      return;
    }

    // Click outside: blur editor
    editor.setFocus(false, true);
  };

  // Handle hidden input focus/blur (mobile keyboard)
  let blurTimeoutId: number | null = null;
  let isTouchActive = false; // Track if we're in the middle of a touch interaction

  const handleInputFocus = () => {
    console.log("[FOCUS] Hidden input focused");
    // Cancel any pending blur if input regains focus
    if (blurTimeoutId !== null) {
      clearTimeout(blurTimeoutId);
      blurTimeoutId = null;
    }

    editor.setFocus(true);
    editor.setInitialCursor();
  };

  const handleInputBlur = (e: FocusEvent) => {
    // Check if context menu is open - keep focus if so
    if (editor.getState()?.ui.activeMenu.type === "contextMenu") {
      return;
    }

    // On mobile, ignore blurs during active touch interactions
    // The touchend handler will refocus the input
    if (isTouchDevice() && isTouchActive) {
      return;
    }

    // On mobile, ignore transient blurs - focus will be restored if needed
    // This prevents breaking InputConnection during touch interactions
    if (isTouchDevice()) {
      const relatedTarget = e.relatedTarget as Node | null;

      // If focus is moving to another element within our container, ignore it
      if (relatedTarget && container.contains(relatedTarget)) {
        return;
      }

      // If no relatedTarget (focus going nowhere), it's likely a transient blur
      // Don't blur the editor - let the touch handler manage focus
      if (!relatedTarget) {
        return;
      }
    }

    // Desktop or explicit blur to external element
    if (isTouchDevice()) {
      editor.setFocus(false, true);
    } else {
      editor.setFocus(false);
    }

    // Clear the hidden input value to remove any lingering composition text
    hiddenInput.value = "";
  };

  // Track touch interactions to prevent spurious blurs
  const handleTouchStart = () => {
    isTouchActive = true;
  };

  const handleTouchEnd = () => {
    // Use a small delay to let touchend handlers complete
    setTimeout(() => {
      isTouchActive = false;
    }, 50);
  };

  document.addEventListener("mousedown", handleDocumentClick);
  document.addEventListener("touchstart", handleDocumentClick);
  container.addEventListener("touchstart", handleTouchStart);
  container.addEventListener("touchend", handleTouchEnd);
  container.addEventListener("touchcancel", handleTouchEnd);
  hiddenInput.addEventListener("focus", handleInputFocus);
  hiddenInput.addEventListener("blur", handleInputBlur);

  // Handle window focus/blur for selection color changes
  const handleWindowFocus = () => {
    setWindowFocused(true);
    // Trigger a re-render to update selection color
    editor.forceRender();
  };

  const handleWindowBlur = () => {
    setWindowFocused(false);
    // Trigger a re-render to update selection color
    editor.forceRender();
  };

  window.addEventListener("focus", handleWindowFocus);
  window.addEventListener("blur", handleWindowBlur);

  const destroy = () => {
    destroyed = true;
    resizeObserver.disconnect();
    editor.destroy();

    // Clear any pending blur timeout
    if (blurTimeoutId !== null) {
      clearTimeout(blurTimeoutId);
      blurTimeoutId = null;
    }

    window.removeEventListener("message", handleKeyboardMessage);
    window.removeEventListener("focus", handleWindowFocus);
    window.removeEventListener("blur", handleWindowBlur);
    document.removeEventListener("mousedown", handleDocumentClick);
    document.removeEventListener("touchstart", handleDocumentClick);
    container.removeEventListener("touchstart", handleTouchStart);
    container.removeEventListener("touchend", handleTouchEnd);
    container.removeEventListener("touchcancel", handleTouchEnd);
    hiddenInput.removeEventListener("focus", handleInputFocus);
    hiddenInput.removeEventListener("blur", handleInputBlur);
    contentCanvas.removeEventListener("selectstart", preventSelectStart);
    contentCanvas.removeEventListener("dragstart", preventDragStart);

    // Destroy all canvas layers
    destroyCanvasLayers(layers);
    hiddenInput.remove();
    portalContainer.remove();
    canvasContainer.remove();
  };

  return { editor, destroy, portalContainer };
}
