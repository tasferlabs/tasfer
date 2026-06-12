import { useP2PRoom, type SyncState } from "@/app/hooks/useP2PRoom";
import { Button } from "@/components/ui/button";
import { hasNativeBridge } from "@cypherkit/editor/actions/clipboard";
import {
  positionToAwarenessCursor,
  selectionToAwarenessSelection,
  type AwarenessState,
  type AwarenessUser,
} from "@cypherkit/editor/sync/awareness";
import {
  createCRDTbinding,
  createSyncEngine,
  serializeVV,
  type SyncEngine,
} from "@cypherkit/editor/sync/sync";
import type { Operation } from "@cypherkit/editor/state-types";
import { getPlatform } from "@/platform";
import {
  Bold,
  Clipboard,
  Code,
  Copy,
  Download,
  Image as ImageIcon,
  Italic,
  Link,
  Scissors,
  Strikethrough,
  Type,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ComponentType } from "react";
import { CursorMagnifier } from "./components/CursorMagnifier";
import {
  MobileKeyboardToolbar,
  type BlockType as MobileBlockType,
} from "./components/MobileKeyboardToolbar";
import { useKeyboardOpen } from "./hooks/useKeyboardOpen";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { Block } from "@cypherkit/editor/serlization/loadPage";
import { ContextMenu, type ContextMenuItem } from "../editor/ContextMenu";
import { FindBar } from "../editor/FindBar";
import { ImageUploadPopover } from "../editor/ImageUploadPopover";
import { MathBlockEditor } from "../editor/MathBlockEditor";
import { LinkDrawer } from "../editor/LinkDrawer";
import { LinkEditPopover } from "../editor/LinkEditPopover";
import { LinkTooltip } from "../editor/LinkTooltip";
import { SlashCommandMenu } from "../editor/SlashCommandMenu";
import {
  getFormatsAtPosition,
  getSelectionRange,
} from "@cypherkit/editor/actions/commands";
import {
  mountEditor,
  type MountedEditor as MountedEditorInstance,
} from "@cypherkit/editor/entries/mount";
import { clearFailedImageCache } from "@cypherkit/editor/rendering/renderer";
import { getLinkAtPosition } from "@cypherkit/editor/selection";
import {
  getBlockTextContent,
  getBlockTextLength,
  isTouchDevice,
} from "@cypherkit/editor/state-utils";
import { allCharsHaveFormat } from "@cypherkit/editor/sync/crdt-utils";
import type {
  CursorDragState,
  EditorState,
  EditorStrings,
  NodeOverlay,
  PlaceholderStyles,
  SlashCommand,
  TextStyle,
} from "@cypherkit/editor/state-types";
import i18next from "i18next";
import { cssVarsToTheme, readEditorTokens } from "../editorTheme";
import { getAppFontRegistry, onAppFontRegistryChange } from "../fonts";
import { cn, shallowEqual } from "../lib/utils";
import { uploadImage } from "./api/images.api";
import {
  fontStyleToFamily,
  usePageSettings,
} from "./contexts/PageSettingsContext";
import { EditorLoadingState } from "./pages/EditorPage";
import { isTextualBlock } from "@cypherkit/editor/sync/block-registry";

/**
 * Localized cross-node canvas strings (block placeholders). The
 * @cypherkit/editor package ships English defaults and no i18n library, so the
 * host passes translations at mount. Evaluated at mount time — fine, since
 * changing the language happens on the Settings page where no editor is
 * mounted; the next mount picks up the new language.
 *
 * Strings owned by a single block type live on the node, not here — see
 * {@link editorNodeStrings}.
 */
function editorStrings(): EditorStrings {
  return {
    placeholderHeading1: i18next.t("blocks.heading1"),
    placeholderHeading2: i18next.t("blocks.heading2"),
    placeholderHeading3: i18next.t("blocks.heading3"),
    placeholderParagraph: i18next.t("editor.typeForCommands"),
    placeholderParagraphTouch: i18next.t("editor.typeSomething"),
    placeholderListItem: i18next.t("blocks.listItem"),
    placeholderTodoItem: i18next.t("blocks.todoItem"),
  };
}

/**
 * Per-node localized strings, keyed by block type then the node's local string
 * key (mirrors each node's `strings` catalog). Passed as `theme.nodeStrings`;
 * the editor overlays these onto the nodes' English defaults per instance.
 */
function editorNodeStrings(): Record<string, Record<string, string>> {
  return {
    image: {
      clickToUpload: i18next.t("image.clickToUpload"),
      loading: i18next.t("image.loading"),
      uploading: i18next.t("image.uploading"),
      uploadFailed: i18next.t("error.failedToUploadImage"),
      clickToRetry: i18next.t("common.clickToRetry"),
      changeImage: i18next.t("image.changeImage"),
    },
    math: {
      clickToEdit: i18next.t("math.clickToEdit"),
    },
  };
}

/**
 * Host overlay registry: maps a node-declared overlay `key` (see
 * {@link NodeOverlay}) to the React component that renders it. Node-declared
 * overlays are framework-free in the engine — this registry is where they
 * become real UI, positioned at the descriptor's `rect`.
 *
 * Empty for now: the built-in image-upload / math popovers still render through
 * their own `activeMenu` paths. They migrate onto this registry in a follow-up;
 * custom nodes register their editing chrome here today.
 */
type NodeOverlayProps = {
  readonly overlay: NodeOverlay;
  readonly editor: MountedEditorInstance["editor"];
};
const NODE_OVERLAYS: Record<string, ComponentType<NodeOverlayProps>> = {};

/**
 * Structural compare of two overlay lists so we only re-render the React tree
 * when `collectOverlays()` actually changes (it runs every state tick).
 */
function nodeOverlaysEqual(a: NodeOverlay[], b: NodeOverlay[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.key !== y.key ||
      x.blockIndex !== y.blockIndex ||
      x.rect.x !== y.rect.x ||
      x.rect.y !== y.rect.y ||
      x.rect.width !== y.rect.width ||
      x.rect.height !== y.rect.height
    ) {
      return false;
    }
  }
  return true;
}

async function downloadImage(url: string, alt?: string): Promise<void> {
  const isAlreadyUrl =
    url.startsWith("blob:") ||
    url.startsWith("data:") ||
    url.startsWith("http://") ||
    url.startsWith("https://");
  let resolvedUrl = url;
  if (!isAlreadyUrl) {
    try {
      resolvedUrl = await getPlatform().assets.getUrl(url);
    } catch {
      // fall through; fetch will fail
    }
  }

  const response = await fetch(resolvedUrl);
  const blob = await response.blob();

  const extFromMime = blob.type.split("/")[1]?.split(";")[0];
  const extFromUrl = url.match(/\.([a-zA-Z0-9]+)(?:\?|$)/)?.[1];
  const ext = extFromUrl || extFromMime || "png";
  const baseName = (alt && alt.trim()) || "image";
  const safeName = baseName.replace(/[/\\?%*:|"<>]/g, "-");
  const filename = safeName.toLowerCase().endsWith(`.${ext.toLowerCase()}`)
    ? safeName
    : `${safeName}.${ext}`;

  const bridge = window.CypherBridge;
  if (bridge) {
    const base64 = await blobToBase64(blob);
    const mimeType = blob.type || `image/${ext}`;
    await bridge.files.shareFile(base64, filename, mimeType);
    return;
  }

  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(objectUrl);
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// --- Cursor position persistence ---
const CURSOR_STORAGE_KEY = "cypher:cursor-positions";
const MAX_STORED_PAGES = 50;

interface StoredCursorPosition {
  blockIndex: number;
  textIndex: number;
  scrollY: number;
}

function saveCursorPosition(pageId: string, position: StoredCursorPosition) {
  try {
    const raw = localStorage.getItem(CURSOR_STORAGE_KEY);
    const map: Record<string, StoredCursorPosition> = raw
      ? JSON.parse(raw)
      : {};
    map[pageId] = position;

    // Evict oldest entries if over limit
    const keys = Object.keys(map);
    if (keys.length > MAX_STORED_PAGES) {
      for (const key of keys.slice(0, keys.length - MAX_STORED_PAGES)) {
        delete map[key];
      }
    }

    localStorage.setItem(CURSOR_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Ignore storage errors
  }
}

function loadCursorPosition(pageId: string): StoredCursorPosition | null {
  try {
    const raw = localStorage.getItem(CURSOR_STORAGE_KEY);
    if (!raw) return null;
    const map: Record<string, StoredCursorPosition> = JSON.parse(raw);
    return map[pageId] ?? null;
  } catch {
    return null;
  }
}

interface MountedEditorProps {
  snapshot: Block[];
  className?: string;
  /** Called when content changes locally (for saving). */
  onContentChange?: (blocks: Block[]) => void;
  /** Callback for all content updates (local and remote) - used for word count, etc. */
  onContentUpdate?: (blocks: (Block & { originalIndex: number })[]) => void;
  autoFocus?: boolean;
  /** Unique page ID for CRDT sync - if provided, enables live collaboration */
  pageId: string;
  /** Space ID that owns this page - required for P2P sync to use the correct topic */
  spaceId?: string;
  /** Callback when sync state changes */
  onSyncStateChange?: (state: SyncState) => void;
  /** Callback when active users change */
  onAwarenessChange?: (users: AwarenessUser[]) => void;
  /** Callback when restore function is ready */
  onRestoreReady?: (restoreFn: (blocks: Block[]) => void) => void;
  /** When true, editor is read-only - no editing, no CRDT sync, no native bridge updates */
  readonly?: boolean;
  /** Override default canvas padding */
  padding?: Partial<{
    paddingTop: number;
    paddingBottom: number;
    paddingLeft: number;
    paddingRight: number;
  }>;
  /** Override block text styles (e.g. heading font sizes) */
  blockStyleOverrides?: Partial<Record<string, Partial<TextStyle>>> | null;
  /** Override placeholder copy for a specific mounted editor instance */
  placeholderOverrides?: Partial<PlaceholderStyles> | null;
  /** Callback when canvas scroll position changes */
  onScroll?: (scrollY: number) => void;
}

export function MountedEditor({
  snapshot,
  className = "",
  onContentChange,
  onContentUpdate,
  autoFocus = false,
  pageId,
  spaceId,
  onSyncStateChange,
  onAwarenessChange,
  onRestoreReady,
  readonly = false,
  padding,
  blockStyleOverrides,
  placeholderOverrides,
  onScroll,
}: MountedEditorProps) {
  const { setOnOpenFind, fontStyle } = usePageSettings();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const { t } = useTranslation();
  const mountedRef = useRef<MountedEditorInstance | null>(null);
  const syncEngineRef = useRef<SyncEngine | null>(null);
  const onScrollRef = useRef(onScroll);
  // Latest selected font family, read at mount time without making it a mount
  // dependency (changing it re-themes via setTheme below, not a full re-mount).
  const fontStyleRef = useRef(fontStyle);
  fontStyleRef.current = fontStyle;
  onScrollRef.current = onScroll;
  const onContentChangeRef = useRef(onContentChange);
  onContentChangeRef.current = onContentChange;
  const onContentUpdateRef = useRef(onContentUpdate);
  onContentUpdateRef.current = onContentUpdate;
  const [slashMenuState, setSlashMenuState] = useState<{
    visible: boolean;
    x: number;
    y: number;
    selectedIndex: number;
    filter: string;
  } | null>(null);

  const [contextMenuState, setContextMenuState] = useState<{
    x: number;
    y: number;
    hasSelection: boolean;
    hoveredItemId?: string | null;
  } | null>(null);

  const [linkTooltipState, setLinkTooltipState] = useState<{
    x: number;
    y: number;
    url: string;
    text: string;
  } | null>(null);

  const [linkEditState, setLinkEditState] = useState<{
    x: number;
    y: number;
    url: string;
    text: string;
    blockIndex: number;
    startIndex: number;
    endIndex: number;
    savedCursor: EditorState["document"]["cursor"];
    savedSelection: EditorState["document"]["selection"];
  } | null>(null);

  const [imageUploadState, setImageUploadState] = useState<{
    x: number;
    y: number;
    blockIndex: number;
    uploadStatus: "idle" | "uploading" | "complete" | "error";
  } | null>(null);

  const [mathEditState, setMathEditState] = useState<{
    x: number;
    y: number;
    blockIndex: number;
  } | null>(null);

  const [inlineMathEditState, setInlineMathEditState] = useState<{
    x: number;
    y: number;
    blockIndex: number;
    startIndex: number;
    endIndex: number;
    latex: string;
  } | null>(null);

  const [imageHoverState, setImageHoverState] = useState<{
    x: number;
    y: number;
    width: number;
    height: number;
    blockIndex: number;
    hoveredHandle: "left" | "right" | "bottom" | null;
  } | null>(null);

  const lastImageHoverStateRef = useRef<typeof imageHoverState>(null);
  const persistedImageHoverRef = useRef<typeof imageHoverState>(null);

  // Cursor drag state (for mobile magnifier)
  const [cursorDragState, setCursorDragState] = useState<CursorDragState | null>(null);
  const lastCursorDragStateRef = useRef<CursorDragState | null>(null);

  // Node-declared overlay slots (engine, framework-free) collected each state
  // tick and rendered via NODE_OVERLAYS. The ref dedupes equivalent collections
  // so an unchanged set doesn't churn the React tree.
  const [nodeOverlays, setNodeOverlays] = useState<NodeOverlay[]>([]);
  const lastNodeOverlaysRef = useRef<NodeOverlay[]>([]);

  // Find bar state
  const [findBarOpen, setFindBarOpen] = useState(false);
  const findBarOpenRef = useRef(false);
  findBarOpenRef.current = findBarOpen;
  const [findSearchText, setFindSearchText] = useState("");
  const [findMatches, setFindMatches] = useState<
    { blockIndex: number; startIndex: number; endIndex: number }[]
  >([]);
  const [findActiveIndex, setFindActiveIndex] = useState(0);

  // Register find callback for PageSettings drawer
  useEffect(() => {
    setOnOpenFind(() => setFindBarOpen(true));
    return () => setOnOpenFind(null);
  }, [setOnOpenFind]);

  const lastSlashMenuStateRef = useRef<typeof slashMenuState>(null);
  const lastContextMenuStateRef = useRef<typeof contextMenuState>(null);
  const lastLinkTooltipStateRef = useRef<typeof linkTooltipState>(null);
  const linkEditActionPerformedRef = useRef(false);
  const lastSerializedBlocksRef = useRef<
    EditorState["document"]["page"]["blocks"] | null
  >(null);
  const editorInitializedRef = useRef(false);
  // Preserve live editor content across HMR re-mounts (refs survive Fast Refresh)
  const liveBlocksRef = useRef<{ blocks: Block[]; pageId: string } | null>(
    null,
  );
  // Track when applying remote operations to prevent triggering saves for non-local changes
  const isApplyingRemoteOpsRef = useRef(false);
  // Spinner overlay: hidden once we've confirmed local storage state (ops
  // loaded or snapshot has content). Keyed by pageId rather than a boolean so
  // a page switch hides the canvas on the very first render (a boolean reset
  // in the mount effect lands one render too late, flashing the previous
  // page's content) and so a stale reveal from a previous page's pending
  // rAF/ops-load can't dismiss the new page's overlay.
  const [readyPageId, setReadyPageId] = useState<string | null>(null);
  const isContentReady = readyPageId === pageId;

  // Mobile keyboard toolbar state (updated on every editor state change)
  const [mobileToolbar, setMobileToolbar] = useState({
    canUndo: false,
    canRedo: false,
    isBold: false,
    isItalic: false,
    isCode: false,
    isStrikethrough: false,
    blockType: "paragraph" as MobileBlockType,
    isEditorFocused: false,
  });
  const { isKeyboardOpen, keyboardHeight } = useKeyboardOpen();

  // Forward the authoritative keyboard height into the canvas resize logic.
  // mount.ts no longer uses window.visualViewport directly because it is
  // unreliable on iOS (resize:"none") and Android (edge-to-edge mode).
  useEffect(() => {
    mountedRef.current?.setKeyboardHeight(keyboardHeight);
  }, [keyboardHeight]);

  // Push the selected font family (serif/sans page setting) into the live
  // editor as a theme change — no full re-mount, no module global.
  useEffect(() => {
    mountedRef.current?.editor.setTheme({
      fontFamily: fontStyleToFamily(fontStyle),
    });
  }, [fontStyle]);

  // Track current toolbar icon type
  const currentIconTypeRef = useRef<"link" | "image" | "format" | "none">(
    "format",
  );

  // Callbacks for useRoom - use refs to avoid recreating callbacks
  const onRoomOperationsRef = useRef<((ops: Operation[]) => void) | null>(null);
  const onRoomSyncResponseRef = useRef<
    ((ops: Operation[], vv: Record<string, number>) => void) | null
  >(null);
  const onRoomAwarenessRef = useRef<
    ((awarenesspeerId: string, state: AwarenessState | null) => void) | null
  >(null);
  const onRoomFirstPeerRef = useRef<(() => void) | null>(null);
  const onRoomPeerJoinedRef = useRef<((peerId: string) => void) | null>(null);
  const onRoomAwarenessStatesRef = useRef<
    ((states: Record<string, AwarenessState>) => void) | null
  >(null);
  const onRoomJoinedRef = useRef<((hasOtherPeers: boolean) => void) | null>(
    null,
  );

  // Use the P2P room subscription (WebRTC DataChannels)
  const {
    broadcast: roomBroadcast,
    broadcastAwareness: roomBroadcastAwareness,
    sendSyncRequest: roomSendSyncRequest,
    syncState,
    localUser,
    peerId,
  } = useP2PRoom(
    pageId,
    {
      onOperations: useCallback((ops: Operation[]) => {
        onRoomOperationsRef.current?.(ops);
      }, []),
      onSyncResponse: useCallback(
        (ops: Operation[], vv: Record<string, number>) => {
          onRoomSyncResponseRef.current?.(ops, vv);
        },
        [],
      ),
      onAwarenessUpdate: useCallback(
        (pId: string, state: AwarenessState | null) => {
          onRoomAwarenessRef.current?.(pId, state);
        },
        [],
      ),
      onFirstPeer: useCallback(() => {
        onRoomFirstPeerRef.current?.();
      }, []),
      onPeerJoined: useCallback((pId: string) => {
        onRoomPeerJoinedRef.current?.(pId);
      }, []),
      onAwarenessStates: useCallback(
        (states: Record<string, AwarenessState>) => {
          onRoomAwarenessStatesRef.current?.(states);
        },
        [],
      ),
      onJoined: useCallback((hasOtherPeers: boolean) => {
        onRoomJoinedRef.current?.(hasOtherPeers);
      }, []),
    },
    spaceId,
  );

  // Refs for values from useP2PRoom that should NOT cause editor re-mount.
  // Reading from refs inside the big useEffect avoids destroying/recreating
  // the editor (and nulling all callback refs) when these change.
  const peerIdRef = useRef(peerId);
  peerIdRef.current = peerId;
  const localUserRef = useRef(localUser);
  localUserRef.current = localUser;

  // Notify parent of sync state changes
  useEffect(() => {
    onSyncStateChange?.(syncState);
  }, [syncState, onSyncStateChange]);

  // Native drawer states (triggered by format button on mobile)
  const [nativeLinkDrawerState, setNativeLinkDrawerState] = useState<{
    x: number;
    y: number;
    url?: string;
    linkText?: string;
    selectedText?: string;
    blockIndex?: number;
    startIndex?: number;
    endIndex?: number;
  } | null>(null);

  const [nativeImageDrawerState, setNativeImageDrawerState] = useState<{
    x: number;
    y: number;
    blockIndex: number;
  } | null>(null);

  // Imperatively mount/unmount editor (no React state needed)
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;

    // Clean up any previous mount (e.g., content changes, strict mode re-mount)
    if (mountedRef.current) {
      mountedRef.current.destroy();
      mountedRef.current = null;
    }

    // Clean up previous sync engine
    if (syncEngineRef.current) {
      syncEngineRef.current = null;
    }

    // Reset serialization tracking and initialization flag when snapshot changes
    lastSerializedBlocksRef.current = null;
    editorInitializedRef.current = false;

    // Use live editor content if available (HMR re-mount for same page), otherwise use snapshot prop
    const initialBlocks =
      liveBlocksRef.current?.pageId === pageId
        ? liveBlocksRef.current.blocks
        : snapshot;
    liveBlocksRef.current = null;

    // One CRDT binding per page mount — the single id/clock/peer-identity
    // source shared by the editor (which stamps local ops with it) and the
    // sync engine (which advances it past loaded/remote ops). Sharing it means
    // no manual clock/id-counter mirroring between the two, and local ops are
    // stamped with our persistent peer id instead of a random per-mount one.
    const crdtBinding = createCRDTbinding(pageId, peerIdRef.current);

    const mounted = mountEditor(el, initialBlocks, {
      editable: !readonly,
      pageId,
      padding,
      blockStyleOverrides,
      placeholderOverrides,
      strings: editorStrings(),
      // The editor is headless and never reads the DOM for styling — feed it our
      // current `--editor-*` CSS variables as theme tokens. Kept in sync with
      // dark-mode toggles via the MutationObserver below (editor.setTheme).
      // Fonts (registry + selected family) ride on the theme too; both update
      // live via the subscriptions below.
      theme: {
        ...cssVarsToTheme(),
        fonts: getAppFontRegistry(),
        fontFamily: fontStyleToFamily(fontStyleRef.current),
        nodeStrings: editorNodeStrings(),
      },
      crdtBinding,
    });
    mountedRef.current = mounted;

    // Re-push theme tokens whenever the document root's class changes (the
    // dark-mode toggle swaps the `.dark` class, which flips the CSS variables).
    const themeObserver = new MutationObserver(() => {
      mounted.editor.setTheme({ tokens: readEditorTokens() });
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    // Re-theme when the app font registry changes (e.g. Arabic stacks load).
    const offFontRegistry = onAppFontRegistryChange(() => {
      mounted.editor.setTheme({ fonts: getAppFontRegistry() });
    });

    // True if snapshot has any block with actual text (not just the auto-generated empty init block).
    // Used to decide whether to show the spinner overlay until local ops are confirmed loaded.
    const snapshotHasContent = initialBlocks.some((b) => {
      if (isTextualBlock(b)) return b.charRuns.some((r) => r.text.length > 0);
      return true; // image and line blocks are always real content
    });

    if (snapshotHasContent) {
      // Content is already in the snapshot — reveal after the canvas renders its first frame.
      requestAnimationFrame(() => setReadyPageId(pageId));
    }

    // Wire up scroll callback
    mounted.editor.onScroll((scrollY) => {
      onScrollRef.current?.(scrollY);
    });

    // Skip offline store and sync setup in readonly mode
    if (readonly) {
      // In readonly mode, we only render the content - no sync, no offline store
      // Subscribe to state changes for context menu only
      const unsubscribe = mounted.editor.subscribe((state: EditorState) => {
        // Node-declared overlay slots (engine, framework-free) → host registry.
        // Recollected each tick; only pushed to React state when the set changes.
        const newOverlays = mounted.editor.collectOverlays();
        if (!nodeOverlaysEqual(newOverlays, lastNodeOverlaysRef.current)) {
          lastNodeOverlaysRef.current = newOverlays;
          setNodeOverlays(newOverlays);
        }

        // Calculate context menu state for readonly mode
        let newContextMenuState: typeof contextMenuState = null;
        if (state.ui.activeMenu.type === "contextMenu") {
          const containerRect = wrapperRef.current?.getBoundingClientRect();
          if (containerRect) {
            const hasSelection = !!getSelectionRange(state);
            newContextMenuState = {
              x: containerRect.left + state.ui.activeMenu.x,
              y: containerRect.top + state.ui.activeMenu.y,
              hasSelection,
              hoveredItemId: state.ui.activeMenu.hoveredItemId,
            };

            // Handle drag-and-release selection
            if (state.ui.activeMenu.selectedItemId) {
              const selectedItemId = state.ui.activeMenu.selectedItemId;
              // Execute the action asynchronously
              setTimeout(async () => {
                if (!mountedRef.current) return;
                const editor = mountedRef.current.editor;
                switch (selectedItemId) {
                  case "copy":
                    await editor.copy();
                    break;
                  case "selectAll":
                    editor.commands.selectAll();
                    editor.closeActiveMenu();
                    break;
                }
              }, 0);
              newContextMenuState = null;
            }
          }
        }

        if (
          !shallowEqual(newContextMenuState, lastContextMenuStateRef.current)
        ) {
          lastContextMenuStateRef.current = newContextMenuState;
          setContextMenuState(newContextMenuState);
        }
      });

      // Readonly mode never receives sync updates, so reveal immediately if not already done.
      if (!snapshotHasContent) {
        setReadyPageId(pageId);
      }

      return () => {
        unsubscribe();
        themeObserver.disconnect();
        offFontRegistry();
        mounted.destroy();
        if (mountedRef.current === mounted) {
          mountedRef.current = null;
        }
      };
    }

    // Load persisted operations from SQLite (if any)
    // This restores the sync engine's VV and applies any ops that arrived
    // while the page was closed (e.g. from bulk P2P sync while offline).
    // Load persisted ops into SyncEngine for VV tracking.
    // Page content is already rebuilt from ops by the engine, so no need
    // to apply them to the editor — just feed the SyncEngine.
    const platform = getPlatform();
    const opsLoadedPromise = platform.ops.load(pageId).then((persistedOps) => {
      if (persistedOps.length > 0 && syncEngineRef.current) {
        // loadOperations also advances the shared CRDT binding's clock and
        // id-counter past every loaded op, so new local operations (typing,
        // restore, etc.) out-order and out-counter historical ones.
        syncEngineRef.current.loadOperations(persistedOps);
      }
      // Local storage confirmed — we have whatever we have. Reveal the canvas.
      if (!snapshotHasContent) {
        requestAnimationFrame(() => setReadyPageId(pageId));
      }
    });

    // Expose restore function to parent
    if (onRestoreReady) {
      onRestoreReady((blocks: Block[]) => {
        mounted.editor.restoreFromSnapshot(blocks);
      });
    }

    // Initialize sync engine for CRDT on the same binding as the editor
    // (same peerId as WebSocket, single shared clock/id source).
    const syncEngine = createSyncEngine(crdtBinding);
    syncEngineRef.current = syncEngine;

    // Debounced snapshot writer — keeps the FS snapshot in sync after edits.
    // 2s delay avoids writing on every keystroke.
    let snapshotTimer: ReturnType<typeof setTimeout> | null = null;
    const saveSnapshot = (blocks: Block[]) => {
      if (snapshotTimer) clearTimeout(snapshotTimer);
      snapshotTimer = setTimeout(() => {
        platform.snapshots.save(pageId, blocks);
      }, 2000);
    };

    // Apply remote ops to the in-memory sync engine and update the editor.
    // Persistence is handled by the Replicator before ops reach these callbacks.
    const applyRemoteOps = (ops: Operation[]) => {
      isApplyingRemoteOpsRef.current = true;
      // apply() advances the shared CRDT binding's clock and id-counter past
      // all received ops, so subsequent local operations (typing, deleting)
      // respect causality with no extra bookkeeping here.
      syncEngine.apply(ops);
      mounted.editor.updatePageFromSync(syncEngine.getState());
      saveSnapshot(syncEngine.getState().blocks);
      isApplyingRemoteOpsRef.current = false;
    };

    // Wire up room callbacks to sync engine and editor
    // These refs are called by useRoom when messages arrive
    onRoomOperationsRef.current = applyRemoteOps;

    onRoomSyncResponseRef.current = (ops, _versionVector) => {
      if (ops.length > 0) {
        applyRemoteOps(ops);
      }
    };

    onRoomFirstPeerRef.current = () => {
      // The editor already has the initial content loaded
    };

    // When a new peer joins our room, re-broadcast our awareness so they see our cursor
    onRoomPeerJoinedRef.current = (_joinedPeerId) => {
      if (!localUserRef.current.peerId) return;
      const editorState = mounted.editor.getState();
      if (editorState) {
        const { page, cursor, selection } = editorState.document;
        roomBroadcastAwareness({
          user: localUserRef.current,
          cursor: cursor
            ? positionToAwarenessCursor(cursor.position, page)
            : null,
          selection:
            selection && !selection.isCollapsed
              ? selectionToAwarenessSelection(selection, page)
              : null,
          lastUpdate: Date.now(),
        });
      }
    };

    onRoomAwarenessRef.current = (awarenesspeerId, state) => {
      mounted.editor.setRemoteAwareness(awarenesspeerId, state);

      if (onAwarenessChange) {
        const remoteAwareness = mounted.editor.getRemoteAwareness();
        const users = Array.from(remoteAwareness.values()).map((s) => s.user);
        onAwarenessChange(users);
      }
    };

    onRoomAwarenessStatesRef.current = (states) => {
      for (const [awarenesspeerId, state] of Object.entries(states)) {
        mounted.editor.setRemoteAwareness(awarenesspeerId, state);
      }

      if (onAwarenessChange) {
        const users = Object.values(states).map((s) => s.user);
        onAwarenessChange(users);
      }
    };

    // Handle room join/rejoin - request VV-based sync from peers
    onRoomJoinedRef.current = (hasOtherPeers) => {
      if (hasOtherPeers) {
        // Wait for persisted ops to load so the VV is accurate
        opsLoadedPromise.then(() => {
          const localVV = serializeVV(syncEngine.getVersionVector());
          roomSendSyncRequest(localVV);
        });

        // Broadcast current awareness state so peers see our cursor
        const editorState = mounted.editor.getState();
        if (editorState) {
          const { page, cursor, selection } = editorState.document;
          roomBroadcastAwareness({
            user: localUserRef.current,
            cursor: cursor
              ? positionToAwarenessCursor(cursor.position, page)
              : null,
            selection:
              selection && !selection.isCollapsed
                ? selectionToAwarenessSelection(selection, page)
                : null,
            lastUpdate: Date.now(),
          });
        }
      }
    };

    // Connect editor's broadcast to room
    mounted.editor.setBroadcast((ops) => {
      // Add to sync engine's log
      syncEngine.emit(ops);
      // Broadcast to peers
      roomBroadcast(ops);
      // Persist to SQLite
      platform.ops.persist(pageId, ops);
      // Keep FS snapshot in sync so next page-open skips the op-log rebuild
      saveSnapshot(syncEngine.getState().blocks);
    });

    // Connect editor's awareness broadcast to room
    // Guard: don't broadcast before P2P identity loads (localUserRef starts as { peerId: "", color: "" })
    mounted.editor.setAwarenessBroadcast((state: AwarenessState) => {
      if (!localUserRef.current.peerId) return;
      roomBroadcastAwareness(state);
    }, localUserRef.current);

    // Handle pasted image files (e.g. screenshots) — upload and update block URL
    mounted.editor.onImagePaste(async (file, blockIndex) => {
      try {
        const imageData = await uploadImage(file);
        // Revoke the temporary blob URL
        const state = mounted.editor.getState();
        if (state) {
          const block = state.document.page.blocks[blockIndex];
          if (
            block &&
            block.type === "image" &&
            block.url?.startsWith("blob:")
          ) {
            URL.revokeObjectURL(block.url);
          }
        }
        mounted.editor.updateImageBlock(blockIndex, {
          url: imageData.url,
          alt: imageData.fileName,
        });
      } catch (error) {
        console.error("Image paste upload failed:", error);
      }
    });

    // Handle format button clicks from native
    // Returns true if handled, false if native should open block menu
    const handleFormatButtonClick = (): boolean => {
      const state = mounted.editor.getState();
      if (!state) return false;

      const containerRect = wrapperRef.current?.getBoundingClientRect();
      if (!containerRect) return false;

      const iconType = currentIconTypeRef.current;

      if (iconType === "image") {
        // Open image drawer for selected image
        if (state.document.selection && !state.document.selection.isCollapsed) {
          const { anchor } = state.document.selection;
          const block = state.document.page.blocks[anchor.blockIndex];
          if (block && block.type === "image") {
            setNativeImageDrawerState({
              x: containerRect.left + containerRect.width / 2,
              y: containerRect.top + 100,
              blockIndex: anchor.blockIndex,
            });
            return true;
          }
        }
        return false;
      } else if (iconType === "link") {
        // Open link drawer for selected text or existing link
        if (state.document.cursor) {
          const linkData = getLinkAtPosition(
            state.document.cursor.position,
            state,
          );

          if (linkData) {
            // Editing existing link
            setNativeLinkDrawerState({
              x: containerRect.left + containerRect.width / 2,
              y: containerRect.top + 100,
              url: linkData.url,
              linkText: linkData.text,
              blockIndex: state.document.cursor.position.blockIndex,
              startIndex: linkData.startIndex,
              endIndex: linkData.endIndex,
            });
            return true;
          } else if (
            state.document.selection &&
            !state.document.selection.isCollapsed
          ) {
            // Creating new link from selection
            const range = getSelectionRange(state);
            if (range) {
              const { start, end } = range;
              const block = state.document.page.blocks[start.blockIndex];
              if (block && block.type !== "image") {
                const text = getBlockTextContent(block);
                const selectedText = text.substring(
                  start.textIndex,
                  end.textIndex,
                );

                setNativeLinkDrawerState({
                  x: containerRect.left + containerRect.width / 2,
                  y: containerRect.top + 100,
                  selectedText,
                  blockIndex: start.blockIndex,
                  startIndex: start.textIndex,
                  endIndex: end.textIndex,
                });
                return true;
              }
            }
          }
        }
        return false;
      }

      // For "format" icon type, let native handle it (open block menu)
      return false;
    };

    // Expose editor methods to window for native bridges
    const editorMethods = {
      undo: () => mounted.editor.commands.undo(),
      redo: () => mounted.editor.commands.redo(),
      setBlockType: (type: string) =>
        mounted.editor.commands.setBlock(type as any),
      focus: () => {
        mounted.editor.setFocus(true);
        mounted.editor.setInitialCursor();
      },
      onFormatButtonClick: handleFormatButtonClick,
      toggleBold: () => mounted.editor.commands.toggleMark("strong"),
      toggleItalic: () => mounted.editor.commands.toggleMark("emphasis"),
      toggleCode: () => mounted.editor.commands.toggleMark("code"),
      toggleStrikethrough: () => mounted.editor.commands.toggleMark("strike"),
    };

    window.CypherEditorCallbacks = editorMethods;

    // Subscribe to editor state changes for slash command and context menu
    const handleStateChange = (state: EditorState) => {
      // Notify parent of content changes if callback is provided
      // Only serialize when blocks actually change (not on cursor blink, UI changes, etc.)
      if (
        (onContentChangeRef.current || onContentUpdateRef.current) &&
        state.document.page?.blocks
      ) {
        const currentBlocks = state.document.page.blocks;

        // On first state change, store the initial blocks and notify for read-only callbacks
        // Skip onContentChange to prevent overwriting backend content with empty state on mount
        if (!editorInitializedRef.current) {
          lastSerializedBlocksRef.current = currentBlocks;
          editorInitializedRef.current = true;
          // Still call onContentUpdate for read-only purposes (word count, export)
          onContentUpdateRef.current?.(state.view.visibleBlocks);
          return;
        }

        // Check if blocks reference has changed (indicates actual content modification)
        if (currentBlocks !== lastSerializedBlocksRef.current) {
          lastSerializedBlocksRef.current = currentBlocks;

          // Notify of all content updates (local and remote) - used for word count, etc.
          onContentUpdateRef.current?.(state.view.visibleBlocks);

          // Only trigger saves for local user-initiated changes, not remote peer updates
          // Remote peers handle saving their own changes
          if (!isApplyingRemoteOpsRef.current) {
            // Close find bar when user starts editing
            if (findBarOpenRef.current) handleFindCloseRef.current?.();
          }
          if (!isApplyingRemoteOpsRef.current && onContentChangeRef.current) {
            onContentChangeRef.current(currentBlocks as Block[]);
          }
        }
      }

      // Calculate new slash command state
      let newSlashState: typeof slashMenuState = null;
      if (
        state.ui.activeMenu.type === "slashCommand" &&
        state.document.cursor
      ) {
        const cursorScreenPos = mounted.editor.getCursorScreenPosition();

        if (cursorScreenPos) {
          const containerRect = wrapperRef.current?.getBoundingClientRect();
          if (containerRect) {
            const x = containerRect.left + cursorScreenPos.x;
            const y =
              containerRect.top + cursorScreenPos.y + cursorScreenPos.height;

            newSlashState = {
              visible: true,
              x,
              y,
              selectedIndex: state.ui.activeMenu.selectedIndex,
              filter: state.ui.activeMenu.filter,
            };
          }
        }
      }

      // Only update if changed
      if (!shallowEqual(newSlashState, lastSlashMenuStateRef.current)) {
        lastSlashMenuStateRef.current = newSlashState;
        setSlashMenuState(newSlashState);
      }

      // Calculate new context menu state
      let newContextMenuState: typeof contextMenuState = null;
      if (state.ui.activeMenu.type === "contextMenu") {
        const containerRect = wrapperRef.current?.getBoundingClientRect();
        if (containerRect) {
          const hasSelection = !!getSelectionRange(state);
          newContextMenuState = {
            x: containerRect.left + state.ui.activeMenu.x,
            y: containerRect.top + state.ui.activeMenu.y,
            hasSelection,
            hoveredItemId: state.ui.activeMenu.hoveredItemId,
          };

          // Handle drag-and-release selection
          if (state.ui.activeMenu.selectedItemId) {
            const selectedItemId = state.ui.activeMenu.selectedItemId;
            // Execute the action asynchronously to avoid state mutation during render
            setTimeout(() => {
              handleContextMenuAction(selectedItemId);
            }, 0);
            // Close the menu immediately
            newContextMenuState = null;
          }
        }
      }

      // Only update if changed
      if (!shallowEqual(newContextMenuState, lastContextMenuStateRef.current)) {
        lastContextMenuStateRef.current = newContextMenuState;
        setContextMenuState(newContextMenuState);
      }

      // Calculate new link tooltip state
      let newLinkTooltipState: typeof linkTooltipState = null;
      if (state.ui.activeMenu.type === "linkHover") {
        newLinkTooltipState = {
          x: state.ui.activeMenu.x,
          y: state.ui.activeMenu.y,
          url: state.ui.activeMenu.url,
          text: state.ui.activeMenu.text,
        };
      }

      // Only update if changed
      if (!shallowEqual(newLinkTooltipState, lastLinkTooltipStateRef.current)) {
        lastLinkTooltipStateRef.current = newLinkTooltipState;
        setLinkTooltipState(newLinkTooltipState);
      }

      // Calculate new image upload state
      if (state.ui.activeMenu.type === "imageUpload") {
        const containerRect = wrapperRef.current?.getBoundingClientRect();
        if (containerRect) {
          setImageUploadState({
            x: containerRect.left + state.ui.activeMenu.x,
            y: containerRect.top + state.ui.activeMenu.y,
            blockIndex: state.ui.activeMenu.blockIndex,
            uploadStatus: state.ui.activeMenu.uploadStatus || "idle",
          });
        }
      } else if (imageUploadState) {
        setImageUploadState(null);
      }

      // Calculate math edit state
      if (state.ui.activeMenu.type === "mathEdit") {
        const containerRect = wrapperRef.current?.getBoundingClientRect();
        if (containerRect) {
          setMathEditState({
            x: containerRect.left + state.ui.activeMenu.x,
            y: containerRect.top + state.ui.activeMenu.y,
            blockIndex: state.ui.activeMenu.blockIndex,
          });
        }
      } else if (mathEditState) {
        setMathEditState(null);
      }

      // Calculate inline math edit state
      if (state.ui.activeMenu.type === "inlineMathEdit") {
        const containerRect = wrapperRef.current?.getBoundingClientRect();
        if (containerRect) {
          setInlineMathEditState({
            x: containerRect.left + state.ui.activeMenu.x,
            y: containerRect.top + state.ui.activeMenu.y,
            blockIndex: state.ui.activeMenu.blockIndex,
            startIndex: state.ui.activeMenu.startIndex,
            endIndex: state.ui.activeMenu.endIndex,
            latex: state.ui.activeMenu.latex,
          });
        }
      } else if (inlineMathEditState) {
        setInlineMathEditState(null);
      }

      // Calculate new image hover state
      let newImageHoverState: typeof imageHoverState = null;
      // Don't show hover button when dragging an image
      if (state.ui.imageHover && !state.ui.imageDrag) {
        newImageHoverState = {
          x: state.ui.imageHover.x,
          y: state.ui.imageHover.y,
          width: state.ui.imageHover.width,
          height: state.ui.imageHover.height,
          blockIndex: state.ui.imageHover.blockIndex,
          hoveredHandle: state.ui.imageHover.hoveredHandle,
        };
        // Persist this state for when the menu transitions
        persistedImageHoverRef.current = newImageHoverState;
      }

      // Clear hover state when dragging
      if (state.ui.imageDrag) {
        newImageHoverState = null;
      }

      // Only update if changed
      if (!shallowEqual(newImageHoverState, lastImageHoverStateRef.current)) {
        lastImageHoverStateRef.current = newImageHoverState;
        setImageHoverState(newImageHoverState);
      }

      // Clear persisted state when image upload closes
      if (state.ui.activeMenu.type !== "imageUpload") {
        persistedImageHoverRef.current = null;
      }

      // Update cursor drag state for magnifier
      const newCursorDragState = state.ui.cursorDrag ?? null;
      if (!shallowEqual(newCursorDragState, lastCursorDragStateRef.current)) {
        lastCursorDragStateRef.current = newCursorDragState;
        setCursorDragState(newCursorDragState);
      }

      // Update toolbar icon based on selection state
      const determineToolbarIcon = (): "link" | "image" | "format" | "none" => {
        // Check if an image block is selected
        if (state.document.selection && !state.document.selection.isCollapsed) {
          const { anchor, focus } = state.document.selection;
          // If selection is on a single block
          if (anchor.blockIndex === focus.blockIndex) {
            const block = state.document.page.blocks[anchor.blockIndex];
            if (block && block.type === "image") {
              return "image";
            }
          } else {
            // Selection spans multiple blocks - don't show any icon
            return "none";
          }
        }

        // Check if cursor is in a link or text is selected
        if (state.document.cursor) {
          const linkData = getLinkAtPosition(
            state.document.cursor.position,
            state,
          );
          if (linkData) {
            return "link";
          }
        }

        // Check if there's a text selection (show link icon to allow creating links)
        if (state.document.selection && !state.document.selection.isCollapsed) {
          const range = getSelectionRange(state);
          if (range) {
            const { start, end } = range;
            // Only show link icon if selection is within a single block
            if (start.blockIndex === end.blockIndex) {
              const block = state.document.page.blocks[start.blockIndex];
              if (block && block.type !== "image") {
                return "link";
              }
            }
          }
        }

        return "format";
      };

      const iconType = determineToolbarIcon();

      // Update the ref so format button handler knows current icon
      currentIconTypeRef.current = iconType;

      // Send formatting state to native bridge
      // When there's a selection, check if ALL chars have the format
      const range = getSelectionRange(state);
      let isBold: boolean;
      let isItalic: boolean;
      let isCode: boolean;
      let isStrikethrough: boolean;

      if (range && range.start.blockIndex === range.end.blockIndex) {
        // Single block selection: check if all chars have each format
        const block = state.document.page.blocks[range.start.blockIndex];
        if (isTextualBlock(block)) {
          isBold = allCharsHaveFormat(
            block.charRuns,
            block.formats,
            range.start.textIndex,
            range.end.textIndex,
            "strong",
          );
          isItalic = allCharsHaveFormat(
            block.charRuns,
            block.formats,
            range.start.textIndex,
            range.end.textIndex,
            "emphasis",
          );
          isCode = allCharsHaveFormat(
            block.charRuns,
            block.formats,
            range.start.textIndex,
            range.end.textIndex,
            "code",
          );
          isStrikethrough = allCharsHaveFormat(
            block.charRuns,
            block.formats,
            range.start.textIndex,
            range.end.textIndex,
            "strike",
          );
        } else {
          isBold = isItalic = isCode = isStrikethrough = false;
        }
      } else {
        // No selection or multi-block: use cursor position
        const getActiveMarks = () => {
          if (state.ui.activeMarksMode.type === "explicit") {
            return state.ui.activeMarksMode.formats;
          }
          if (state.document.cursor) {
            const { blockIndex, textIndex } = state.document.cursor.position;
            const block = state.document.page.blocks[blockIndex];
            return getFormatsAtPosition(block, textIndex) || [];
          }
          return [];
        };
        const activeMarks = getActiveMarks();
        isBold = activeMarks.some((f) => f.type === "strong");
        isItalic = activeMarks.some((f) => f.type === "emphasis");
        isCode = activeMarks.some((f) => f.type === "code");
        isStrikethrough = activeMarks.some((f) => f.type === "strike");
      }

      // Update mobile toolbar state
      const cursorBlockIndex = state.document.cursor?.position.blockIndex;
      const cursorBlock =
        cursorBlockIndex !== undefined
          ? state.document.page.blocks[cursorBlockIndex]
          : null;
      const rawBlockType = cursorBlock?.type ?? "paragraph";
      // Map editor block types to MobileBlockType
      const MOBILE_BLOCK_TYPES: readonly MobileBlockType[] = [
        "paragraph",
        "heading1",
        "heading2",
        "heading3",
        "bullet_list",
        "numbered_list",
        "todo_list",
        "image",
        "line",
      ];
      const blockType: MobileBlockType = MOBILE_BLOCK_TYPES.includes(
        rawBlockType as MobileBlockType,
      )
        ? (rawBlockType as MobileBlockType)
        : "paragraph";

      setMobileToolbar({
        canUndo: state.undoManager.undoStack.length > 0,
        canRedo: state.undoManager.redoStack.length > 0,
        isBold,
        isItalic,
        isCode,
        isStrikethrough,
        blockType,
        isEditorFocused: state.view.isFocused,
      });
    };

    const unsubscribe = mounted.editor.subscribe(handleStateChange);

    // Auto-focus the editor when requested
    if (autoFocus) {
      // Use a small timeout to ensure the editor is fully initialized
      setTimeout(() => {
        mounted.editor.setFocus(true);

        // Try to restore saved cursor position, fall back to initial
        const saved = loadCursorPosition(pageId);
        const editorState = mounted.editor.getState();

        if (saved && editorState) {
          const blocks = editorState.document.page.blocks;
          // Clamp blockIndex to valid range
          let blockIndex = Math.min(saved.blockIndex, blocks.length - 1);
          if (blockIndex < 0) blockIndex = 0;

          // Clamp textIndex to valid range for the target block
          const block = blocks[blockIndex];
          const maxTextIndex = block ? getBlockTextLength(block) : 0;
          const textIndex = Math.min(saved.textIndex, maxTextIndex);

          mounted.editor.restoreCursorAndSelection(
            { position: { blockIndex, textIndex }, lastUpdate: Date.now() },
            null,
          );

          // Restore scroll position
          if (saved.scrollY > 0) {
            mounted.editor.updateViewport({ scrollY: saved.scrollY });
          }
        } else {
          mounted.editor.setInitialCursor();
        }
      }, 0);
    }

    return () => {
      unsubscribe();
      themeObserver.disconnect();
      offFontRegistry();

      // Capture live editor state before destroying
      const editorState = mounted.editor.getState();

      // Preserve content for HMR re-mount (refs survive Fast Refresh)
      if (editorState?.document.page?.blocks) {
        liveBlocksRef.current = {
          blocks: editorState.document.page.blocks as Block[],
          pageId,
        };
      }

      // Save cursor position before destroying
      if (editorState?.document.cursor) {
        saveCursorPosition(pageId, {
          blockIndex: editorState.document.cursor.position.blockIndex,
          textIndex: editorState.document.cursor.position.textIndex,
          scrollY: mounted.editor.getScrollY(),
        });
      }

      // Clear room callback refs
      onRoomOperationsRef.current = null;
      onRoomSyncResponseRef.current = null;
      onRoomAwarenessRef.current = null;
      onRoomFirstPeerRef.current = null;
      onRoomPeerJoinedRef.current = null;
      onRoomAwarenessStatesRef.current = null;
      onRoomJoinedRef.current = null;

      // Cancel pending snapshot write
      if (snapshotTimer) clearTimeout(snapshotTimer);

      // Clean up sync engine
      if (syncEngineRef.current) {
        syncEngineRef.current = null;
      }

      mounted.destroy();

      delete window.CypherEditorCallbacks;
      if (mountedRef.current === mounted) {
        mountedRef.current = null;
      }
    };
  }, [
    snapshot,
    autoFocus,
    pageId,
    roomBroadcast,
    roomBroadcastAwareness,
    roomSendSyncRequest,
    // peerId and localUser are read from refs (peerIdRef, localUserRef) to avoid
    // destroying/recreating the editor when the P2P identity loads asynchronously.
    // This prevents a race where callback refs are briefly null during re-mount.
    readonly,
    padding,
    blockStyleOverrides,
    placeholderOverrides,
  ]);

  // Update editor's awareness user when localUser becomes available
  // (without re-mounting the entire editor)
  useEffect(() => {
    if (mountedRef.current && localUser.peerId) {
      mountedRef.current.editor.setAwarenessBroadcast(
        (state: AwarenessState) => {
          roomBroadcastAwareness(state);
        },
        localUser,
      );
      // Re-broadcast current cursor state so connected peers overwrite any stale
      // awareness entry they stored before our identity finished loading (color: "").
      const editorState = mountedRef.current.editor.getState();
      if (editorState) {
        const { page, cursor, selection } = editorState.document;
        roomBroadcastAwareness({
          user: localUser,
          cursor: cursor
            ? positionToAwarenessCursor(cursor.position, page)
            : null,
          selection:
            selection && !selection.isCollapsed
              ? selectionToAwarenessSelection(selection, page)
              : null,
          lastUpdate: Date.now(),
        });
      }
    }
  }, [localUser, roomBroadcastAwareness]);

  // Global keyboard shortcuts for find — listen on document so they work even
  // when the editor canvas doesn't have focus, but skip when a dialog or drawer is open.
  const handleFindCloseRef = useRef<() => void>(null);
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't intercept when a dialog or drawer is open
      if (document.querySelector('[role="dialog"]')) return;

      if ((e.ctrlKey || e.metaKey) && e.key === "f") {
        e.preventDefault();
        setFindBarOpen(true);
      } else if (e.key === "Escape" && findBarOpenRef.current) {
        e.preventDefault();
        handleFindCloseRef.current?.();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Search logic — compute matches when search text or page content changes
  const performSearch = useCallback((text: string) => {
    if (!text || !mountedRef.current) {
      setFindMatches([]);
      setFindActiveIndex(0);
      mountedRef.current?.editor.clearSearchHighlights();
      return;
    }

    const state = mountedRef.current.editor.getState();
    if (!state) return;

    const matches: {
      blockIndex: number;
      startIndex: number;
      endIndex: number;
    }[] = [];
    const lowerSearch = text.toLowerCase();

    for (let i = 0; i < state.document.page.blocks.length; i++) {
      const block = state.document.page.blocks[i];
      if (block.deleted) continue;
      const content = getBlockTextContent(block).toLowerCase();
      if (!content) continue;

      let pos = 0;
      while (true) {
        const idx = content.indexOf(lowerSearch, pos);
        if (idx === -1) break;
        matches.push({
          blockIndex: i,
          startIndex: idx,
          endIndex: idx + text.length,
        });
        pos = idx + 1;
      }
    }

    setFindMatches(matches);
    const newActiveIndex = matches.length > 0 ? 0 : -1;
    setFindActiveIndex(newActiveIndex >= 0 ? newActiveIndex : 0);
    mountedRef.current.editor.setSearchHighlights(
      matches,
      newActiveIndex >= 0 ? newActiveIndex : -1,
    );
    // Scroll to first match
    if (matches.length > 0) {
      mountedRef.current.editor.scrollToPosition({
        blockIndex: matches[0].blockIndex,
        textIndex: matches[0].startIndex,
      });
    }
  }, []);

  const handleFindSearchChange = useCallback(
    (text: string) => {
      setFindSearchText(text);
      performSearch(text);
    },
    [performSearch],
  );

  const navigateToMatch = useCallback(
    (index: number) => {
      if (findMatches.length === 0 || !mountedRef.current) return;
      setFindActiveIndex(index);
      mountedRef.current.editor.setSearchHighlights(findMatches, index);
      const match = findMatches[index];
      if (match) {
        mountedRef.current.editor.restoreCursorAndSelection(
          {
            position: {
              blockIndex: match.blockIndex,
              textIndex: match.endIndex,
            },
            lastUpdate: Date.now(),
          },
          {
            anchor: {
              blockIndex: match.blockIndex,
              textIndex: match.startIndex,
            },
            focus: { blockIndex: match.blockIndex, textIndex: match.endIndex },
            isForward: true,
            isCollapsed: false,
            lastUpdate: Date.now(),
          },
        );
        mountedRef.current.editor.scrollToPosition({
          blockIndex: match.blockIndex,
          textIndex: match.startIndex,
        });
      }
    },
    [findMatches],
  );

  const handleFindNext = useCallback(() => {
    if (findMatches.length === 0) return;
    navigateToMatch((findActiveIndex + 1) % findMatches.length);
  }, [findMatches, findActiveIndex, navigateToMatch]);

  const handleFindPrevious = useCallback(() => {
    if (findMatches.length === 0) return;
    navigateToMatch(
      (findActiveIndex - 1 + findMatches.length) % findMatches.length,
    );
  }, [findMatches, findActiveIndex, navigateToMatch]);

  const handleFindClose = useCallback(() => {
    setFindBarOpen(false);
    setFindSearchText("");
    setFindMatches([]);
    setFindActiveIndex(0);
    mountedRef.current?.editor.clearSearchHighlights();
    // Refocus editor

    mountedRef.current?.editor.setFocus(true);
  }, []);
  handleFindCloseRef.current = handleFindClose;

  const handleSlashCommandSelect = (command: SlashCommand) => {
    if (mountedRef.current) {
      mountedRef.current.editor.executeSlashCommand(command);
    }
  };

  const handleSlashCommandClose = () => {
    if (mountedRef.current) {
      mountedRef.current.editor.closeActiveMenu();
      setSlashMenuState(null);
      lastSlashMenuStateRef.current = null;
    }
  };

  const handleContextMenuAction = async (action: string) => {
    if (!mountedRef.current) return;

    const editor = mountedRef.current.editor;
    switch (action) {
      case "copy":
        await editor.copy();
        break;
      case "cut":
        await editor.cut();
        break;
      case "paste":
        await editor.paste();
        break;
      case "selectAll":
        editor.commands.selectAll();
        editor.closeActiveMenu();
        break;
    }
  };

  const getContextMenuItems = (): ContextMenuItem[] => {
    const hasSelection = contextMenuState?.hasSelection ?? false;
    const canPaste = hasNativeBridge();

    const items: ContextMenuItem[] = [
      {
        id: "selectAll",
        label: t("contextMenu.selectAll", "Select All"),
        icon: <Type size={16} />,
        action: () => handleContextMenuAction("selectAll"),
      },
      {
        id: "copy",
        label: t("contextMenu.copy", "Copy"),
        icon: <Copy size={16} />,
        action: () => handleContextMenuAction("copy"),
        disabled: !hasSelection,
      },
    ];

    // Hide edit-related items in readonly mode
    if (!readonly) {
      items.push({
        id: "cut",
        label: t("contextMenu.cut", "Cut"),
        icon: <Scissors size={16} />,
        action: () => handleContextMenuAction("cut"),
        disabled: !hasSelection,
      });

      if (canPaste) {
        items.push({
          id: "paste",
          label: t("contextMenu.paste", "Paste"),
          icon: <Clipboard size={16} />,
          action: () => handleContextMenuAction("paste"),
        });
      }
    }

    // Add Download item when cursor is on an image block with a url
    {
      const state = mountedRef.current?.editor.getState();
      const blockIndex = state?.document.cursor?.position.blockIndex;
      const block =
        blockIndex !== undefined
          ? state?.document.page.blocks[blockIndex]
          : undefined;
      if (block && block.type === "image" && block.url) {
        const url = block.url;
        const alt = block.alt;
        items.push({
          id: "downloadImage",
          label: t("contextMenu.downloadImage", "Download image"),
          icon: <Download size={16} />,
          action: () => {
            void downloadImage(url, alt);
          },
        });
      }
    }

    // Add Format submenu for desktop when text is selected (not in readonly mode)
    if (hasSelection && !isTouchDevice() && !readonly) {
      // Get active formats from current selection
      // When there's a selection, check if ALL chars have the format
      const state = mountedRef.current?.editor.getState();
      let isBold = false;
      let isItalic = false;
      let isCode = false;
      let isStrikethrough = false;

      if (state) {
        const range = getSelectionRange(state);
        if (range && range.start.blockIndex === range.end.blockIndex) {
          // Single block selection: check if all chars have each format
          const block = state.document.page.blocks[range.start.blockIndex];
          if (isTextualBlock(block)) {
            isBold = allCharsHaveFormat(
              block.charRuns,
              block.formats,
              range.start.textIndex,
              range.end.textIndex,
              "strong",
            );
            isItalic = allCharsHaveFormat(
              block.charRuns,
              block.formats,
              range.start.textIndex,
              range.end.textIndex,
              "emphasis",
            );
            isCode = allCharsHaveFormat(
              block.charRuns,
              block.formats,
              range.start.textIndex,
              range.end.textIndex,
              "code",
            );
            isStrikethrough = allCharsHaveFormat(
              block.charRuns,
              block.formats,
              range.start.textIndex,
              range.end.textIndex,
              "strike",
            );
          }
        } else {
          // No selection or multi-block: use cursor position
          const getActiveMarks = () => {
            if (state.ui.activeMarksMode.type === "explicit") {
              return state.ui.activeMarksMode.formats;
            }
            if (state.document.cursor) {
              const { blockIndex, textIndex } = state.document.cursor.position;
              const block = state.document.page.blocks[blockIndex];
              return getFormatsAtPosition(block, textIndex) || [];
            }
            return [];
          };
          const activeMarks = getActiveMarks();
          isBold = activeMarks.some((f) => f.type === "strong");
          isItalic = activeMarks.some((f) => f.type === "emphasis");
          isCode = activeMarks.some((f) => f.type === "code");
          isStrikethrough = activeMarks.some(
            (f) => f.type === "strike",
          );
        }
      }

      items.push({
        id: "format",
        label: t("contextMenu.format", "Format"),
        icon: <Type size={16} />,
        children: [
          {
            id: "format-bold",
            label: t("contextMenu.bold", "Bold"),
            icon: <Bold size={16} />,
            action: () => mountedRef.current?.editor.commands.toggleMark("strong"),
            active: isBold,
          },
          {
            id: "format-italic",
            label: t("contextMenu.italic", "Italic"),
            icon: <Italic size={16} />,
            action: () => mountedRef.current?.editor.commands.toggleMark("emphasis"),
            active: isItalic,
          },
          {
            id: "format-code",
            label: t("contextMenu.code", "Code"),
            icon: <Code size={16} />,
            action: () => mountedRef.current?.editor.commands.toggleMark("code"),
            active: isCode,
          },
          {
            id: "format-strikethrough",
            label: t("contextMenu.strikethrough", "Strikethrough"),
            icon: <Strikethrough size={16} />,
            action: () => mountedRef.current?.editor.commands.toggleMark("strike"),
            active: isStrikethrough,
          },
          {
            id: "format-link",
            label: t("contextMenu.link", "Link"),
            icon: <Link size={16} />,
            action: () => {
              const currentState = mountedRef.current?.editor.getState();
              if (!currentState) return;
              const range = getSelectionRange(currentState);
              if (!range) return;
              const { start, end } = range;
              const block = currentState.document.page.blocks[start.blockIndex];
              if (!block || block.type === "image") return;
              const text = getBlockTextContent(block);
              const selectedText = text.substring(
                start.textIndex,
                end.textIndex,
              );
              const containerRect = wrapperRef.current?.getBoundingClientRect();
              if (!containerRect) return;
              setNativeLinkDrawerState({
                x: containerRect.left + containerRect.width / 2,
                y: containerRect.top + 100,
                selectedText,
                blockIndex: start.blockIndex,
                startIndex: start.textIndex,
                endIndex: end.textIndex,
              });
            },
          },
        ],
      });
    }

    return items;
  };

  // Set editor to locked mode when link edit or image upload popover is open
  useEffect(() => {
    if (!mountedRef.current?.editor) return;

    const currentState = mountedRef.current.editor.getState();
    if (!currentState) return;

    if (linkEditState || imageUploadState) {
      // Set editor to locked mode when popover opens (only if not already locked)
      if (currentState.ui.mode !== "locked") {
        mountedRef.current.editor.setMode("locked");
      }
    } else {
      // Restore to edit mode when popover closes (only if currently locked)
      if (currentState.ui.mode === "locked") {
        mountedRef.current.editor.setMode("edit");
      }
    }
  }, [linkEditState, imageUploadState]);

  const handleLinkEdit = () => {
    if (!linkTooltipState || !mountedRef.current) return;

    const state = mountedRef.current.editor.getState();
    if (!state) return;

    if (state.ui.activeMenu.type === "linkHover") {
      const containerRect = wrapperRef.current?.getBoundingClientRect();
      if (containerRect) {
        // Save current cursor and selection before clearing
        const savedCursor = state.document.cursor;
        const savedSelection = state.document.selection;

        // Clear selection and cursor when opening link editor
        mountedRef.current.editor.clearSelection();

        // Reset the action flag when opening
        linkEditActionPerformedRef.current = false;

        // Get link data from activeMenu
        const linkData = state.ui.activeMenu;

        setLinkEditState({
          x: linkData.x,
          y: linkData.y,
          url: linkData.url,
          text: linkData.text,
          blockIndex: linkData.position.blockIndex,
          startIndex: linkData.startIndex,
          endIndex: linkData.endIndex,
          savedCursor,
          savedSelection,
        });
        setLinkTooltipState(null);
      }
    }
  };

  const handleLinkUpdate = (newUrl: string, newText: string) => {
    if (!linkEditState || !mountedRef.current) return;

    const editor = mountedRef.current.editor;
    editor.updateLink(
      linkEditState.blockIndex,
      linkEditState.startIndex,
      linkEditState.endIndex,
      newUrl,
      newText,
    );
    // Mark that an action was performed (don't restore selection on close)
    linkEditActionPerformedRef.current = true;
  };

  const handleLinkClear = () => {
    if (!linkEditState || !mountedRef.current) return;

    const editor = mountedRef.current.editor;
    editor.clearLink(
      linkEditState.blockIndex,
      linkEditState.startIndex,
      linkEditState.endIndex,
    );
    // Mark that an action was performed (don't restore selection on close)
    linkEditActionPerformedRef.current = true;
  };

  const handleLinkEditClose = () => {
    if (!linkEditState || !mountedRef.current) return;
    mountedRef.current.editor.closeActiveMenu();
    setLinkEditState(null);

    if (window.CypherBridge) {
      // Refocus editor to restore native toolbar on mobile
      mountedRef.current.refocus();
    }
  };

  return (
    <div
      ref={wrapperRef}
      className={cn(
        "relative w-full h-full overflow-hidden focus:outline-none",
        className,
      )}
      role="textbox"
      aria-label="Text editor"
      aria-multiline="true"
    >
      {/* Spinner overlay — visible until local storage state is confirmed.
          Absolutely positioned so it overlays the canvas regardless of DOM order,
          preventing the skeleton from pushing the canvas below the viewport
          (which would block mousedown events from reaching the canvas).
          Opaque background: the canvas mounts and paints underneath while this
          is still up (the reveal intentionally waits for the first canvas
          frame), so a transparent overlay would show both at once. */}
      {!isContentReady && (
        <div className="absolute inset-0 z-10 bg-background">
          <EditorLoadingState />
        </div>
      )}
      {/* Slash command menu portal */}
      {slashMenuState &&
        mountedRef.current?.portalContainer &&
        createPortal(
          <div style={{ pointerEvents: "auto" }}>
            <SlashCommandMenu
              x={slashMenuState.x}
              y={slashMenuState.y}
              selectedIndex={slashMenuState.selectedIndex}
              filter={slashMenuState.filter}
              onSelect={handleSlashCommandSelect}
              onClose={handleSlashCommandClose}
            />
          </div>,
          mountedRef.current.portalContainer,
        )}

      {/* Context menu portal */}
      {contextMenuState && (
        <ContextMenu
          x={contextMenuState.x}
          y={contextMenuState.y}
          items={getContextMenuItems()}
          onClose={() => {
            if (!mountedRef.current) return;
            mountedRef.current.editor.closeActiveMenu();
            setContextMenuState(null);
            lastContextMenuStateRef.current = null;
          }}
          collisionBoundary={mountedRef.current?.portalContainer}
          container={mountedRef.current?.portalContainer}
          hoveredItemId={contextMenuState.hoveredItemId}
        />
      )}

      {/* Link tooltip portal */}
      {linkTooltipState &&
        !linkEditState &&
        mountedRef.current?.portalContainer &&
        createPortal(
          <div
            style={{
              pointerEvents: "none",
              position: "fixed",
              inset: 0,
              zIndex: 50,
            }}
          >
            <LinkTooltip
              url={linkTooltipState.url}
              linkText={linkTooltipState.text}
              x={linkTooltipState.x}
              y={linkTooltipState.y}
              onOpen={() => {
                if (window.CypherBridge) {
                  window.CypherBridge.navigation.openUrl(linkTooltipState.url);
                } else {
                  window.open(
                    linkTooltipState.url,
                    "_blank",
                    "noopener,noreferrer",
                  );
                }
              }}
              onEdit={handleLinkEdit}
            />
          </div>,
          mountedRef.current.portalContainer,
        )}

      {/* Link edit popover */}
      {linkEditState &&
        mountedRef.current?.portalContainer &&
        createPortal(
          <LinkEditPopover
            x={linkEditState.x}
            y={linkEditState.y}
            url={linkEditState.url}
            linkText={linkEditState.text}
            onUpdate={handleLinkUpdate}
            onClear={handleLinkClear}
            onClose={handleLinkEditClose}
            collisionBoundary={mountedRef.current?.portalContainer}
            container={mountedRef.current?.portalContainer}
          />,
          mountedRef.current.portalContainer,
        )}

      {/* Node-declared overlay slots — located by the engine
          (editor.collectOverlays), rendered here via the NODE_OVERLAYS
          registry. The engine stays framework-free; this is where a node's
          declared `key` becomes a React component, positioned at its rect. */}
      {(() => {
        const mounted = mountedRef.current;
        if (!mounted?.portalContainer) return null;
        return nodeOverlays.map((overlay) => {
          const Component = NODE_OVERLAYS[overlay.key];
          if (!Component) return null;
          return createPortal(
            <div
              key={`${overlay.key}:${overlay.blockIndex}`}
              style={{
                position: "absolute",
                left: `${overlay.rect.x}px`,
                top: `${overlay.rect.y}px`,
                width: `${overlay.rect.width}px`,
                height: `${overlay.rect.height}px`,
                pointerEvents: "none",
              }}
            >
              <Component overlay={overlay} editor={mounted.editor} />
            </div>,
            mounted.portalContainer,
          );
        });
      })()}

      {/* Image upload popover */}
      {imageUploadState &&
        mountedRef.current?.portalContainer &&
        createPortal(
          <ImageUploadPopover
            x={imageUploadState.x}
            y={imageUploadState.y}
            uploadStatus={imageUploadState.uploadStatus}
            onUpload={async (file) => {
              if (!mountedRef.current) return;
              const editor = mountedRef.current.editor;
              const state = editor.getState();
              if (!state) return;

              // Get current block to check if there's an existing URL to clear from failed cache
              const block =
                state.document.page.blocks[imageUploadState.blockIndex];
              if (block && block.type === "image" && block.url) {
                clearFailedImageCache(block.url);
              }

              // Set uploading status
              editor.updateImageBlock(
                imageUploadState.blockIndex,
                {},
                "uploading",
              );

              try {
                // Upload the image
                const imageData = await uploadImage(file);

                // Update with the uploaded URL
                editor.updateImageBlock(
                  imageUploadState.blockIndex,
                  {
                    url: imageData.url,
                    alt: imageData.fileName,
                  },
                  "complete",
                );

                // Close the popover after successful upload
                editor.closeActiveMenu();
              } catch (error) {
                console.error("Image upload failed:", error);
                editor.updateImageBlock(
                  imageUploadState.blockIndex,
                  {},
                  "error",
                );
              }
            }}
            onUrlSubmit={(url) => {
              if (!mountedRef.current) return;
              const editor = mountedRef.current.editor;

              // Clear failed cache for this URL to allow retry
              clearFailedImageCache(url);

              editor.updateImageBlock(
                imageUploadState.blockIndex,
                { url },
                "complete",
              );
            }}
            onDelete={() => {
              if (!mountedRef.current) return;
              setImageUploadState(null);
            }}
            onClose={() => {
              if (!mountedRef.current) return;
              // Clear the menu state in the editor
              mountedRef.current.editor.closeActiveMenu();
              setImageUploadState(null);
            }}
            collisionBoundary={mountedRef.current?.portalContainer}
            container={mountedRef.current?.portalContainer}
          />,
          mountedRef.current.portalContainer,
        )}

      {/* Math block editor popover */}
      {mathEditState &&
        mountedRef.current?.portalContainer &&
        createPortal(
          <MathBlockEditor
            x={mathEditState.x}
            y={mathEditState.y}
            initialLatex={(() => {
              if (!mountedRef.current) return "";
              const block =
                mountedRef.current.editor.getState()?.document.page.blocks[
                  mathEditState.blockIndex
                ];
              return block?.type === "math" ? block.latex : "";
            })()}
            displayMode={(() => {
              if (!mountedRef.current) return true;
              const block =
                mountedRef.current.editor.getState()?.document.page.blocks[
                  mathEditState.blockIndex
                ];
              return block?.type === "math" ? block.displayMode : true;
            })()}
            onSubmit={(latex, displayMode) => {
              if (!mountedRef.current) return;
              mountedRef.current.editor.updateMathBlock(
                mathEditState.blockIndex,
                { latex, displayMode },
              );
              mountedRef.current.editor.closeActiveMenu();
              setMathEditState(null);
            }}
            onDelete={() => {
              if (!mountedRef.current) return;
              // Delete the math block (reuse image delete logic pattern)
              mountedRef.current.editor.deleteImageBlock(
                mathEditState.blockIndex,
              );
              setMathEditState(null);
            }}
            onClose={() => {
              if (!mountedRef.current) return;
              mountedRef.current.editor.closeActiveMenu();
              setMathEditState(null);
            }}
            collisionBoundary={mountedRef.current?.portalContainer}
            container={mountedRef.current?.portalContainer}
          />,
          mountedRef.current.portalContainer,
        )}

      {/* Inline math edit popover */}
      {inlineMathEditState &&
        mountedRef.current?.portalContainer &&
        createPortal(
          <MathBlockEditor
            x={inlineMathEditState.x}
            y={inlineMathEditState.y}
            initialLatex={inlineMathEditState.latex}
            displayMode={false}
            inline
            onSubmit={(latex) => {
              if (!mountedRef.current) return;
              mountedRef.current.editor.updateInlineMath(
                inlineMathEditState.blockIndex,
                inlineMathEditState.startIndex,
                inlineMathEditState.endIndex,
                latex,
              );
              mountedRef.current.editor.closeActiveMenu();
              setInlineMathEditState(null);
            }}
            onDelete={() => {
              if (!mountedRef.current) return;
              mountedRef.current.editor.deleteInlineMath(
                inlineMathEditState.blockIndex,
                inlineMathEditState.startIndex,
                inlineMathEditState.endIndex,
              );
              mountedRef.current.editor.closeActiveMenu();
              setInlineMathEditState(null);
            }}
            onClose={() => {
              if (!mountedRef.current) return;
              mountedRef.current.editor.closeActiveMenu();
              setInlineMathEditState(null);
            }}
            onExitArrow={(direction) => {
              if (!mountedRef.current) return;
              mountedRef.current.editor.exitInlineMath(
                inlineMathEditState.blockIndex,
                inlineMathEditState.startIndex,
                inlineMathEditState.endIndex,
                direction,
              );
              setInlineMathEditState(null);
              mountedRef.current.refocus();
            }}
            collisionBoundary={mountedRef.current?.portalContainer}
            container={mountedRef.current?.portalContainer}
          />,
          mountedRef.current.portalContainer,
        )}

      {/* Image hover edit button overlay */}
      {(imageHoverState ||
        imageUploadState ||
        persistedImageHoverRef.current) &&
        mountedRef.current?.portalContainer &&
        (() => {
          // Use imageHoverState if available, otherwise use persisted state or reconstruct from imageUploadState
          const displayState =
            imageHoverState ||
            persistedImageHoverRef.current ||
            (imageUploadState
              ? {
                  x:
                    imageUploadState.x -
                    (wrapperRef.current?.getBoundingClientRect().left || 0),
                  y:
                    imageUploadState.y -
                    (wrapperRef.current?.getBoundingClientRect().top || 0),
                  width: wrapperRef.current?.offsetWidth || 0,
                  height: 300, // Default image height
                  blockIndex: imageUploadState.blockIndex,
                  hoveredHandle: null,
                }
              : null);

          if (!displayState) return null;

          const state = mountedRef.current?.editor.getState();
          if (!state) return null;

          const block = state.document.page.blocks[displayState.blockIndex];
          if (block?.type !== "image") return null;

          // Check if the image is in placeholder mode (no URL)
          const isPlaceholder = !block.url;

          // Don't show the overlay for placeholder mode (no Edit Image button)
          if (isPlaceholder) return null;

          return createPortal(
            <div
              style={{
                position: "absolute",
                left: `${displayState.x}px`,
                top: `${displayState.y}px`,
                width: `${displayState.width}px`,
                height: `${displayState.height}px`,
                pointerEvents: "none",
                overflow: "hidden",
                zIndex: 10,
              }}
            >
              <div
                style={{
                  position: "absolute",
                  right: "8px",
                  top: "8px",
                  pointerEvents: "auto",
                  display: "flex",
                  gap: "6px",
                }}
              >
                <Button
                  variant="outline"
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (block.type === "image" && block.url) {
                      void downloadImage(block.url, block.alt);
                    }
                  }}
                  onMouseDown={(e) => {
                    e.preventDefault();
                  }}
                  aria-label={t("contextMenu.downloadImage", "Download image")}
                  title={t("contextMenu.downloadImage", "Download image")}
                >
                  <Download className="size-4" />
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={(e) => {
                    if (!mountedRef.current) return;
                    const state = mountedRef.current.editor.getState();
                    if (!state) return;

                    const block =
                      state.document.page.blocks[displayState.blockIndex];
                    if (block.type === "image") {
                      // Get button position to open popover below it
                      const buttonRect =
                        e.currentTarget.getBoundingClientRect();
                      const containerRect =
                        wrapperRef.current?.getBoundingClientRect();

                      if (containerRect) {
                        // Convert button position to canvas-relative coordinates
                        const canvasX = buttonRect.left - containerRect.left;
                        const canvasY = buttonRect.bottom - containerRect.top;

                        // Open the image upload/edit popover
                        mountedRef.current.editor.openImageUploadMenu(
                          displayState.blockIndex,
                          canvasX,
                          canvasY,
                          block.url || undefined,
                          block.alt || undefined,
                        );
                      }
                    }
                  }}
                  onMouseDown={(e) => {
                    // Prevent button from taking focus away from hidden input
                    e.preventDefault();
                  }}
                >
                  <ImageIcon className="size-4" />
                  <span className="text-xs">Edit Image</span>
                </Button>
              </div>
            </div>,
            mountedRef.current.portalContainer,
          );
        })()}

      {/* Native Link Drawer (triggered by format button on mobile) */}
      {nativeLinkDrawerState &&
        mountedRef.current?.portalContainer &&
        createPortal(
          <LinkDrawer
            x={nativeLinkDrawerState.x}
            y={nativeLinkDrawerState.y}
            url={nativeLinkDrawerState.url}
            linkText={nativeLinkDrawerState.linkText}
            selectedText={nativeLinkDrawerState.selectedText}
            onUpdate={(newUrl, newText) => {
              if (!mountedRef.current) return;
              const editor = mountedRef.current.editor;

              if (
                nativeLinkDrawerState.blockIndex !== undefined &&
                nativeLinkDrawerState.startIndex !== undefined &&
                nativeLinkDrawerState.endIndex !== undefined
              ) {
                // Update existing link
                editor.updateLink(
                  nativeLinkDrawerState.blockIndex,
                  nativeLinkDrawerState.startIndex,
                  nativeLinkDrawerState.endIndex,
                  newUrl,
                  newText,
                );
              } else if (
                nativeLinkDrawerState.blockIndex !== undefined &&
                nativeLinkDrawerState.startIndex !== undefined &&
                nativeLinkDrawerState.endIndex !== undefined
              ) {
                // Create new link from selection - restore selection first
                const blockIndex = nativeLinkDrawerState.blockIndex;
                const startTextIndex = nativeLinkDrawerState.startIndex;
                const endTextIndex = nativeLinkDrawerState.endIndex;

                // Restore the selection by creating it programmatically
                const anchor = { blockIndex, textIndex: startTextIndex };
                const focus = { blockIndex, textIndex: endTextIndex };

                editor.restoreCursorAndSelection(
                  { position: focus, lastUpdate: Date.now() },
                  {
                    anchor,
                    focus,
                    isForward: true,
                    isCollapsed: false,
                    lastUpdate: Date.now(),
                  },
                );

                // Now create the link with the restored selection
                editor.createLink(newUrl, newText);
              }
              setNativeLinkDrawerState(null);
            }}
            onClear={
              nativeLinkDrawerState.url
                ? () => {
                    if (!mountedRef.current) return;
                    const editor = mountedRef.current.editor;
                    if (
                      nativeLinkDrawerState.blockIndex !== undefined &&
                      nativeLinkDrawerState.startIndex !== undefined &&
                      nativeLinkDrawerState.endIndex !== undefined
                    ) {
                      editor.clearLink(
                        nativeLinkDrawerState.blockIndex,
                        nativeLinkDrawerState.startIndex,
                        nativeLinkDrawerState.endIndex,
                      );
                    }
                    setNativeLinkDrawerState(null);
                  }
                : undefined
            }
            onClose={() => {
              setNativeLinkDrawerState(null);
              // Refocus editor to restore island toolbar on iOS
              mountedRef.current?.refocus();
            }}
            collisionBoundary={mountedRef.current?.portalContainer}
            container={mountedRef.current?.portalContainer}
          />,
          mountedRef.current.portalContainer,
        )}

      {/* Native Image Drawer (triggered by format button on mobile) */}
      {nativeImageDrawerState &&
        mountedRef.current?.portalContainer &&
        createPortal(
          <ImageUploadPopover
            x={nativeImageDrawerState.x}
            y={nativeImageDrawerState.y}
            uploadStatus="idle"
            onUpload={async (file) => {
              if (!mountedRef.current) return;
              const editor = mountedRef.current.editor;
              const state = editor.getState();
              if (!state) return;

              const block =
                state.document.page.blocks[nativeImageDrawerState.blockIndex];
              if (block && block.type === "image" && block.url) {
                clearFailedImageCache(block.url);
              }

              editor.updateImageBlock(
                nativeImageDrawerState.blockIndex,
                {},
                "uploading",
              );

              try {
                const imageData = await uploadImage(file);
                editor.updateImageBlock(
                  nativeImageDrawerState.blockIndex,
                  {
                    url: imageData.url,
                    alt: imageData.fileName,
                  },
                  "complete",
                );
              } catch (error) {
                console.error("Image upload failed:", error);
                editor.updateImageBlock(
                  nativeImageDrawerState.blockIndex,
                  {},
                  "error",
                );
              }
            }}
            onUrlSubmit={(url) => {
              if (!mountedRef.current) return;
              const editor = mountedRef.current.editor;
              editor.updateImageBlock(nativeImageDrawerState.blockIndex, {
                url,
              });
            }}
            onDelete={() => {
              if (!mountedRef.current) return;
              const editor = mountedRef.current.editor;
              editor.deleteImageBlock(nativeImageDrawerState.blockIndex);
              setNativeImageDrawerState(null);
            }}
            onClose={() => {
              setNativeImageDrawerState(null);
              // Refocus editor to restore island toolbar on iOS
              mountedRef.current?.refocus();
            }}
            collisionBoundary={mountedRef.current?.portalContainer}
            container={mountedRef.current?.portalContainer}
          />,
          mountedRef.current.portalContainer,
        )}

      {/* Find bar — rendered last so it sits above the canvas container in DOM order */}
      {findBarOpen && (
        <FindBar
          searchText={findSearchText}
          onSearchChange={handleFindSearchChange}
          onNext={handleFindNext}
          onPrevious={handleFindPrevious}
          onClose={handleFindClose}
          currentMatch={findActiveIndex}
          totalMatches={findMatches.length}
        />
      )}

      {/* Mobile keyboard toolbar — always mounted while editor is focused on touch so
          the slide-in/out animation can play. Visibility is driven by isKeyboardOpen. */}
      {!readonly &&
        mobileToolbar.isEditorFocused &&
        isTouchDevice() && (
          <MobileKeyboardToolbar
            isVisible={isKeyboardOpen}
            keyboardHeight={keyboardHeight}
            canUndo={mobileToolbar.canUndo}
            canRedo={mobileToolbar.canRedo}
            isBold={mobileToolbar.isBold}
            isItalic={mobileToolbar.isItalic}
            isCode={mobileToolbar.isCode}
            isStrikethrough={mobileToolbar.isStrikethrough}
            currentBlockType={mobileToolbar.blockType}
            onUndo={() => mountedRef.current?.editor.commands.undo()}
            onRedo={() => mountedRef.current?.editor.commands.redo()}
            onToggleBold={() =>
              mountedRef.current?.editor.commands.toggleMark("strong")
            }
            onToggleItalic={() =>
              mountedRef.current?.editor.commands.toggleMark("emphasis")
            }
            onToggleCode={() =>
              mountedRef.current?.editor.commands.toggleMark("code")
            }
            onToggleStrikethrough={() =>
              mountedRef.current?.editor.commands.toggleMark("strike")
            }
            onSetBlockType={(type) =>
              mountedRef.current?.editor.commands.setBlock(type as any)
            }
            onDismissKeyboard={() => mountedRef.current?.blurInput()}
          />
        )}

      {/* Cursor magnifier for mobile cursor drag repositioning */}
      {cursorDragState?.isActive &&
        createPortal(
          <CursorMagnifier
            cursorDrag={cursorDragState}
            contentCanvas={
              wrapperRef.current?.querySelector<HTMLCanvasElement>(
                "#content-layer",
              ) ?? null
            }
            cursorCanvas={
              wrapperRef.current?.querySelector<HTMLCanvasElement>(
                "#cursor-layer",
              ) ?? null
            }
            containerRect={
              wrapperRef.current?.getBoundingClientRect() ?? null
            }
          />,
          document.body,
        )}
    </div>
  );
}
