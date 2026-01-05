import type { ViewportState } from "./types";
import createEditor, { type Editor } from "./editor";
import { loadPage } from "../deserializer/loadPage";
import { createInitialState, isTouchDevice } from "./state";
import { setWindowFocused } from "./styles";

export interface MountedEditor {
  readonly editor: Editor;
  /** Container for React portals (e.g., slash command menu) */
  readonly portalContainer: HTMLDivElement;
  destroy: () => void;
}

function getDpr(): number {
  return typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
}

function measure(container: HTMLElement): { width: number; height: number } {
  const rect = container.getBoundingClientRect();
  return {
    width: Math.max(rect.width, 1),
    height: Math.max(rect.height, 1),
  };
}

function sizeCanvasToContainer(
  canvas: HTMLCanvasElement,
  container: HTMLElement
) {
  const { width, height } = measure(container);
  const dpr = getDpr();

  // CSS size (layout pixels)
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;

  // Backing store size (device pixels)
  canvas.width = Math.max(Math.floor(width * dpr), 1);
  canvas.height = Math.max(Math.floor(height * dpr), 1);

  return { width, height };
}

/**
 * Imperatively mounts the canvas editor into a container element.
 * React/Vue/etc can call this from lifecycle hooks; no framework state required.
 */
export function mountEditor(
  container: HTMLElement,
  content: string
): MountedEditor {
  const canvas = document.createElement("canvas");
  canvas.style.display = "block";
  canvas.style.userSelect = "none";
  (canvas.style as unknown as { WebkitUserSelect?: string }).WebkitUserSelect =
    "none";
  (canvas.style as unknown as { MozUserSelect?: string }).MozUserSelect =
    "none";
  (canvas.style as unknown as { msUserSelect?: string }).msUserSelect = "none";
  canvas.setAttribute("draggable", "false");
  const preventSelectStart = (e: Event) => e.preventDefault();
  const preventDragStart = (e: Event) => e.preventDefault();
  canvas.addEventListener("selectstart", preventSelectStart);
  canvas.addEventListener("dragstart", preventDragStart);

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

  // Ensure the canvas is the only scroll surface (container should not scroll)
  container.appendChild(canvas);
  container.appendChild(hiddenInput);

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

  const initial = sizeCanvasToContainer(canvas, container);
  const initialViewport: ViewportState = {
    width: initial.width,
    height: initial.height,
    scrollY: 0,
  };

  // Load the page and create initial state before creating the editor
  const page = loadPage(content);
  const initialState = createInitialState(page);

  // Create editor with initial state
  const editor = createEditor(
    canvas,
    initialState,
    initialViewport,
    hiddenInput
  );

  let keyboardHeight = 0;
  let baseWidth = initial.width;
  let baseHeight = initial.height;

  const resizeCanvasForKeyboard = () => {
    const dpr = getDpr();
    const availableHeight = Math.max(baseHeight - keyboardHeight, 100);

    canvas.style.width = `${baseWidth}px`;
    canvas.style.height = `${availableHeight}px`;

    // Also resize portal container so Radix UI knows the available space
    portalContainer.style.width = `${baseWidth}px`;
    portalContainer.style.height = `${availableHeight}px`;

    canvas.width = Math.max(Math.floor(baseWidth * dpr), 1);
    canvas.height = Math.max(Math.floor(availableHeight * dpr), 1);

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

    // If click is on container or hidden input, do nothing (editor handles it)
    if (container.contains(target) || hiddenInput.contains(target)) {
      return;
    }

    // Click outside: blur editor

    editor.setFocus(false, true);
  };

  // Handle hidden input focus/blur (mobile keyboard)
  let blurTimeoutId: number | null = null;

  const handleInputFocus = () => {
    // Cancel any pending blur if input regains focus
    if (blurTimeoutId !== null) {
      clearTimeout(blurTimeoutId);
      blurTimeoutId = null;
    }

    editor.setFocus(true);
    editor.setInitialCursor();
  };

  const handleInputBlur = (e: FocusEvent) => {
    // Defer the blur action to allow the canvas click handler to refocus the input
    // This prevents unnecessary blur/refocus cycles during triple-click and other interactions

    // If click is on container or hidden input, do nothing (editor handles it)
    if (
      container.contains(e.target as Node) ||
      hiddenInput.contains(e.target as Node)
    ) {
      return;
    }

    if (e.target === hiddenInput) {
      return;
    }

    // If keyboard is dismissed or focus lost, blur editor
    if (isTouchDevice()) {
      editor.setFocus(false, true);
    } else {
      editor.setFocus(false);
    }

    // Clear the hidden input value to remove any lingering composition text
    hiddenInput.value = "";
  };

  document.addEventListener("mousedown", handleDocumentClick);
  document.addEventListener("touchstart", handleDocumentClick);
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
    hiddenInput.removeEventListener("focus", handleInputFocus);
    hiddenInput.removeEventListener("blur", handleInputBlur);
    canvas.removeEventListener("selectstart", preventSelectStart);
    canvas.removeEventListener("dragstart", preventDragStart);

    canvas.remove();
    hiddenInput.remove();
    portalContainer.remove();
  };

  return { editor, destroy, portalContainer };
}
