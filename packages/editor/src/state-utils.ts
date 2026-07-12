// `getBlockTextContent` / `getBlockTextLength` / `isTouchDevice` are defined in
// the leaf `node-shared` (not here) and re-exported below: the node views import
// them, and the node registry imports back into this module, so keeping these off
// `state-utils` breaks the `ListNode extends TextNode` circular-init hazard.
import { createActionBus } from "./action-bus";
import { getBaseDataSchema } from "./baseDataSchema";
import type { Mark, MarkRegistry } from "./rendering/marks";
import { createDefaultMarkRegistry } from "./rendering/marks";
import type {
  CaretModel,
  Node,
  NodeRegistry,
  TextSpan,
} from "./rendering/nodes";
import { createDefaultNodeRegistry } from "./rendering/nodes";
import {
  createInitialMomentumState,
  createInitialScrollbarState,
} from "./rendering/scrollbar";
import { type Block, type Page } from "./serlization/loadPage";
import type {
  CaretDeleteUnit,
  CRDTbinding as CRDTbindingType,
  EditorMode,
  EditorState,
  EditorTheme,
  LinkHoverState,
  TypedInputTransform,
  ViewWindow,
} from "./state-types";
import { mergeTheme, resolveNodeStrings, resolveTheme } from "./styles";
import type { DataSchema } from "./sync/schema";

export {
  getBlockTextContent,
  getBlockTextLength,
  isTouchDevice,
} from "./node-shared";
import { initialUndoManagerState } from "./sync/crdt-undo";
import { generatePeerId } from "./sync/id";
import {
  createCRDTbinding,
  getVisibleBlocks,
  maxPageIdCounter,
} from "./sync/sync";

// State Creation Functions
export function createInitialState(
  page: Page,
  options?: {
    mode?: EditorMode;
    nodes?: NodeRegistry;
    marks?: MarkRegistry;
    schema?: DataSchema;
    theme?: EditorTheme;
    crdtBinding?: CRDTbindingType;
    window?: ViewWindow;
  },
): EditorState {
  // Each editor instance owns its own CRDT context. Because the binding is
  // per-instance (not a module global), a readonly snapshot-preview editor can
  // coexist with the main editor on the same page without clobbering its
  // id/clock state — so we always have one, readonly or not.
  //
  // Hosts that sync should pass their own binding (created with the device's
  // persistent peer id) and share it with `createSyncEngine` — one id/clock
  // source for the editor and the sync engine, and ops stamped with the real
  // peer identity instead of a random per-mount one.
  const CRDTbinding =
    options?.crdtBinding ?? createCRDTbinding(page.id, generatePeerId());

  // Advance the id counter past every counter already present in the loaded
  // document (block ids, char-run counters). New local ids must out-counter
  // existing ones or the RGA sibling tie-break (counter-first) places newly
  // split blocks / newly typed chars AFTER pre-existing siblings — i.e. at
  // the end of the page instead of at the cursor.
  CRDTbinding.advanceIdCounter(maxPageIdCounter(page.blocks));

  // Block view registry is likewise per-instance. The host composes it at mount
  // (opt-in block set); default to the built-in views when not provided.
  const nodes = options?.nodes ?? createDefaultNodeRegistry();

  // Inline-mark registry is likewise per-instance (opt-in mark set); default to
  // the built-in marks when not provided.
  const marks = options?.marks ?? createDefaultMarkRegistry();

  // The canvas-free document schema (CRDT/serialization facets + authoring
  // allow-list). Per-instance and immutable; default to the base (unrestricted)
  // schema. Consulted by authoring paths via `state.schema` — never the reducer.
  const schema = options?.schema ?? getBaseDataSchema();

  // This editor's block window (e.g. a title-only TitleEditor), or undefined for
  // a full-document editor. Immutable per instance; every visible-blocks
  // derivation honors it. See ViewWindow.
  const window = options?.window;

  // The host's raw theme, resolved once into the full style tree. Stored
  // per-instance (not a module global) so two editors on a page style
  // independently and the engine never reads the DOM.
  const featureTheme = schema.features.resolveThemeDefaults();
  // Feature defaults sit below the host theme: an installed feature can ship a
  // usable palette/string catalog, while each editor instance remains free to
  // override any leaf. The facet contract is intentionally open so extension
  // packages can own keys the core EditorTheme type does not enumerate.
  const theme = mergeTheme(
    {
      tokens: featureTheme.tokens,
      styles: featureTheme.styles,
      strings: featureTheme.strings,
      nodeStrings: featureTheme.nodeStrings,
    } as EditorTheme,
    options?.theme ?? {},
  );
  const resolvedStyles = resolveTheme(theme);
  // Node string catalogs (image/math status labels, …) resolved per-instance
  // from each registered node's defaults overlaid with theme.nodeStrings.
  const resolvedNodeStrings = resolveNodeStrings(nodes, theme);

  // One bus per editor instance (handlers are per-instance, never global). Let
  // each node install its own action handlers (e.g. CodeNode claims Enter to
  // insert a newline in code blocks) before the state is handed out.
  const actionBus = createActionBus();
  for (const node of nodes.nodeList()) {
    node.registerActions?.(actionBus);
  }
  // Marks register after nodes (claims resolve by priority, not loop order — so
  // e.g. LinkMark's Ctrl+click at 100 still pre-empts a node click claim at 50).
  for (const mark of marks.markList()) {
    mark.registerActions?.(actionBus);
  }
  schema.features.registerActions(actionBus);

  return {
    CRDTbinding,
    actionBus,
    nodes,
    marks,
    schema,
    theme,
    resolvedStyles,
    resolvedNodeStrings,
    document: {
      page,
      cursor: null,
      selection: null,
      contentSelection: null,
    },
    ui: {
      mode: (options?.mode ?? "edit") as EditorMode,
      isReadonlyBase: options?.mode === "readonly",
      activeMenu: { type: "none" },
      isHoveringLinkWithModifier: false,
      isHoveringCheckbox: false,
      isHoveringPeerIndicator: false,
      composition: null,
      activeMarksMode: { type: "inherit" },
      imageHover: null,
      linkHover: null,
      nodeViewState: {},
      selectionHandleDrag: null,
      hoveredDragHandleBlockId: null,
      blockDrag: null,
      externalDropIndex: null,
      inlineMathHover: null,
      hoveredMathBlockIndex: null,
      caretScratch: null,
      decorations: {},
    },
    view: {
      isFocused: false,
      clickTracker: {
        count: 0,
        lastClickTime: 0,
        lastClickPosition: null,
      },
      scrollbar: createInitialScrollbarState(),
      momentum: createInitialMomentumState(),
      visibleBlocks: getVisibleBlocks(page, window),
      window,
    },
    undoManager: initialUndoManagerState,
  };
}
export function updateMode(state: EditorState, mode: EditorMode): EditorState {
  // If editor was initialized as readonly, enforce readonly behavior
  if (state.ui.isReadonlyBase) {
    // Allow switching to "select" for drag selection, or "suspended"
    if (mode === "select" || mode === "suspended") {
      return {
        ...state,
        ui: { ...state.ui, mode },
      };
    }
    // When trying to go to "edit", return to "readonly" instead
    if (mode === "edit") {
      return {
        ...state,
        ui: { ...state.ui, mode: "readonly" },
      };
    }
    return state;
  }
  return {
    ...state,
    ui: { ...state.ui, mode },
  };
}

// Helper Functions

export function createInitialCursorState(state: EditorState): EditorState {
  return {
    ...state,
    document: {
      ...state.document,
      contentSelection: null,
      cursor: {
        position: {
          blockIndex: 0,
          textIndex: 0,
        },
        lastUpdate: Date.now(),
      },
    },
  };
}

// Link Hover State Management — engine-owned hover state (not a blocking menu),
// rendered as a tooltip overlay host-side by the `link` mark.
export function setLinkHover(
  state: EditorState,
  linkHover: LinkHoverState | null,
): EditorState {
  return { ...state, ui: { ...state.ui, linkHover } };
}

// Unified Menu Management
export function setActiveMenu(
  state: EditorState,
  menu: EditorState["ui"]["activeMenu"],
): EditorState {
  return {
    ...state,
    ui: {
      ...state.ui,
      activeMenu: menu,
    },
  };
}

export function closeActiveMenu(state: EditorState): EditorState {
  return setActiveMenu(state, { type: "none" });
}

// ---------------------------------------------------------------------------
// Caret / edit seam
//
// Generic dispatch for the optional caret queries a node or mark may declare on
// its {@link CaretModel} (`caret`): motion, word-nav, delete, typed-input
// rewrite. Each helper asks the block's registered node first, then every
// registered mark, and returns the first non-null answer — so the core
// caret/edit code (selection, actions) never names a block type: a node/mark
// whose inline content is atomic for the caret (e.g. math) contributes the
// behavior, everything else falls through to the plain text path. None of this
// is a module global — the registries live on `state`.
//
// Each query consults the explicit `caret` method first (`move` / `deleteUnit`),
// then — for what a flat token can express (step / word-nav / whole-token
// delete) — falls back to deriving the answer from the declarative
// `caret.atomicSpans`, so a simple chip can implement just `atomicSpans`. (The
// *effect* half of the old seam — materializing a construct / arming caret
// scratch after an edit — is no longer here: it's the `TEXT_INPUTTED` action a
// node/mark observes in `registerActions`.)
// ---------------------------------------------------------------------------

/** First non-null result of `fn` over the block's node, then every mark. */
function seam<R>(
  state: EditorState,
  block: Block,
  fromNode: (n: Node) => R | null,
  fromMark: (m: Mark) => R | null,
): R | null {
  const node = state.nodes.get(block.type);
  if (node) {
    const r = fromNode(node);
    if (r != null) return r;
  }
  for (const mark of state.marks.markList()) {
    const r = fromMark(mark);
    if (r != null) return r;
  }
  return null;
}

// ── Declarative-tier derivations from `caret.atomicSpans` ──────────────────
// The common case ("this span is one atomic token") needs no explicit methods:
// these derive horizontal step / word-nav / whole-token delete from the spans.
// An explicit `caret.move`/`deleteUnit` takes precedence (the lambdas try it
// first via `??`).

/** The atomic span strictly containing `index` (`start < index < end`), or null. */
function activeSpan(
  caret: CaretModel | undefined,
  block: Block,
  index: number,
): TextSpan | null {
  if (!caret?.atomicSpans) return null;
  for (const s of caret.atomicSpans(block)) {
    if (index > s.start && index < s.end) return s;
  }
  return null;
}

/** Step/snap over a containing span to its near edge in travel direction `dir`. */
function edgeFromSpans(
  caret: CaretModel | undefined,
  block: Block,
  index: number,
  dir: "left" | "right",
): number | null {
  const s = activeSpan(caret, block, index);
  return s ? (dir === "left" ? s.start : s.end) : null;
}

/** Whole-token delete when the caret sits on a span's edge facing the delete. */
function deleteUnitFromSpans(
  caret: CaretModel | undefined,
  block: Block,
  index: number,
  dir: "backward" | "forward",
): CaretDeleteUnit | null {
  if (!caret?.atomicSpans) return null;
  for (const s of caret.atomicSpans(block)) {
    const onEdge = dir === "backward" ? index === s.end : index === s.start;
    if (onEdge) return { from: s.start, to: s.end, isConstruct: false };
  }
  return null;
}

/**
 * Next legal caret index stepping `dir` (logical `left`/`right`) from `index`, or
 * `null` when the step is in plain text (caller does its own ±1). Lets atomic
 * inline content (a math command/construct) be stepped over as one token.
 */
export function caretStep(
  state: EditorState,
  block: Block,
  index: number,
  dir: "left" | "right",
): number | null {
  const motion = dir === "left" ? "charLeft" : "charRight";
  return seam(
    state,
    block,
    (n) =>
      n.caret?.move?.(block, index, motion) ??
      edgeFromSpans(n.caret, block, index, dir),
    (m) =>
      m.caret?.move?.(block, index, motion) ??
      edgeFromSpans(m.caret, block, index, dir),
  );
}

/**
 * Vertical caret motion *within* the block (between stacked rows of a formula),
 * or `null` to leave the block via ordinary line navigation.
 */
export function caretVerticalStep(
  state: EditorState,
  block: Block,
  index: number,
  dir: "up" | "down",
): number | null {
  return seam(
    state,
    block,
    (n) => n.caret?.move?.(block, index, dir) ?? null,
    (m) => m.caret?.move?.(block, index, dir) ?? null,
  );
}

/**
 * Pull a word-navigation target out of the middle of an atomic inline token,
 * clamping it to the token's near/far edge in travel direction `dir`. Returns
 * `null` when `target` isn't inside a token (caller uses it unchanged).
 */
export function caretTokenClamp(
  state: EditorState,
  block: Block,
  target: number,
  dir: "left" | "right",
): number | null {
  const motion = dir === "left" ? "wordLeft" : "wordRight";
  return seam(
    state,
    block,
    (n) =>
      n.caret?.move?.(block, target, motion) ??
      edgeFromSpans(n.caret, block, target, dir),
    (m) =>
      m.caret?.move?.(block, target, motion) ??
      edgeFromSpans(m.caret, block, target, dir),
  );
}

/**
 * Snap a non-collapsed range selection `[anchor, focus]` within one block so it
 * never partially covers a connected construct, level-awarely (see
 * {@link CaretModel.selectionRange}), or `null` when nothing needs snapping.
 * `focusEdge` is the direction the focus travelled. Node-agnostic: the block's
 * node/marks answer, plain text falls through to `null`.
 */
export function selectionRangeAt(
  state: EditorState,
  block: Block,
  anchor: number,
  focus: number,
  focusEdge: "start" | "end",
): { anchor: number; focus: number } | null {
  return seam(
    state,
    block,
    (n) => n.caret?.selectionRange?.(block, anchor, focus, focusEdge) ?? null,
    (m) => m.caret?.selectionRange?.(block, anchor, focus, focusEdge) ?? null,
  );
}

/**
 * The editing unit adjacent to the caret to delete/select (see
 * {@link CaretDeleteUnit}), or `null` when the caret isn't in atomic content
 * (caller does its plain character/word delete).
 */
export function resolveDeleteUnit(
  state: EditorState,
  block: Block,
  index: number,
  dir: "backward" | "forward",
): CaretDeleteUnit | null {
  return seam(
    state,
    block,
    (n) =>
      n.caret?.deleteUnit?.(block, index, dir) ??
      deleteUnitFromSpans(n.caret, block, index, dir),
    (m) =>
      m.caret?.deleteUnit?.(block, index, dir) ??
      deleteUnitFromSpans(m.caret, block, index, dir),
  );
}

/**
 * Let a node/mark rewrite a typed string before insertion (e.g. inserting a
 * command-separating space) and/or veto inline-markdown for this keystroke. Returns
 * `null` when no node/mark claims it (insert the input verbatim).
 */
export function transformTypedInput(
  state: EditorState,
  block: Block,
  index: number,
  input: string,
): TypedInputTransform | null {
  return seam(
    state,
    block,
    (n) => n.caret?.transformInput?.(block, index, input) ?? null,
    (m) => m.caret?.transformInput?.(block, index, input) ?? null,
  );
}

/**
 * Whether {@link UIState.caretScratch} is armed at exactly `(blockId, offset)` —
 * i.e. caret-anchored UI is live here. Type-agnostic: the slot is singular and
 * anchored to the caret, so whatever armed it owns this position. Read by the
 * content that armed it (e.g. inline/block math, to render an in-progress
 * command literally) to gate that rendering.
 */
export function isCaretScratchActive(
  state: EditorState,
  blockId: string,
  offset: number,
): boolean {
  const s = state.ui.caretScratch;
  return s != null && s.blockId === blockId && s.offset === offset;
}
