// `getBlockTextContent` / `isTouchDevice` are defined in the leaf `node-shared`
// (not here) and re-exported below: the node views import them, and the node
// registry imports back into this module, so keeping those two off `state-utils`
// breaks the `ListNode extends TextNode` circular-init hazard.
import { createCommandBus } from "./command-bus";
import type { MarkRegistry } from "./rendering/marks";
import { createDefaultMarkRegistry } from "./rendering/marks";
import type { NodeRegistry } from "./rendering/nodes";
import { createDefaultNodeRegistry } from "./rendering/nodes";
import {
  createInitialMomentumState,
  createInitialScrollbarState,
} from "./rendering/scrollbar";
import { type Block, type Page } from "./serlization/loadPage";
import type {
  CRDTbinding as CRDTbindingType,
  EditorMode,
  EditorState,
  EditorTheme,
  LinkHoverState,
} from "./state-types";
import { resolveNodeStrings, resolveTheme } from "./styles";

export { getBlockTextContent, isTouchDevice } from "./node-shared";
import { isTextualBlock } from "./sync/block-registry";
import { getVisibleLengthFromRuns } from "./sync/char-runs";
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

  return {
    CRDTbinding,
    // One bus per editor instance (handlers are per-instance, never global).
    commandBus: createCommandBus(),
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
      imageDrag: null,
      selectionHandleDrag: null,
      cursorDrag: null,
      autoCreatedParagraph: null,
      inlineMathHover: null,
      hoveredMathBlockIndex: null,
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
    // Allow switching to "select" for drag selection, or "locked"
    if (mode === "select" || mode === "locked") {
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

export function getBlockTextLength(block: Block): number {
  if (!block) return 0;

  if (!isTextualBlock(block)) return 0;

  return getVisibleLengthFromRuns(block.charRuns);
}

// Slash Command State Management
export function openSlashCommand(
  state: EditorState,
  blockIndex: number,
  textIndex: number,
): EditorState {
  return setActiveMenu(state, {
    type: "slashCommand",
    blockIndex,
    textIndex,
    filter: "",
  });
}

export function updateSlashCommandFilter(
  state: EditorState,
  filter: string,
): EditorState {
  if (state.ui.activeMenu.type !== "slashCommand") return state;
  return setActiveMenu(state, {
    ...state.ui.activeMenu,
    filter,
  });
}

export function closeSlashCommand(state: EditorState): EditorState {
  return closeActiveMenu(state);
}

// Context Menu State Management
export function openContextMenu(
  state: EditorState,
  x: number,
  y: number,
  hoveredItemId?: string | null,
): EditorState {
  return setActiveMenu(state, { type: "contextMenu", x, y, hoveredItemId });
}

export function closeContextMenu(state: EditorState): EditorState {
  return closeActiveMenu(state);
}

export function updateContextMenuHover(
  state: EditorState,
  hoveredItemId: string | null,
): EditorState {
  if (state.ui.activeMenu.type !== "contextMenu") return state;
  return {
    ...state,
    ui: {
      ...state.ui,
      activeMenu: {
        ...state.ui.activeMenu,
        hoveredItemId,
      },
    },
  };
}

export function selectContextMenuItem(
  state: EditorState,
  selectedItemId: string,
): EditorState {
  if (state.ui.activeMenu.type !== "contextMenu") return state;
  return {
    ...state,
    ui: {
      ...state.ui,
      activeMenu: {
        ...state.ui.activeMenu,
        selectedItemId,
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
