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

/**
 * What {@link mountEditor} returns: the `editor` you drive, the document it
 * shows (when you passed one), a container for your own floating UI, and the
 * calls to refocus, blur and `destroy` it.
 */
export interface MountedEditor<
  D extends SchemaDefinition = BaseSchemaDefinition,
> {
  readonly editor: EditorApi<D>;
  /**
   * The document this editor shows, when you passed one in
   * {@link MountEditorOptions.doc}. `undefined` when you mounted without a doc.
   *
   * Sync and saving go through it. Use `doc.applyUpdate` for changes coming in,
   * `doc.on("update")` for changes going out, and `doc.load` for saved changes
   * that are already in its blocks.
   */
  readonly doc?: Doc<D>;
  /**
   * A layer on top of the editor for your own floating UI, such as a slash
   * menu. Use it as a React portal target. It ignores pointer events, so set
   * `pointer-events: auto` on what you put inside.
   */
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

/**
 * Options for {@link mountEditor}: whether the editor is editable, how it sizes
 * itself, accessibility and keyboard behavior, placeholders, theme, fonts, the
 * schema and the document to show. Every field is optional.
 */
export interface MountEditorOptions<
  D extends SchemaDefinition = BaseSchemaDefinition,
> {
  /**
   * Whether the user can edit the document. Default `true`. With `false` the
   * document is read-only: the user cannot type, but changes that come in
   * through the doc still show up.
   */
  editable?: boolean;
  /**
   * Makes the editor grow with its content instead of filling the container.
   * The width still follows the container. There is no scrollbar. Use it for
   * small fields, such as a title or a one-line editor in a drawer. The
   * container must be free to grow, so do not give it a fixed height. Default
   * `false`.
   */
  autoHeight?: boolean;
  /** Accessible name for the editor's input surface, announced by screen
   *  readers. Defaults to `"Text editor"`. */
  ariaLabel?: string;
  /**
   * Keeps a hidden HTML copy of the document so screen readers can read and
   * move through it. Screen readers cannot see the canvas. Only changed blocks
   * are updated. Default `true`. Set `false` to turn it off.
   */
  accessibilityTree?: boolean;
  /**
   * Turns on the keyboard's own suggestions, autocorrect and capital letters at
   * the start of a sentence. Default `true`. Set `false` for fields where these
   * get in the way, such as code-only or token input.
   *
   * Even when on, they are paused while the caret is in a code block, a math
   * block or inline math. Tools like Grammarly are always kept off.
   */
  // When on, the hidden contenteditable gets spellcheck, autocorrect and
  // autocapitalize="sentences", and the editor keeps the in-progress word in it
  // so suggestions can be committed. data-gramm=false is always set because
  // such injectors would mutate the input surface.
  nativeAutocomplete?: boolean;
  /**
   * How the editor's hidden text field takes keyboard input.
   *
   * - `"managed"`: the hidden field holds only the word you are typing (on
   *   phones, the sentence). The editor refills it on every key.
   * - `"faithful"`: the hidden field holds the whole text of the block you are
   *   in, with a real caret. The OS keyboard then handles capital letters (also
   *   on new lines), autocorrect and suggestions by itself.
   *
   * Default: `"faithful"` on iOS, `"managed"` everywhere else. Code blocks,
   * math blocks and any block with inline math always use `"managed"`.
   */
  // iOS defaults to faithful because the managed surface cannot satisfy
  // WebKit's stateful autocapitalization. Design notes were in
  // docs/input-surface-rebuild.md, which is not in the repo.
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
   * How this editor looks (see {@link EditorTheme}): color `tokens`, `styles`
   * to change any single style, `fonts`, the chosen `fontFamily`, and
   * translated `strings` and `nodeStrings`. Each editor has its own theme, and
   * the editor never reads your CSS. Change it later with `editor.setTheme`.
   *
   * It wins over the old `padding`, `blockStyleOverrides`,
   * `placeholderOverrides`, `strings` and `fonts` options.
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
   * Your font families: a name for each CSS font stack, plus the one to use by
   * default. You load the font files yourself. Omit it to use system fonts.
   * @deprecated Use `theme.fonts`.
   */
  fonts?: Partial<FontStyles> | null;
  /**
   * The block types this editor can show. Each editor has its own list, so two
   * editors can support different blocks. Omit it to use the built-in blocks.
   *
   * An editor without the image block:
   *
   * ```ts
   * import { LineNode, ListNode, QuoteNode, TextNode, mountEditor } from "@tasfer/editor";
   *
   * mountEditor(el, blocks, {
   *   nodes: [new LineNode(), new QuoteNode(), new TextNode(), new ListNode()],
   * });
   * ```
   */
  nodes?: readonly Node[];
  /**
   * The inline marks this editor can show, such as bold or links. Each editor
   * has its own list, so two editors can support different marks. Omit it to
   * use the built-in marks. Works like `nodes`.
   */
  marks?: readonly Mark[];
  /**
   * Limits which blocks and marks the user can create. Pass `schema.data` from
   * a schema made with `Schema.restrict`. Omit it to allow everything.
   *
   * `createEditor({ schema })` passes this for you. Set it here only when you
   * call `mountEditor` yourself with a restricted schema.
   *
   * It does not change what is shown. A block the schema does not allow still
   * shows if it is in `nodes`/`marks`.
   */
  schema?: DataSchema<D>;
  /**
   * Shows and edits only some of the doc's blocks (see {@link ViewWindow}).
   * Omit it to show the whole document.
   *
   * Two editors on the same `doc` can show different parts, such as a title
   * field above the page body. They stay in sync through the doc. The window
   * only changes what this editor shows. The document and sync are not
   * affected. See {@link titleBlockWindow}.
   */
  window?: ViewWindow;
  /**
   * This editor's sync identity: its peer id, clock and id counter. Most hosts
   * pass `doc` instead, and then this is ignored because the doc brings its
   * own.
   *
   * Omit it for a standalone editor. One with a random peer id is made for you.
   *
   * Only for the low-level sync engine in `@tasfer/editor/internal`: make one
   * binding with `createCRDTbinding(pageId, peerId)` and pass the same binding
   * to `createSyncEngine`.
   */
  crdtBinding?: CRDTbinding;
  /**
   * An existing document to show and edit (see {@link createDoc}). Edits made
   * in the editor go into the doc. Updates applied to the doc from elsewhere
   * (`doc.applyUpdate`) show up in the editor.
   *
   * With a doc, the editor starts from the doc's blocks and uses the doc's own
   * page id and sync identity. So `blocks`, `crdtBinding` and `pageId` are
   * ignored.
   *
   * You own the doc. `destroy` unhooks the editor from it but does not destroy
   * the doc.
   */
  // Local edits reach the doc through doc._ingestLocal; the editor uses
  // doc._binding as its id/clock source.
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
 * Mounts the editor into `container` and shows `blocks`. This is the
 * lower-level way in. Most apps use {@link createEditor}, which also reads
 * Markdown and makes the document for you.
 *
 * When you pass `options.doc`, the editor shows the doc's blocks and ignores
 * `blocks`. Without a doc, edits live only in the editor.
 *
 * Returns a {@link MountedEditor}. Call its `destroy` when you are done.
 *
 * ```ts
 * import { createDoc, mountEditor } from "@tasfer/editor";
 *
 * const doc = createDoc({ markdown: "# Hello" });
 * const { editor, destroy } = mountEditor(el, doc.getRawBlocks(), { doc });
 * // …later
 * destroy();
 * ```
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
  // The canvas is only draggable while the pointer rests on selected text (the
  // editor raises the flag from its hover path, so a native text drag can
  // begin). Any other dragstart is the browser trying to drag the canvas image
  // itself — refuse those.
  const preventDragStart = (e: Event) => {
    if (!contentCanvas.draggable) e.preventDefault();
  };
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
  // Pin the font so the surface's line box — which is what the OS reads as the
  // IME caret rect when placing the candidate window — depends only on the
  // `lineHeight` the engine sets per frame from the painted caret height, never
  // on whatever font-size the host page happens to cascade in.
  hiddenInput.style.fontSize = "12px";
  hiddenInput.style.lineHeight = "1";
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

  // iOS can drop a backgrounded WebView's canvas backing store: the layers come
  // back blank (and their contexts reset to an unscaled transform) with nothing
  // marked dirty, so the surface would sit on an empty or stale frame until the
  // next edit. Re-size the layers and repaint on the way back to the foreground.
  const onVisibilityChange = () => {
    if (destroyed || document.visibilityState !== "visible") return;
    resizeCanvas();
  };
  document.addEventListener("visibilitychange", onVisibilityChange);

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
    document.removeEventListener("visibilitychange", onVisibilityChange);
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
