import { type Block, type Page } from "./deserializer/loadPage";
import createEditor, { type Editor } from "./editor";
import {
  createCanvasLayers,
  destroyCanvasLayers,
  resizeCanvasLayers,
} from "./layers";
import { setKeyboardOpen } from "./scrollbar";
import {
  createInitialState,
  detectPhysicalKeyboardHeuristic,
  isTouchDevice,
} from "./state";
import {
  getBlockStyleOverrides,
  getEditorPadding,
  getPlaceholderOverrides,
  setBlockStyleOverrides,
  setEditorPadding,
  setPlaceholderOverrides,
  setWindowFocused,
} from "./styles";
import type { PlaceholderStyles, TextStyle } from "./types";
import type { ViewportState } from "./types";

export interface MountedEditor {
  readonly editor: Editor;
  /** Container for React portals (e.g., slash command menu) */
  readonly portalContainer: HTMLDivElement;
  /** Refocus the hidden input (useful after closing drawers/modals) */
  refocus: () => void;
  /** Blur the hidden input to dismiss the soft keyboard */
  blurInput: () => void;
  /** Notify the canvas of the current soft-keyboard height (px). Call whenever the keyboard appears, disappears, or changes size. */
  setKeyboardHeight: (height: number) => void;
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
  canvasContainer.style.userSelect = "none";
  canvasContainer.style.webkitUserSelect = "none";
  (
    canvasContainer.style as unknown as { webkitTouchCallout?: string }
  ).webkitTouchCallout = "none";
  parentContainer.appendChild(canvasContainer);
  return canvasContainer;
}

export interface MountEditorOptions {
  readonly?: boolean;
  pageId?: string;
  padding?: Partial<{
    paddingTop: number;
    paddingBottom: number;
    paddingLeft: number;
    paddingRight: number;
  }>;
  blockStyleOverrides?: Partial<Record<string, Partial<TextStyle>>> | null;
  placeholderOverrides?: Partial<PlaceholderStyles> | null;
}

/**
 * Mounts the canvas editor from a pre-loaded snapshot (Block[]) instead of parsing markdown.
 * This is used when loading pages with snapshot storage.
 */
export function mountEditor(
  container: HTMLElement,
  blocks: Block[],
  options?: MountEditorOptions,
): MountedEditor {
  // Save previous overrides so they can be restored when this editor is destroyed
  // (prevents a secondary editor like SnapshotPreview from clobbering the main editor's settings)
  const prevPadding = getEditorPadding();
  const prevBlockStyles = getBlockStyleOverrides();
  const prevPlaceholders = getPlaceholderOverrides();

  // Apply padding and block style overrides before creating editor
  setEditorPadding(options?.padding ?? null);
  setBlockStyleOverrides(options?.blockStyleOverrides ?? null);
  setPlaceholderOverrides(options?.placeholderOverrides ?? null);

  // Create a Page object from the blocks
  const page: Page = {
    id: options?.pageId ?? "",
    title: "",
    blocks: blocks,
  };

  // Create a container for the layered canvases
  const canvasContainer = createCanvasContainer(container);

  // Get initial dimensions
  const initial = measure(container);

  // Create layered canvases (content + cursor)
  const layers = createCanvasLayers(
    canvasContainer,
    initial.width,
    initial.height,
  );

  // Apply common canvas styles to content layer (which handles events)
  const contentCanvas = layers.content.canvas;
  contentCanvas.style.display = "block";
  contentCanvas.setAttribute("draggable", "false");
  const preventSelectStart = (e: Event) => e.preventDefault();
  const preventDragStart = (e: Event) => e.preventDefault();
  contentCanvas.addEventListener("selectstart", preventSelectStart);
  contentCanvas.addEventListener("dragstart", preventDragStart);

  // Create a hidden input element for mobile keyboard support
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
  hiddenInput.style.zIndex = "1";
  hiddenInput.style.pointerEvents = "none";
  hiddenInput.style.caretColor = "transparent";
  hiddenInput.style.color = "transparent";
  hiddenInput.setAttribute("aria-hidden", "true");
  hiddenInput.setAttribute("tabindex", "0");
  hiddenInput.setAttribute("autocomplete", "off");
  hiddenInput.setAttribute("autocorrect", "off");
  hiddenInput.setAttribute("autocapitalize", "off");
  hiddenInput.setAttribute("spellcheck", "false");
  hiddenInput.value = " ";

  canvasContainer.appendChild(hiddenInput);

  // Create portal container for React components
  const portalContainer = document.createElement("div");
  portalContainer.style.position = "absolute";
  portalContainer.style.top = "0";
  portalContainer.style.left = "0";
  portalContainer.style.width = "100%";
  portalContainer.style.height = "100%";
  portalContainer.style.pointerEvents = "none";
  portalContainer.style.zIndex = "1000";
  container.appendChild(portalContainer);

  const initialViewport: ViewportState = {
    width: initial.width,
    height: initial.height,
    scrollY: 0,
    documentHeight: 0,
  };

  // Create initial state from the page (blocks already loaded)
  const initialState = createInitialState(page, {
    mode: options?.readonly ? "readonly" : "edit",
  });

  // Create editor with initial state and layered canvases
  const editor = createEditor(
    layers,
    initialState,
    initialViewport,
    hiddenInput,
  );

  // Height reserved by the React keyboard toolbar when keyboard is open
  const KEYBOARD_TOOLBAR_HEIGHT = 48;

  let keyboardHeight = 0;
  let baseWidth = initial.width;
  let baseHeight = initial.height;

  const resizeCanvasForKeyboard = () => {
    const isKbOpen = keyboardHeight > 50;
    const toolbarOffset =
      isKbOpen && isTouchDevice() ? KEYBOARD_TOOLBAR_HEIGHT : 0;
    const availableHeight = Math.max(
      baseHeight - keyboardHeight - toolbarOffset,
      100,
    );
    canvasContainer.style.width = `${baseWidth}px`;
    canvasContainer.style.height = `${availableHeight}px`;
    portalContainer.style.width = `${baseWidth}px`;
    portalContainer.style.height = `${availableHeight}px`;
    resizeCanvasLayers(layers, baseWidth, availableHeight);
    editor.updateViewport({ width: baseWidth, height: availableHeight });
  };

  // setKeyboardHeight is called by the React component (MountedEditor.tsx) via
  // useKeyboardOpen(), which uses platform-native sources:
  //   iOS  — @capacitor/keyboard keyboardWillShow/Hide events
  //   Android — native postMessage from MainActivity
  //   Web/desktop — window.visualViewport resize events
  // This avoids relying on window.visualViewport directly here, which is
  // unreliable on iOS (resize:"none" keeps the viewport unchanged) and Android
  // (edge-to-edge mode makes innerHeight - visualViewport.height inaccurate).
  const setKeyboardHeight = (height: number) => {
    const wasOpen = keyboardHeight > 50;
    const isOpen = height > 50;
    keyboardHeight = height;
    if (wasOpen !== isOpen) setKeyboardOpen(isOpen);
    resizeCanvasForKeyboard();
  };

  // Keep physical keyboard detection from native messages (still useful)
  const handlePhysicalKeyboardMessage = (event: MessageEvent) => {
    if (event.data?.type === "physical-keyboard-connected") {
      editor.setPhysicalKeyboard(event.data.connected === true);
    }
  };
  window.addEventListener("message", handlePhysicalKeyboardMessage);

  const initialKeyboardState = detectPhysicalKeyboardHeuristic();
  editor.setPhysicalKeyboard(initialKeyboardState);

  let destroyed = false;
  const resizeObserver = new ResizeObserver(() => {
    if (destroyed) return;
    const rect = container.getBoundingClientRect();
    baseWidth = Math.max(rect.width, 1);
    baseHeight = Math.max(rect.height, 1);
    resizeCanvasForKeyboard();
  });
  resizeObserver.observe(container);

  const handleDocumentClick = (e: MouseEvent | TouchEvent) => {
    const target = e.target as Node;
    if (!target) return;
    if (canvasContainer.contains(target) || hiddenInput.contains(target)) {
      return;
    }
    if (editor.getState()?.ui.activeMenu.type === "contextMenu") {
      return;
    }
    editor.setFocus(false, true);
    if (e instanceof TouchEvent) {
      hiddenInput.blur();
    }
  };

  let blurTimeoutId: number | null = null;
  let isTouchActive = false;

  const handleInputFocus = () => {
    if (blurTimeoutId !== null) {
      clearTimeout(blurTimeoutId);
      blurTimeoutId = null;
    }
    if (!hiddenInput.value) {
      hiddenInput.value = " ";
    }
    editor.setFocus(true);
    editor.setInitialCursor();
  };

  const handleInputBlur = (e: FocusEvent) => {
    if (editor.getState()?.ui.activeMenu.type === "contextMenu") {
      return;
    }
    if (
      isTouchDevice() &&
      isTouchActive &&
      editor.getState()?.ui.mode === "select"
    ) {
      return;
    }
    const relatedTarget = e.relatedTarget as Node | null;
    if (
      window.CypherBridge &&
      relatedTarget &&
      relatedTarget instanceof HTMLElement
    ) {
      const tagName = relatedTarget.tagName.toUpperCase();
      if (tagName === "INPUT" || tagName === "TEXTAREA") {
        editor.setFocus(false, true);
        hiddenInput.value = " ";
        return;
      }
      return;
    }
    if (isTouchDevice()) {
      if (relatedTarget && container.contains(relatedTarget)) {
        return;
      }
      if (!relatedTarget) {
        setTimeout(() => {
          if (
            document.activeElement !== hiddenInput &&
            editor.getState()?.view.isFocused &&
            !document.querySelector("[cmdk-dialog]")
          ) {
            hiddenInput.focus({ preventScroll: true });
          }
        }, 0);
        return;
      }
    }
    if (isTouchDevice()) {
      editor.setFocus(false, true);
    } else {
      editor.setFocus(false);
    }
    hiddenInput.value = " ";
  };

  const handleTouchStart = () => {
    isTouchActive = true;
  };

  const handleTouchEnd = () => {
    setTimeout(() => {
      isTouchActive = false;
    }, 10);
  };

  // When focus moves to an element outside the editor (e.g., a dialog input),
  // unfocus the editor so keystrokes don't get processed by it
  const handleDocumentFocusIn = (e: FocusEvent) => {
    const target = e.target as Node;
    if (!target) return;
    if (target === hiddenInput) return;
    if (canvasContainer.contains(target)) return;
    // Don't unfocus when focus moves into editor overlay UI (e.g. mobile keyboard toolbar)
    if (
      target instanceof HTMLElement &&
      target.closest("[data-editor-overlay]")
    )
      return;
    if (editor.getState()?.view.isFocused) {
      editor.setFocus(false);
    }
  };

  document.addEventListener("mousedown", handleDocumentClick);
  document.addEventListener("touchstart", handleDocumentClick);
  document.addEventListener("focusin", handleDocumentFocusIn);
  container.addEventListener("touchstart", handleTouchStart);
  container.addEventListener("touchend", handleTouchEnd);
  container.addEventListener("touchcancel", handleTouchEnd);
  hiddenInput.addEventListener("focus", handleInputFocus);
  hiddenInput.addEventListener("blur", handleInputBlur);

  const handleWindowFocus = () => {
    setWindowFocused(true);
    editor.forceRender();
  };

  const handleWindowBlur = () => {
    setWindowFocused(false);
    editor.forceRender();
  };

  window.addEventListener("focus", handleWindowFocus);
  window.addEventListener("blur", handleWindowBlur);

  // Watch for theme changes (dark class toggle on document root)
  const themeObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.attributeName === "class") {
        // Theme changed, force re-render to pick up new CSS variables
        editor.forceRender();
        break;
      }
    }
  });
  themeObserver.observe(document.documentElement, { attributes: true });

  const refocus = () => {
    if (hiddenInput && !destroyed) {
      hiddenInput.focus({ preventScroll: true });
    }
  };

  const blurInput = () => {
    if (!destroyed) {
      hiddenInput.blur();
    }
  };

  const destroy = () => {
    destroyed = true;
    // Restore previous style overrides so the main editor isn't affected
    setEditorPadding(prevPadding);
    setBlockStyleOverrides(prevBlockStyles);
    setPlaceholderOverrides(prevPlaceholders);
    resizeObserver.disconnect();
    editor.destroy();
    if (blurTimeoutId !== null) {
      clearTimeout(blurTimeoutId);
      blurTimeoutId = null;
    }
    window.removeEventListener("message", handlePhysicalKeyboardMessage);
    window.removeEventListener("focus", handleWindowFocus);
    window.removeEventListener("blur", handleWindowBlur);
    themeObserver.disconnect();
    document.removeEventListener("mousedown", handleDocumentClick);
    document.removeEventListener("touchstart", handleDocumentClick);
    document.removeEventListener("focusin", handleDocumentFocusIn);
    container.removeEventListener("touchstart", handleTouchStart);
    container.removeEventListener("touchend", handleTouchEnd);
    container.removeEventListener("touchcancel", handleTouchEnd);
    hiddenInput.removeEventListener("focus", handleInputFocus);
    hiddenInput.removeEventListener("blur", handleInputBlur);
    contentCanvas.removeEventListener("selectstart", preventSelectStart);
    contentCanvas.removeEventListener("dragstart", preventDragStart);
    destroyCanvasLayers(layers);
    hiddenInput.remove();
    portalContainer.remove();
    canvasContainer.remove();
  };

  return {
    editor,
    refocus,
    blurInput,
    setKeyboardHeight,
    destroy,
    portalContainer,
  };
}
