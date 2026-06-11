import {
  createDefaultNodeRegistry,
  createNodeRegistry,
  type Node,
} from "../rendering/nodes";
import { setKeyboardOpen } from "../rendering/scrollbar";
import { type Block, type Page } from "../serlization/loadPage";
import type {
  CRDTbinding,
  EditorStrings,
  FontStyles,
  PlaceholderStyles,
  TextStyle,
  ViewportState,
} from "../state-types";
import {
  createInitialState,
  detectPhysicalKeyboardHeuristic,
  isTouchDevice,
} from "../state-utils";
import { getFontStyles, setFontStyles } from "../styles";
import createEditor, { type Editor } from "./editor";
import {
  createCanvasLayers,
  destroyCanvasLayers,
  resizeCanvasLayers,
} from "./layers";

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

function measureCanvasSize(container: HTMLElement): {
  width: number;
  height: number;
} {
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
  /**
   * Localized canvas strings (placeholders, image/math states). The editor
   * ships English defaults and no i18n library — pass your app's translations
   * here. For block placeholders, `placeholderOverrides` wins over `strings`.
   */
  strings?: Partial<EditorStrings> | null;
  /**
   * Host font registry (family key → CSS font-stack + default family). The host
   * is responsible for loading the corresponding font faces. Omit to leave any
   * globally-configured registry untouched; the editor defaults to system fonts.
   */
  fonts?: Partial<FontStyles> | null;
  /**
   * The set of block views this editor instance supports. Each editor owns its
   * own registry, so different editors can opt into different block types.
   * Omit to use the built-in set (`createDefaultNodeRegistry`).
   *
   * Example — an editor without the image block:
   *   import { lineNode, textNode } from "@cypherkit/editor";
   *   mountEditor(el, blocks, { nodes: [lineNode, textNode] });
   */
  nodes?: readonly Node[];
  /**
   * Per-instance CRDT context (peer id + clock + id generator). Hosts that
   * sync should create one with `createCRDTbinding(pageId, peerId)` and pass
   * the SAME binding to `createSyncEngine`, making it the single id/clock
   * source shared by the editor and the sync engine. Omit for standalone
   * editors — a binding with a random peer id is created internally.
   */
  crdtBinding?: CRDTbinding;
}

/**
 * Mounts the canvas editor from a pre-loaded snapshot (Block[]) instead of parsing markdown.
 * This is used when loading pages with snapshot storage.
 */
export function mountEditor(
  container: HTMLElement,
  blocks: Block[], //NOTE - Should be called state
  options?: MountEditorOptions,
): MountedEditor {
  // Padding, block-style, and placeholder overrides are now per-instance state
  // (see createInitialState below) — no module globals to save/restore.
  //
  // The font registry is still a module global pending Phase 2, so it keeps the
  // save/restore dance. Fonts are opt-in: only override when explicitly provided
  // so an app that configures its registry globally isn't reset by editors that
  // don't.
  const prevFonts = getFontStyles();
  if (options?.fonts !== undefined) {
    setFontStyles(options.fonts);
  }

  // Create a Page object from the blocks
  const page: Page = {
    id: options?.pageId ?? "",
    title: "",
    blocks: blocks,
  };

  // Create a container for the layered canvases
  const canvasContainer = createCanvasContainer(container);

  // Get initial dimensions
  const initial = measureCanvasSize(container);

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

  // Build this editor's per-instance block view registry (opt-in block set).
  const nodes = options?.nodes
    ? createNodeRegistry(options.nodes)
    : createDefaultNodeRegistry();

  // Create initial state from the page (blocks already loaded). Per-instance
  // style overrides live on the state (no module globals), so two editors on a
  // page don't clobber each other's padding/block/placeholder styling.
  const initialState = createInitialState(page, {
    mode: options?.readonly ? "readonly" : "edit",
    nodes,
    crdtBinding: options?.crdtBinding,
    styleConfig: {
      padding: options?.padding ?? null,
      blockStyleOverrides: options?.blockStyleOverrides ?? null,
      placeholderOverrides: options?.placeholderOverrides ?? null,
      strings: options?.strings ?? null,
    },
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
    const target = e.target as globalThis.Node;
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
    const relatedTarget = e.relatedTarget as globalThis.Node | null;
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
    const target = e.target as globalThis.Node;
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
    editor.setWindowFocused(true);
  };

  const handleWindowBlur = () => {
    editor.setWindowFocused(false);
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
    // Restore previous font registry so the main editor isn't affected (the
    // other style overrides are per-instance state and need no restore).
    if (options?.fonts !== undefined) {
      setFontStyles(prevFonts);
    }
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
