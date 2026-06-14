import { type Doc } from "../doc";
import {
  createDefaultMarkRegistry,
  createMarkRegistry,
  Mark,
} from "../rendering/marks";
import {
  createDefaultNodeRegistry,
  createNodeRegistry,
  type Node,
} from "../rendering/nodes";
import { setKeyboardOpen } from "../rendering/scrollbar";
import { type Block, type Page } from "../serlization/loadPage";
import type {
  BlockStyles,
  CRDTbinding,
  DeepPartial,
  EditorStrings,
  EditorStyles,
  EditorTheme,
  FontStyles,
  PlaceholderStyles,
  TextStyle,
  ViewportState,
} from "../state-types";
import { createInitialState, isTouchDevice } from "../state-utils";
import { mergeTheme } from "../styles";
import { type EditorApi, Editor } from "./editor";
import {
  createCanvasLayers,
  destroyCanvasLayers,
  resizeCanvasLayers,
} from "./layers";

export interface MountedEditor {
  readonly editor: EditorApi;
  /**
   * The CRDT document this editor renders, when one was supplied via
   * {@link MountEditorOptions.doc}. Sync and persistence go through it
   * (`doc.applyUpdate` inbound, `doc.on("update")` outbound, `doc.load` for
   * persisted tail ops). Undefined for standalone editors mounted without a doc.
   */
  readonly doc?: Doc;
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
  /** Whether the document can be edited. Default `true`; `false` mounts a
   *  read-only renderer (no caret edits, no sync writes). */
  editable?: boolean;
  /** Accessible name for the editor's input surface, announced by screen
   *  readers. Defaults to `"Text editor"`. */
  ariaLabel?: string;
  /** Ghost text shown on an empty paragraph (keyboard + touch variants). */
  placeholder?: string;
  pageId?: string;
  /**
   * The headless theming surface for this instance — semantic `tokens`, a
   * deep-partial `styles` override of any leaf, `fonts`, the selected
   * `fontFamily`, and localized `strings`. Resolved once into per-instance
   * styles (no DOM reads, no globals). Update later with `editor.setTheme`.
   *
   * Wins over the legacy `padding` / `blockStyleOverrides` /
   * `placeholderOverrides` / `strings` / `fonts` options below, which are
   * folded into a theme for backwards compatibility.
   */
  theme?: EditorTheme;
  /** @deprecated Use `theme.styles.canvas`. */
  padding?: Partial<{
    paddingTop: number;
    paddingBottom: number;
    paddingLeft: number;
    paddingRight: number;
  }>;
  /** @deprecated Use `theme.styles.blocks`. */
  blockStyleOverrides?: Partial<Record<string, Partial<TextStyle>>> | null;
  /** @deprecated Use `theme.styles.placeholder`. */
  placeholderOverrides?: Partial<PlaceholderStyles> | null;
  /**
   * Localized canvas strings (placeholders, image/math states). The editor
   * ships English defaults and no i18n library — pass your app's translations
   * here. For block placeholders, `placeholderOverrides` wins over `strings`.
   * @deprecated Use `theme.strings`.
   */
  strings?: Partial<EditorStrings> | null;
  /**
   * Host font registry (family key → CSS font-stack + default family). The host
   * is responsible for loading the corresponding font faces. Omit to leave any
   * globally-configured registry untouched; the editor defaults to system fonts.
   * @deprecated Use `theme.fonts`.
   */
  fonts?: Partial<FontStyles> | null;
  /**
   * The set of block views this editor instance supports. Each editor owns its
   * own registry, so different editors can opt into different block types.
   * Omit to use the built-in set (`createDefaultNodeRegistry`).
   *
   * Example — an editor without the image block:
   *   import { LineNode, TextNode } from "@cypherkit/editor";
   *   mountEditor(el, blocks, { nodes: [new LineNode(), new TextNode()] });
   */
  nodes?: readonly Node[];
  /**
   * The set of inline marks this editor instance renders. Each editor owns its
   * own registry, so different editors can opt into different mark types.
   * Omit to use the built-in set (`createDefaultMarkRegistry`). Mirrors `nodes`.
   */
  marks?: readonly Mark[];
  /**
   * Per-instance CRDT context (peer id + clock + id generator). Hosts that
   * sync should create one with `createCRDTbinding(pageId, peerId)` and pass
   * the SAME binding to `createSyncEngine`, making it the single id/clock
   * source shared by the editor and the sync engine. Omit for standalone
   * editors — a binding with a random peer id is created internally.
   *
   * Ignored when {@link doc} is supplied (the doc's own binding is used).
   */
  crdtBinding?: CRDTbinding;
  /**
   * Attach an existing CRDT document (see `createDoc`). The editor renders and
   * edits this doc: local edits flow into it (`doc._ingestLocal`), and updates
   * applied from elsewhere (`doc.applyUpdate`) flow back into the editor. When
   * present, the editor mounts from `doc.getBlocks()` and uses `doc._binding`
   * as its id/clock source, so `blocks`/`crdtBinding`/`pageId` are derived from
   * the doc. The caller owns the doc's lifetime — `mountEditor`'s `destroy`
   * detaches its listener but does not destroy the doc.
   */
  doc?: Doc;
}

/**
 * Fold the legacy per-instance style options (`padding` /
 * `blockStyleOverrides` / `placeholderOverrides` / `strings` / `fonts`) into a
 * single {@link EditorTheme}, with an explicit `options.theme` merged on top
 * (so it wins).
 */
function optionsToTheme(options?: MountEditorOptions): EditorTheme {
  if (!options) return {};
  // Merge placeholderOverrides (styles) with a top-level `placeholder` string,
  // which sets the empty-paragraph ghost text (keyboard + touch variants).
  const placeholderStyle = {
    ...(options.placeholderOverrides ?? {}),
    ...(options.placeholder !== undefined
      ? {
          paragraph: {
            ...(options.placeholderOverrides?.paragraph ?? {}),
            keyboardCompatibleText: options.placeholder,
            touchCompatiableText: options.placeholder,
          },
        }
      : {}),
  } as DeepPartial<EditorStyles["placeholder"]>;
  const styles: DeepPartial<EditorStyles> = {
    ...(options.padding ? { canvas: { ...options.padding } } : {}),
    ...(options.blockStyleOverrides
      ? { blocks: options.blockStyleOverrides as DeepPartial<BlockStyles> }
      : {}),
    ...(options.placeholderOverrides || options.placeholder !== undefined
      ? { placeholder: placeholderStyle }
      : {}),
  };
  const legacy: EditorTheme = {
    styles,
    strings: options.strings ?? undefined,
    fonts: options.fonts ?? undefined,
  };
  return mergeTheme(legacy, options.theme ?? {});
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
  // Resolve the host's styling into one theme (legacy options folded in). It
  // becomes per-instance state via createInitialState below — no style globals.
  // The font registry rides on the theme too (resolved into EditorStyles.fonts
  // and threaded through measurement), so there is no global to save/restore.
  const theme = optionsToTheme(options);

  // When a doc is attached it is the source of truth: mount from its blocks and
  // adopt its page id, so the editor and doc start from one identical state.
  const doc = options?.doc;
  const page: Page = {
    id: doc?.pageId ?? options?.pageId ?? "",
    title: "",
    blocks: doc ? doc.getBlocks() : blocks,
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

  // The editor's input surface: a visually-hidden but accessibility-tree-VISIBLE
  // contenteditable element. It is the single source of native keyboard, IME,
  // and clipboard (copy/cut/paste) events and the editor's focus target; the
  // canvas is purely a rendering surface. Unlike the old `aria-hidden` 1px
  // <input>, this element is announced by screen readers as an editable text
  // field, and native copy/cut/paste operate on it directly (so they're
  // synchronous and reliable). Its content is owned by the engine (a one-char
  // sentinel when nothing is selected, the selection's text otherwise — see
  // `resetSentinel`/selection mirror in editor.ts); never `aria-hidden` /
  // `display:none` / `visibility:hidden`, which would drop it from the a11y
  // tree and break IME. Per-instance, so multiple editors never share a surface.
  const editable = options?.editable !== false;
  const hiddenInput = document.createElement("div");
  hiddenInput.contentEditable = editable ? "true" : "false";
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
  // Preserve newlines/spaces in the selection mirror text (it's never visible).
  hiddenInput.style.whiteSpace = "pre";
  hiddenInput.setAttribute("role", "textbox");
  hiddenInput.setAttribute("aria-multiline", "true");
  hiddenInput.setAttribute("aria-label", options?.ariaLabel ?? "Text editor");
  if (!editable) hiddenInput.setAttribute("aria-readonly", "true");
  hiddenInput.setAttribute("tabindex", "0");
  hiddenInput.setAttribute("autocapitalize", "off");
  hiddenInput.setAttribute("spellcheck", "false");
  // Suppress Grammarly and similar contenteditable injectors.
  hiddenInput.setAttribute("data-gramm", "false");
  // The engine seeds the sentinel content/caret on first focus + render.

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

  // Per-instance inline-mark registry (opt-in mark set), mirroring `nodes`.
  const marks = options?.marks
    ? createMarkRegistry(options.marks)
    : createDefaultMarkRegistry();

  // Create initial state from the page (blocks already loaded). Per-instance
  // style overrides live on the state (no module globals), so two editors on a
  // page don't clobber each other's padding/block/placeholder styling.
  const initialState = createInitialState(page, {
    mode: options?.editable === false ? "readonly" : "edit",
    nodes,
    marks,
    // The doc's binding is the shared id/clock source when a doc is attached.
    crdtBinding: doc?._binding ?? options?.crdtBinding,
    theme,
  });

  // Create editor with initial state and layered canvases
  const editor = new Editor(layers, initialState, initialViewport, hiddenInput);

  // ── Doc ↔ editor wiring ────────────────────────────────────────────────────
  // Local edits → doc: the editor has already applied them to its own state;
  // the doc logs them and notifies its other listeners (providers, persistence).
  // Doc updates from any other origin → editor: adopt the doc's fully-merged
  // page (not an incremental replay) so a dependency-reordered op isn't dropped.
  // `docOrigin` tags our own local batches so we skip our echoes.
  const docOrigin = Symbol("editor");
  let offDocUpdate: (() => void) | null = null;
  if (doc) {
    editor.setBroadcast((ops) => doc._ingestLocal(ops, docOrigin));
    offDocUpdate = doc.on("update", (u) => {
      if (u.origin === docOrigin) return;
      // Pass the applied ops so editor.on("change") fires with isRemote: true.
      editor.updatePageFromSync(doc._getPage(), u.ops);
    });
  }

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

  let destroyed = false;
  const resizeObserver = new ResizeObserver(() => {
    if (destroyed) return;
    const rect = container.getBoundingClientRect();
    baseWidth = Math.max(rect.width, 1);
    baseHeight = Math.max(rect.height, 1);
    resizeCanvasForKeyboard();
  });
  resizeObserver.observe(container);

  // Single predicate for "does this node belong to this editor instance?" —
  // shared by every focus-out path so their decisions can't drift. Covers the
  // canvas surface (which contains the hidden input) and any editor chrome the
  // host portals elsewhere, tagged with [data-editor-overlay] (e.g. the mobile
  // keyboard toolbar or popovers). Per-instance closure — no module globals.
  const isInsideEditor = (node: globalThis.Node | null): boolean => {
    if (!node) return false;
    if (canvasContainer.contains(node)) return true;
    return (
      node instanceof HTMLElement &&
      node.closest("[data-editor-overlay]") !== null
    );
  };

  // Backstop #1: a pointerdown on a target the browser won't focus (plain page
  // chrome, non-focusable divs) never moves DOM focus, so the hidden input's
  // native blur below never fires — this releases logical focus for that case.
  const handleDocumentClick = (e: MouseEvent | TouchEvent) => {
    if (isInsideEditor(e.target as globalThis.Node | null)) return;
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
    // Sentinel content/caret is seeded by the engine (resetSentinel) on the
    // render frame triggered by setFocus — mount.ts no longer touches it.
    editor.setFocus(true);
    editor.setInitialCursor();
  };

  // Primary focus-out signal: the hidden input owns DOM focus, so its native
  // blur is the source of truth for losing focus. The two document-level
  // backstop handlers cover the cases this event can't see.
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
  };

  const handleTouchStart = () => {
    isTouchActive = true;
  };

  const handleTouchEnd = () => {
    setTimeout(() => {
      isTouchActive = false;
    }, 10);
  };

  // Backstop #2: when focus moves to a real element outside the editor (e.g. a
  // dialog input) we must release focus so keystrokes don't get processed here.
  // The hidden input's native blur normally covers this, but some touch browsers
  // fire that blur with a null relatedTarget; focusin bubbles to document with
  // the true target, so we can still detect focus landing outside the editor.
  const handleDocumentFocusIn = (e: FocusEvent) => {
    if (isInsideEditor(e.target as globalThis.Node | null)) return;
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

  // Theme reactivity (e.g. dark-mode toggle) is the host's responsibility: the
  // engine no longer reads the DOM for styling, so the host watches its own
  // theme source and calls `editor.setTheme(...)`. (Was a MutationObserver on
  // document.documentElement that force-rendered to re-read CSS variables.)

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
    resizeObserver.disconnect();
    // Detach the doc listener before tearing the editor down. The doc itself is
    // owned by the caller (a private doc by createEditor, the host's doc by the
    // app), so it is not destroyed here.
    offDocUpdate?.();
    offDocUpdate = null;
    editor.destroy();
    if (blurTimeoutId !== null) {
      clearTimeout(blurTimeoutId);
      blurTimeoutId = null;
    }
    window.removeEventListener("focus", handleWindowFocus);
    window.removeEventListener("blur", handleWindowBlur);
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
    doc,
    refocus,
    blurInput,
    setKeyboardHeight,
    destroy,
    portalContainer,
  };
}
