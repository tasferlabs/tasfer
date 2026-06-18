// `getBlockTextContent` / `getBlockTextLength` / `isTouchDevice` are defined in
// the leaf `node-shared` (not here) and re-exported below: the node views import
// them, and the node registry imports back into this module, so keeping these off
// `state-utils` breaks the `ListNode extends TextNode` circular-init hazard.
import { createActionBus } from "./action-bus";
import type { Mark, MarkRegistry } from "./rendering/marks";
import { createDefaultMarkRegistry } from "./rendering/marks";
import type { Node, NodeRegistry } from "./rendering/nodes";
import { createDefaultNodeRegistry } from "./rendering/nodes";
import {
  createInitialMomentumState,
  createInitialScrollbarState,
} from "./rendering/scrollbar";
import { type Block, type Page } from "./serlization/loadPage";
import type {
  CaretDeleteUnit,
  CaretScratch,
  CRDTbinding as CRDTbindingType,
  EditorMode,
  EditorState,
  EditorTheme,
  LinkHoverState,
  TypedInputTransform,
} from "./state-types";
import { resolveNodeStrings, resolveTheme } from "./styles";

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
    theme?: EditorTheme;
    crdtBinding?: CRDTbindingType;
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

  // The host's raw theme, resolved once into the full style tree. Stored
  // per-instance (not a module global) so two editors on a page style
  // independently and the engine never reads the DOM.
  const theme: EditorTheme = options?.theme ?? {};
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

  return {
    CRDTbinding,
    actionBus,
    nodes,
    marks,
    theme,
    resolvedStyles,
    resolvedNodeStrings,
    document: {
      page,
      cursor: null,
      selection: null,
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
      cursorDrag: null,
      autoCreatedParagraph: null,
      inlineMathHover: null,
      hoveredMathBlockIndex: null,
      caretScratch: null,
      search: { highlights: [], activeIndex: -1 },
    },
    view: {
      isFocused: false,
      isWindowFocused: true,
      clickTracker: {
        count: 0,
        lastClickTime: 0,
        lastClickPosition: null,
      },
      scrollbar: createInitialScrollbarState(),
      momentum: createInitialMomentumState(),
      visibleBlocks: getVisibleBlocks(page),
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

export function updateWindowFocused(
  state: EditorState,
  isWindowFocused: boolean,
): EditorState {
  return {
    ...state,
    view: { ...state.view, isWindowFocused },
  };
}

// Helper Functions

export function createInitialCursorState(state: EditorState): EditorState {
  return {
    ...state,
    document: {
      ...state.document,
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

// Clear auto-created paragraph tracking
export function clearAutoCreatedParagraph(state: EditorState): EditorState {
  if (!state.ui.autoCreatedParagraph) return state;
  return {
    ...state,
    ui: {
      ...state.ui,
      autoCreatedParagraph: null,
    },
  };
}

// ---------------------------------------------------------------------------
// Caret / edit seam
//
// Generic dispatch for the optional caret/edit hooks a node or mark may declare
// (see Node/Mark `caretStep`, `caretVerticalStep`, `caretTokenClamp`,
// `deleteUnit`, `transformTypedInput`, `armCaretScratch`). Each helper asks the
// block's registered node first, then every registered mark, and returns the
// first non-null answer — so the core caret/edit code (selection, actions) never
// names a block type: a node/mark whose inline content is atomic for the caret
// (e.g. math) contributes the behavior, everything else falls through to the
// plain text path. None of this is a module global — the registries live on
// `state`.
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
  return seam(
    state,
    block,
    (n) => n.caretStep?.(block, index, dir) ?? null,
    (m) => m.caretStep?.(block, index, dir) ?? null,
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
    (n) => n.caretVerticalStep?.(block, index, dir) ?? null,
    (m) => m.caretVerticalStep?.(block, index, dir) ?? null,
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
  return seam(
    state,
    block,
    (n) => n.caretTokenClamp?.(block, target, dir) ?? null,
    (m) => m.caretTokenClamp?.(block, target, dir) ?? null,
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
    (n) => n.deleteUnit?.(block, index, dir) ?? null,
    (m) => m.deleteUnit?.(block, index, dir) ?? null,
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
    (n) => n.transformTypedInput?.(block, index, input) ?? null,
    (m) => m.transformTypedInput?.(block, index, input) ?? null,
  );
}

/**
 * The caret-anchored scratch a node/mark wants stashed after an edit at `index`
 * (see {@link CaretScratch}), or `null` for none. Cleared on the next caret move.
 */
export function armCaretScratch(
  state: EditorState,
  block: Block,
  index: number,
): CaretScratch | null {
  return seam(
    state,
    block,
    (n) => n.armCaretScratch?.(block, index) ?? null,
    (m) => m.armCaretScratch?.(block, index) ?? null,
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
