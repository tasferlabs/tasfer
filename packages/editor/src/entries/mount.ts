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
import type { BaseSchemaDefinition, SchemaDefinition } from "../schema-types";
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
  ViewWindow,
} from "../state-types";
import { createInitialState } from "../state-utils";
import { mergeTheme } from "../styles";
import type { DataSchema } from "../sync/schema";
import { Editor, type EditorApi } from "./editor";
import {
  createCanvasLayers,
  destroyCanvasLayers,
  resizeCanvasLayers,
} from "./layers";

export interface MountedEditor<
  D extends SchemaDefinition = BaseSchemaDefinition,
> {
  readonly editor: EditorApi<D>;
  /**
   * The CRDT document this editor renders, when one was supplied via
   * {@link MountEditorOptions.doc}. Sync and persistence go through it
   * (`doc.applyUpdate` inbound, `doc.on("update")` outbound, `doc.load` for
   * persisted tail ops). Undefined for standalone editors mounted without a doc.
   */
  readonly doc?: Doc<D>;
  /** Container for React portals (e.g., slash action menu) */
  readonly portalContainer: HTMLDivElement;
  /** Refocus the hidden input (useful after closing drawers/modals) */
  refocus: () => void;
  /** Blur the hidden input to dismiss the soft keyboard */
  blurInput: () => void;
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

/**
 * Block types that render placeholder ghost text when empty. `bullet_list` and
 * `numbered_list` both render through the same list-item placeholder slot.
 */
export type PlaceholderBlockType =
  | "paragraph"
  | "heading1"
  | "heading2"
  | "heading3"
  | "bullet_list"
  | "numbered_list"
  | "todo_list"
  | "math";

/**
 * Placeholder ghost text for empty blocks: either one generic string applied to
 * every block type, or a per-block-type map (e.g.
 * `{ paragraph: "Write…", heading1: "Title" }`).
 */
export type PlaceholderOption =
  string | Partial<Record<PlaceholderBlockType, string>>;

export interface MountEditorOptions<
  D extends SchemaDefinition = BaseSchemaDefinition,
> {
  /** Whether the document can be edited. Default `true`; `false` mounts a
   *  read-only renderer (no caret edits, no sync writes). */
  editable?: boolean;
  /**
   * Grow the canvas to fit its content height instead of filling the container
   * (which stays width-sized to its box). The scrollbar is never rendered —
   * there is no scroll region. Use for compact, self-sizing surfaces such as a
   * title field or a single-line editor in a drawer. The host container must be
   * free to grow vertically (don't give it a fixed height). Default `false`.
   */
  autoHeight?: boolean;
  /** Accessible name for the editor's input surface, announced by screen
   *  readers. Defaults to `"Text editor"`. */
  ariaLabel?: string;
  /**
   * Whether to maintain a hidden, semantic DOM mirror of the document for
   * assistive tech to read and navigate (the canvas itself is opaque to screen
   * readers). Kept surgically in sync with the document — only changed blocks
   * are re-serialized. Default `true`; set `false` to opt a host out entirely.
   */
  accessibilityTree?: boolean;
  /**
   * Whether the OS keyboard's native predictive text / autocorrect / sentence
   * autocapitalization is enabled on the input surface. Default `true`. When on,
   * the hidden contenteditable advertises `spellcheck`, `autocorrect`, and
   * `autocapitalize="sentences"`, and the editor keeps the in-progress word in
   * that surface so suggestions appear and can be committed. Set `false` for
   * fields that should suppress all of it (e.g. code-only or token input).
   * (Grammarly-style DOM injectors stay disabled regardless, since they would
   * mutate the input surface.) Even when on, it is withheld automatically while
   * the caret sits in verbatim source — a math/code block or an inline math chip
   * — so the mobile suggestion strip can't offer nonsense fixes for LaTeX.
   */
  nativeAutocomplete?: boolean;
  /**
   * How the hidden contenteditable input surface relates to the document.
   *
   * - `"managed"` (legacy): the surface is a puppet holding only a sentinel plus
   *   the in-progress word/sentence; the engine re-seeds it every keystroke.
   * - `"faithful"`: the surface is a real per-block field holding the focused
   *   block's full text with a real caret, edited by the browser and reconciled
   *   to CRDT ops. This lets the OS keyboard own autocapitalization (including on
   *   new lines), autocorrect, and predictions natively.
   *
   * Defaults to `"faithful"` on iOS (where the managed surface cannot satisfy
   * WebKit's stateful autocapitalization) and `"managed"` elsewhere. Blocks that
   * embed verbatim source (code/math, inline math chips) always use the managed
   * representation regardless. See `docs/input-surface-rebuild.md`.
   */
  inputStrategy?: "managed" | "faithful";
  /**
   * Ghost text shown on empty blocks. Either one generic string applied to
   * every block type, or a per-block-type map
   * (e.g. `{ paragraph: "Write…", heading1: "Title" }`). For paragraphs the
   * value fills both the keyboard and touch variants; `bullet_list` and
   * `numbered_list` share the rendered list-item slot (`bullet_list` wins if
   * both are given). Wins over `placeholderOverrides` for any slot it sets.
   */
  placeholder?: PlaceholderOption;
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
   *   import { LineNode, TextNode } from "@tasfer/editor";
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
   * The canvas-free document schema (`schema.data`) that governs local
   * AUTHORING — its allow-list decides which registered block/mark types the
   * user may create (see `Schema.restrict`). Omit for the unrestricted base
   * schema. `createEditor({ schema })` forwards this automatically; pass it here
   * only when driving `mountEditor` directly with a restricted schema. Rendering
   * is governed by `nodes`/`marks`, not this — a disallowed type still renders.
   */
  schema?: DataSchema<D>;
  /**
   * Restrict which of the doc's blocks this editor renders and edits — a VIEW
   * WINDOW (see {@link ViewWindow}). Omit for a full-document editor (the
   * default). Two editors attached to the same {@link doc} can show disjoint
   * windows (e.g. a title-only surface alongside a full page editor) and stay
   * live-synced through the shared doc. Purely a view/authoring concern: the
   * doc, reducer, and sync are unaffected, so peers converge regardless of any
   * editor's window. See `titleBlockWindow`.
   */
  window?: ViewWindow;
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
   * present, the editor mounts from `doc.getRawBlocks()` and uses `doc._binding`
   * as its id/clock source, so `blocks`/`crdtBinding`/`pageId` are derived from
   * the doc. The caller owns the doc's lifetime — `mountEditor`'s `destroy`
   * detaches its listener but does not destroy the doc.
   */
  doc?: Doc<D>;
}

/**
 * Convert the `placeholder` option (a generic string or a per-block-type map)
 * into a partial {@link PlaceholderStyles} override. A single string fills every
 * placeholder-bearing block type; paragraph values set both the keyboard and
 * touch variants, and `bullet_list`/`numbered_list` map to the shared list-item
 * slot (`bullet_list` wins if both are provided).
 */
function placeholderOptionToStyle(
  placeholder: PlaceholderOption,
): DeepPartial<PlaceholderStyles> {
  const byType: Partial<Record<PlaceholderBlockType, string>> =
    typeof placeholder === "string"
      ? {
          paragraph: placeholder,
          heading1: placeholder,
          heading2: placeholder,
          heading3: placeholder,
          bullet_list: placeholder,
          numbered_list: placeholder,
          todo_list: placeholder,
          math: placeholder,
        }
      : placeholder;

  // bullet_list and numbered_list share the rendered list-item slot.
  const listText = byType.bullet_list ?? byType.numbered_list;
  return {
    ...(byType.paragraph !== undefined
      ? {
          paragraph: {
            keyboardCompatibleText: byType.paragraph,
            touchCompatiableText: byType.paragraph,
          },
        }
      : {}),
    ...(byType.heading1 !== undefined
      ? { heading1: { text: byType.heading1 } }
      : {}),
    ...(byType.heading2 !== undefined
      ? { heading2: { text: byType.heading2 } }
      : {}),
    ...(byType.heading3 !== undefined
      ? { heading3: { text: byType.heading3 } }
      : {}),
    ...(listText !== undefined ? { listItem: { text: listText } } : {}),
    ...(byType.todo_list !== undefined
      ? { todoItem: { text: byType.todo_list } }
      : {}),
    ...(byType.math !== undefined ? { math: { text: byType.math } } : {}),
  };
}

/**
 * Fold the legacy per-instance style options (`padding` /
 * `blockStyleOverrides` / `placeholderOverrides` / `strings` / `fonts`) into a
 * single {@link EditorTheme}, with an explicit `options.theme` merged on top
 * (so it wins).
 */
function optionsToTheme<D extends SchemaDefinition>(
  options?: MountEditorOptions<D>,
): EditorTheme {
  if (!options) return {};
  // Merge placeholderOverrides (styles) with the top-level `placeholder`
  // option, which sets empty-block ghost text per block type (or generically).
  const placeholderStyle = {
    ...(options.placeholderOverrides ?? {}),
    ...(options.placeholder !== undefined
      ? placeholderOptionToStyle(options.placeholder)
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
export function mountEditor<D extends SchemaDefinition = BaseSchemaDefinition>(
  container: HTMLElement,
  blocks: Block[], //NOTE - Should be called state
  options?: MountEditorOptions<D>,
): MountedEditor<D> {
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
    blocks: doc ? doc.getRawBlocks() : blocks,
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
  // Native OS predictive text / autocorrect / autocapitalization. On by default;
  // the editor keeps the in-progress word in this surface so the keyboard can
  // offer and commit suggestions (see `hiddenInputHandler`). The surface is
  // invisible (opacity 0) so spellcheck draws no squiggles — it only feeds the
  // mobile suggestion strip. `autocorrect` is the non-standard iOS attribute.
  const nativeAutocomplete = options?.nativeAutocomplete !== false;
  hiddenInput.setAttribute(
    "autocapitalize",
    nativeAutocomplete ? "sentences" : "off",
  );
  hiddenInput.setAttribute("autocorrect", nativeAutocomplete ? "on" : "off");
  hiddenInput.setAttribute("spellcheck", nativeAutocomplete ? "true" : "false");
  // Suppress Grammarly and similar contenteditable injectors regardless: they
  // would mutate the input surface and corrupt the word-diff input flow.
  hiddenInput.setAttribute("data-gramm", "false");
  // The engine seeds the sentinel content/caret on first focus + render.

  canvasContainer.appendChild(hiddenInput);

  // The editor's reading surface: a visually-hidden but accessibility-tree-VISIBLE
  // container holding a semantic DOM mirror of the document (headings, lists,
  // code, marks). The canvas paints pixels a screen reader cannot see; this tree
  // is what assistive tech reads and navigates. Distinct from `hiddenInput`,
  // which is the input/IME/selection surface. Owned here; its children are driven
  // by the engine's DomMirror, kept surgically in sync with the document.
  const a11yTree =
    options?.accessibilityTree !== false ? document.createElement("div") : null;
  if (a11yTree) {
    a11yTree.setAttribute("role", "document");
    a11yTree.setAttribute("aria-label", options?.ariaLabel ?? "Text editor");
    // Visually hidden, a11y-tree visible (never display:none/visibility:hidden,
    // which would drop it from the a11y tree). Non-interactive and unfocusable —
    // reading only; editing happens through `hiddenInput`.
    a11yTree.style.position = "absolute";
    a11yTree.style.width = "1px";
    a11yTree.style.height = "1px";
    a11yTree.style.overflow = "hidden";
    a11yTree.style.clipPath = "inset(50%)";
    a11yTree.style.whiteSpace = "nowrap";
    a11yTree.style.pointerEvents = "none";
    // Layout-isolate the mirror: it is a full-document-sized hidden subtree, and
    // without containment the browser folds it into every page reflow — so each
    // canvas `getBoundingClientRect` and each mirror mutation re-lays-out the
    // whole tree (this dominated the profile as "Layout"). `strict` = size +
    // layout + paint + style: its 1px box never depends on its contents, and its
    // internal layout neither affects nor is reached by the rest of the page.
    // Containment is a rendering optimization only — it does NOT drop the subtree
    // from the accessibility tree (unlike display:none / content-visibility).
    a11yTree.style.contain = "strict";
    canvasContainer.appendChild(a11yTree);
  }

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

  // Auto-height surfaces grow to fit their content: the editor drives the height
  // and the scrollbar is suppressed. The container must be free to grow (no
  // fixed height); we size the canvas layers from the content height reported by
  // the editor rather than from the container's measured height.
  const autoHeight = options?.autoHeight === true;

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
    // Authoring schema (allow-list + CRDT/serialization facets). Defaults to the
    // base (unrestricted) schema inside createInitialState when omitted.
    schema: options?.schema,
    // Block window (e.g. a title-only surface). Undefined for a full editor.
    window: options?.window,
    // The doc's binding is the shared id/clock source when a doc is attached.
    crdtBinding: doc?._binding ?? options?.crdtBinding,
    theme,
  });

  let baseWidth = initial.width;
  let baseHeight = initial.height;
  let destroyed = false;

  // Auto-height: resize the DOM canvas/container to the content height the editor
  // reports. This runs on every content-height change — including the editor's
  // synchronous first paint during construction below — so it must touch only
  // the DOM (canvas layers, container), never the `editor` binding (which is
  // still in its temporal dead zone during that first call).
  const applyContentHeight = (height: number) => {
    if (destroyed) return;
    const h = Math.max(Math.ceil(height), 1);
    if (h === baseHeight) return;
    baseHeight = h;
    canvasContainer.style.height = `${h}px`;
    portalContainer.style.height = `${h}px`;
    resizeCanvasLayers(layers, baseWidth, h);
  };

  // Create editor with initial state and layered canvases
  const editor = new Editor(
    layers,
    initialState,
    initialViewport,
    hiddenInput,
    {
      a11yContainer: a11yTree ?? undefined,
      inputStrategy: options?.inputStrategy,
      nativeAutocomplete,
      autoHeight,
      onContentHeightChange: autoHeight ? applyContentHeight : undefined,
    },
  );

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

  const resizeCanvas = () => {
    canvasContainer.style.width = `${baseWidth}px`;
    canvasContainer.style.height = `${baseHeight}px`;
    portalContainer.style.width = `${baseWidth}px`;
    portalContainer.style.height = `${baseHeight}px`;
    resizeCanvasLayers(layers, baseWidth, baseHeight);
    editor.updateViewport({ width: baseWidth, height: baseHeight });
  };

  let resizeQueued = false;
  const resizeObserver = new ResizeObserver(() => {
    if (destroyed) return;
    const rect = container.getBoundingClientRect();
    const newWidth = Math.max(rect.width, 1);
    // In auto-height mode the editor owns the height (the container grows with
    // its content, which would otherwise feed back into this observer). Only
    // react to width changes; height is driven by `applyContentHeight`.
    if (autoHeight) {
      if (newWidth === baseWidth) return;
      baseWidth = newWidth;
    } else {
      baseWidth = newWidth;
      baseHeight = Math.max(rect.height, 1);
    }

    // Let host observers update width-dependent theme values before painting;
    // otherwise the editor briefly wraps at the new width with stale padding.
    if (resizeQueued) return;
    resizeQueued = true;
    queueMicrotask(() => {
      resizeQueued = false;
      if (!destroyed) resizeCanvas();
    });
  });
  resizeObserver.observe(container);

  let blurTimeoutId: number | null = null;

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
    contentCanvas.removeEventListener("selectstart", preventSelectStart);
    contentCanvas.removeEventListener("dragstart", preventDragStart);
    destroyCanvasLayers(layers);
    hiddenInput.remove();
    portalContainer.remove();
    canvasContainer.remove();
  };

  return {
    editor: editor as unknown as EditorApi<D>,
    doc,
    refocus,
    blurInput,
    destroy,
    portalContainer,
  };
}
