import { useP2PRoom, type SyncState } from "@/app/hooks/useP2PRoom";
import { Button } from "@/components/ui/button";
import { getBridge } from "@/platform/bridge";
import {
  CURSOR_DRAG_BOUNDARY,
  CURSOR_DRAG_END,
  CURSOR_DRAG_START,
  OPEN_LINK,
  REGION_DRAG_START,
  allCharsHaveFormat,
  clearFailedImageCache,
  createDoc,
  getBlockTextContent,
  getBlockTextLength,
  getFormatsAtPosition,
  getLinkAtPosition,
  getSelectionRange,
  isTextualBlock,
  isTouchDevice,
  positionToAwarenessCursor,
  selectionToAwarenessSelection,
  serializeVV,
  type AwarenessState,
  type AwarenessUser,
  type Block,
  type CursorDragState,
  type Doc,
  type EditorState,
  type EditorStrings,
  type MountedEditor as MountedEditorInstance,
  type NodeOverlay,
  type Operation,
  type PlaceholderStyles,
  type SlashCommand,
  type TextStyle,
} from "@cypherkit/editor";
import { useEditor } from "@cypherkit/react";
import {
  appSchema,
  type LinkEditOverlayData,
  openImageUploadMenu,
  openLinkEditMenu,
} from "../editorSchema";
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
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
} from "react";
import { CursorMagnifier } from "./components/CursorMagnifier";
import {
  MobileKeyboardToolbar,
  type BlockType as MobileBlockType,
} from "./components/MobileKeyboardToolbar";
import { useKeyboardOpen } from "./hooks/useKeyboardOpen";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { ContextMenu, type ContextMenuItem } from "../editor/ContextMenu";
import { FindBar } from "../editor/FindBar";
import { ImageUploadPopover } from "../editor/ImageUploadPopover";
import { MathBlockEditor } from "../editor/MathBlockEditor";
import { LinkDrawer } from "../editor/LinkDrawer";
import { LinkEditPopover } from "../editor/LinkEditPopover";
import { LinkTooltip } from "../editor/LinkTooltip";
import { SlashCommandMenu } from "../editor/SlashCommandMenu";
import useResponsive from "./hooks/useResponsive";
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
 * The built-in image-upload popover renders here: `CypherImageNode.overlays()`
 * declares an `"image-upload"` slot whenever the active menu targets its block
 * (see `editorSchema.ts`). The math popover still renders through its own
 * `activeMenu` path; custom nodes register their editing chrome here too.
 */
type NodeOverlayProps = {
  readonly overlay: NodeOverlay;
  readonly editor: MountedEditorInstance["editor"];
  readonly portalContainer: HTMLElement;
  /** Return focus to the editor canvas (restores the native/mobile toolbar). */
  readonly refocus: () => void;
};

/**
 * Renders the image upload/edit popover for a `CypherImageNode`-declared
 * `"image-upload"` overlay slot. The descriptor's `rect` carries the anchor in
 * canvas/container space; the popover anchors in fixed viewport space, so we
 * shift by the container's on-screen origin. All editing goes through the
 * editor instance (no React state), so the engine's `activeMenu` stays the
 * single source of truth for whether the popover is open.
 */
const ImageUploadOverlay: ComponentType<NodeOverlayProps> = ({
  overlay,
  editor,
  portalContainer,
  refocus,
}) => {
  const { blockIndex } = overlay;
  const uploadStatus =
    (overlay.data as { uploadStatus?: "idle" | "uploading" | "complete" | "error" })
      ?.uploadStatus ?? "idle";

  const containerRect = portalContainer.getBoundingClientRect();

  const close = () => {
    editor.closeActiveMenu();
    // Restore the native/mobile toolbar after the drawer dismisses.
    if (window.CypherBridge) refocus();
  };

  return (
    <ImageUploadPopover
      x={containerRect.left + overlay.rect.x}
      y={containerRect.top + overlay.rect.y}
      uploadStatus={uploadStatus}
      onUpload={async (file) => {
        const block = editor.getState()?.document.page.blocks[blockIndex];
        if (!block || block.deleted || block.type !== "image") return;

        // Clear any failed-cache entry for the URL we're replacing.
        if (block.url) {
          clearFailedImageCache(block.url);
        }

        editor.setNodeViewState(block.id, { uploadStatus: "uploading" });

        try {
          const imageData = await uploadImage(file);
          // Address by id — the upload may have shifted the block index.
          editor.change((c) =>
            c.setNodeAttrs(block.id, {
              url: imageData.url,
              alt: imageData.fileName,
            }),
          );
          editor.setNodeViewState(block.id, null);
          editor.closeActiveMenu();
        } catch (error) {
          console.error("Image upload failed:", error);
          editor.setNodeViewState(block.id, { uploadStatus: "error" });
        }
      }}
      onUrlSubmit={(url) => {
        const block = editor.getState()?.document.page.blocks[blockIndex];
        if (!block || block.deleted || block.type !== "image") return;

        // Clear failed cache for this URL to allow retry
        clearFailedImageCache(url);

        editor.change((c) => c.setNodeAttrs(block.id, { url }));
        editor.setNodeViewState(block.id, null);
      }}
      onDelete={() => {
        // "Remove Image" deletes the block (was a no-op on the desktop edit
        // path before this migration; the mobile drawer already deleted).
        const block = editor.getState()?.document.page.blocks[blockIndex];
        if (block && !block.deleted)
          editor.change((c) => c.deleteNode(block.id));
        close();
      }}
      onClose={close}
      collisionBoundary={portalContainer}
      container={portalContainer}
    />
  );
};

/**
 * Renders the block-math edit popover for a `CypherMathNode`-declared
 * `"math-edit"` overlay slot. Mirrors {@link ImageUploadOverlay}: the
 * descriptor's `rect` is the anchor in canvas/container space, shifted into
 * fixed viewport space; latex/displayMode are read live off the block, and all
 * editing routes through the editor instance so `activeMenu` stays the single
 * source of truth for whether the popover is open.
 */
const MathEditOverlay: ComponentType<NodeOverlayProps> = ({
  overlay,
  editor,
  portalContainer,
}) => {
  const { blockIndex } = overlay;
  const containerRect = portalContainer.getBoundingClientRect();
  const block = editor.getState()?.document.page.blocks[blockIndex];
  const mathBlock = block?.type === "math" ? block : undefined;

  return (
    <MathBlockEditor
      x={containerRect.left + overlay.rect.x}
      y={containerRect.top + overlay.rect.y}
      initialLatex={mathBlock?.latex ?? ""}
      displayMode={mathBlock?.displayMode ?? true}
      onSubmit={(latex, displayMode) => {
        const b = editor.getState()?.document.page.blocks[blockIndex];
        if (b && !b.deleted && b.type === "math") {
          editor.change((c) => c.setNodeAttrs(b.id, { latex, displayMode }));
        }
        editor.closeActiveMenu();
      }}
      onDelete={() => {
        const b = editor.getState()?.document.page.blocks[blockIndex];
        if (b && !b.deleted) editor.change((c) => c.deleteNode(b.id));
        editor.closeActiveMenu();
      }}
      onClose={() => editor.closeActiveMenu()}
      collisionBoundary={portalContainer}
      container={portalContainer}
    />
  );
};

/**
 * Renders the inline-math edit popover for a `CypherMathMark`-declared
 * `"inline-math-edit"` overlay slot. Inline math is a run of `math`-marked
 * characters in a text block, so the slot comes from the mark, and its `data`
 * carries the run's range + latex. Editing routes through the editor instance
 * (replace/delete the inline range, exit on arrow keys) so the engine's
 * `activeMenu` stays the single source of truth for whether it's open.
 */
const InlineMathEditOverlay: ComponentType<NodeOverlayProps> = ({
  overlay,
  editor,
  portalContainer,
  refocus,
}) => {
  const { blockIndex } = overlay;
  const { startIndex, endIndex, latex } = overlay.data as {
    startIndex: number;
    endIndex: number;
    latex: string;
  };
  const containerRect = portalContainer.getBoundingClientRect();

  return (
    <MathBlockEditor
      x={containerRect.left + overlay.rect.x}
      y={containerRect.top + overlay.rect.y}
      initialLatex={latex}
      displayMode={false}
      inline
      onSubmit={(nextLatex) => {
        const block = editor.getState()?.document.page.blocks[blockIndex];
        if (block && !block.deleted) {
          editor.change((c) =>
            c.replaceInlineRange(block.id, startIndex, endIndex, nextLatex, {
              type: "math",
            }),
          );
        }
        editor.closeActiveMenu();
      }}
      onDelete={() => {
        const block = editor.getState()?.document.page.blocks[blockIndex];
        if (block && !block.deleted) {
          editor.change((c) =>
            c.deleteInlineRange(block.id, startIndex, endIndex),
          );
        }
        editor.closeActiveMenu();
      }}
      onClose={() => editor.closeActiveMenu()}
      onExitArrow={(direction) => {
        editor.exitInlineMath(blockIndex, startIndex, endIndex, direction);
        refocus();
      }}
      collisionBoundary={portalContainer}
      container={portalContainer}
    />
  );
};

/**
 * Renders the image hover chrome (download + edit buttons) for a
 * `CypherImageNode`-declared `"image-hover"` slot. The descriptor's `rect` is
 * the image's drawn box; the buttons sit at its top-right. "Edit Image" opens
 * the image upload/edit menu just below itself.
 */
const ImageHoverOverlay: ComponentType<NodeOverlayProps> = ({
  overlay,
  editor,
  portalContainer,
}) => {
  const { t } = useTranslation();
  const { blockIndex } = overlay;
  const block = editor.getState()?.document.page.blocks[blockIndex];
  if (block?.type !== "image" || !block.url) return null;
  const { url, alt } = block;

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
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
            void downloadImage(url, alt);
          }}
          onMouseDown={(e) => e.preventDefault()}
          aria-label={t("contextMenu.downloadImage", "Download image")}
          title={t("contextMenu.downloadImage", "Download image")}
        >
          <Download className="size-4" />
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={(e) => {
            const buttonRect = e.currentTarget.getBoundingClientRect();
            const containerRect = portalContainer.getBoundingClientRect();
            openImageUploadMenu(
              editor,
              blockIndex,
              buttonRect.left - containerRect.left,
              buttonRect.bottom - containerRect.top,
            );
          }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <ImageIcon className="size-4" />
          <span className="text-xs">{t("image.editImage", "Edit Image")}</span>
        </Button>
      </div>
    </div>
  );
};

/**
 * Renders the link hover tooltip for a `CypherLinkMark`-declared
 * `"link-tooltip"` slot. "Edit" promotes the hover menu to the `linkEdit` menu
 * in place (clearing the selection first, as the old flow did).
 */
const LinkTooltipOverlay: ComponentType<NodeOverlayProps> = ({
  overlay,
  editor,
  portalContainer,
}) => {
  const { blockIndex } = overlay;
  const { url, text, startIndex, endIndex } = overlay.data as {
    url: string;
    text: string;
    startIndex: number;
    endIndex: number;
  };
  const containerRect = portalContainer.getBoundingClientRect();

  return (
    <div
      style={{
        pointerEvents: "none",
        position: "fixed",
        inset: 0,
        zIndex: 50,
      }}
    >
      <LinkTooltip
        url={url}
        linkText={text}
        x={containerRect.left + overlay.rect.x}
        y={containerRect.top + overlay.rect.y}
        onOpen={() => {
          if (window.CypherBridge) {
            window.CypherBridge.navigation.openUrl(url);
          } else {
            window.open(url, "_blank", "noopener,noreferrer");
          }
        }}
        onEdit={() => {
          editor.clearSelection();
          openLinkEditMenu(editor, {
            blockIndex,
            startIndex,
            endIndex,
            url,
            text,
            x: overlay.rect.x,
            y: overlay.rect.y,
          });
        }}
      />
    </div>
  );
};

/**
 * Renders the link edit/create popover (desktop) or drawer (mobile) for a
 * `CypherLinkMark`-declared `"link-edit"` slot. Both update/clear the link via
 * the editor; the engine's `linkEdit` menu is the single source of truth for
 * whether it's open.
 */
const LinkEditOverlay: ComponentType<NodeOverlayProps> = ({
  overlay,
  editor,
  portalContainer,
  refocus,
}) => {
  const isMobile = useResponsive("(max-width: 768px)");
  const { blockIndex } = overlay;
  const { url, text, selectedText, startIndex, endIndex } =
    overlay.data as LinkEditOverlayData;
  const containerRect = portalContainer.getBoundingClientRect();
  const x = containerRect.left + overlay.rect.x;
  const y = containerRect.top + overlay.rect.y;

  const close = () => {
    editor.closeActiveMenu();
    // Restore the native/mobile toolbar after the drawer dismisses.
    if (window.CypherBridge) refocus();
  };
  const update = (newUrl: string, newText: string) =>
    editor.change((c) => {
      // newText is required (an empty range/text would shift indices); the
      // caller's UI guards against empty input.
      if (!newText) return;
      const block = editor.getState()?.document.page.blocks[blockIndex];
      if (!block) return;
      const link = { type: "link", attrs: { url: newUrl } };
      // The link's existing text is `text` (edit) or the selected text (create).
      // When it's unchanged, just (re)apply the mark so co-existing marks and
      // character ids survive; otherwise replace the run with the new text.
      const oldText = text ?? selectedText ?? "";
      if (newText === oldText) {
        c.setMarkRange(block.id, startIndex, startIndex + newText.length, link);
      } else {
        c.replaceInlineRange(block.id, startIndex, endIndex, newText, link);
      }
    });
  const clearLink = () =>
    editor.change((c) => {
      const block = editor.getState()?.document.page.blocks[blockIndex];
      if (!block) return;
      c.setMarkRange(block.id, startIndex, endIndex, { type: "link" }, false);
    });

  if (isMobile) {
    return (
      <LinkDrawer
        x={x}
        y={y}
        url={url || undefined}
        linkText={text || undefined}
        selectedText={selectedText}
        onUpdate={(newUrl, newText) => {
          update(newUrl, newText);
          close();
        }}
        onClear={
          url
            ? () => {
                clearLink();
                close();
              }
            : undefined
        }
        onClose={close}
        collisionBoundary={portalContainer}
        container={portalContainer}
      />
    );
  }

  return (
    <LinkEditPopover
      x={x}
      y={y}
      url={url}
      linkText={text}
      onUpdate={update}
      onClear={clearLink}
      onClose={close}
      collisionBoundary={portalContainer}
      container={portalContainer}
    />
  );
};

const NODE_OVERLAYS: Record<string, ComponentType<NodeOverlayProps>> = {
  "image-upload": ImageUploadOverlay,
  "image-hover": ImageHoverOverlay,
  "math-edit": MathEditOverlay,
  "inline-math-edit": InlineMathEditOverlay,
  "link-tooltip": LinkTooltipOverlay,
  "link-edit": LinkEditOverlay,
};

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
      x.rect.height !== y.rect.height ||
      // The serializable payload (e.g. an image's upload status) is part of the
      // descriptor — a change there must re-render the overlay component.
      JSON.stringify(x.data) !== JSON.stringify(y.data)
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

/**
 * Public mount component. Remounts the inner {@link EditorSurface} whenever the
 * page (or read-only mode) changes: the surface mounts its editor once via
 * `useEditor` (a mount-once hook), so a fresh `key` is how we recreate the
 * doc + editor for a new page — replacing the old in-effect teardown/rebuild.
 */
export function MountedEditor(props: MountedEditorProps) {
  return (
    <EditorSurface
      key={`${props.pageId}::${props.readonly ? "ro" : "rw"}`}
      {...props}
    />
  );
}

function EditorSurface({
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
  const docRef = useRef<Doc | null>(null);
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
    filter: string;
  } | null>(null);

  const [contextMenuState, setContextMenuState] = useState<{
    x: number;
    y: number;
    hasSelection: boolean;
    hoveredItemId?: string | null;
  } | null>(null);

  // True while a text-input popover (image upload/edit or link edit) is open, so
  // the editor enters "locked" mode and the canvas stops capturing input. These
  // popovers now render via the node/mark overlay registry; this mirror is just
  // the locked-mode signal, derived from the engine's active menu.
  const [modalPopoverOpen, setModalPopoverOpen] = useState(false);

  // Cursor drag state (for mobile magnifier)
  const [cursorDragState, setCursorDragState] =
    useState<CursorDragState | null>(null);
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

  // ── Mount via @cypherkit/react's useEditor ───────────────────────────────
  // The CRDT Doc is the single source of truth. We create it ourselves (rather
  // than letting useEditor make a private one) for two reasons: it must carry
  // this device's persistent peer id — so local ops stay causally ours across
  // reloads — and the app's explicit `appSchema`. useEditor owns the editor
  // lifecycle and mounts the canvas into `containerRef`; we keep owning the
  // doc and tear it down below (after the editor).
  //
  // Created exactly once per mount: this surface is remounted per page via the
  // MountedEditor wrapper's `key`, and useEditor reads its options once and is
  // reconfigured imperatively (setTheme, …) thereafter.
  if (!docRef.current) {
    // HMR: reuse live editor content for the same page (refs survive Fast
    // Refresh); otherwise start from the snapshot prop.
    const initialBlocks =
      liveBlocksRef.current?.pageId === pageId
        ? liveBlocksRef.current.blocks
        : snapshot;
    liveBlocksRef.current = null;
    docRef.current = createDoc({
      blocks: initialBlocks,
      pageId,
      peerId: peerIdRef.current,
      schema: appSchema.data,
    });
  }
  const doc = docRef.current!;

  const { containerRef, editor } = useEditor({
    doc,
    schema: appSchema,
    editable: !readonly,
    pageId,
    padding,
    blockStyleOverrides,
    placeholderOverrides,
    strings: editorStrings(),
    // The editor is headless and never reads the DOM for styling — feed it our
    // current `--editor-*` CSS variables as theme tokens. Kept in sync with
    // dark-mode toggles via the MutationObserver below (editor.setTheme). Fonts
    // (registry + selected family) ride on the theme too; both update live via
    // the subscriptions below.
    theme: {
      ...cssVarsToTheme(),
      fonts: getAppFontRegistry(),
      fontFamily: fontStyleToFamily(fontStyleRef.current),
      nodeStrings: editorNodeStrings(),
    },
  });

  // Bridge the hook's CypherEditor into the MountedEditorInstance shape the
  // wiring effect + portals below were written against. Rebuilt only when the
  // editor identity changes (once per mount), so the reference stays stable.
  if (editor && mountedRef.current?.editor !== editor) {
    mountedRef.current = {
      editor,
      doc: editor.doc,
      portalContainer: editor.portalContainer,
      refocus: editor.refocus,
      blurInput: editor.blur,
      setKeyboardHeight: editor.setKeyboardHeight,
      destroy: editor.destroy,
    };
  } else if (!editor) {
    mountedRef.current = null;
  }

  // We own the doc's lifetime (useEditor doesn't, since we passed `doc` in).
  // A passive cleanup runs in the passive phase — after useEditor's layout-phase
  // editor teardown — so the editor is destroyed before the doc, matching the
  // engine's "tear down the editor (detaches doc↔editor wiring), then the doc".
  useEffect(() => {
    return () => {
      docRef.current?.destroy();
      docRef.current = null;
    };
    // Mount-once (the surface is keyed per page); destroy on unmount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist cursor position + (for HMR) live blocks on unmount, while the editor
  // is still alive. As a layout-effect cleanup declared after useEditor, it runs
  // in the commit phase before useEditor's own layout cleanup destroys the
  // editor — so getState()/getScrollY() still return live state here.
  useLayoutEffect(() => {
    if (readonly) return;
    return () => {
      const editorState = mountedRef.current?.editor.getState();
      if (!editorState) return;
      if (editorState.document.page?.blocks) {
        liveBlocksRef.current = {
          blocks: editorState.document.page.blocks as Block[],
          pageId,
        };
      }
      if (editorState.document.cursor) {
        saveCursorPosition(pageId, {
          blockIndex: editorState.document.cursor.position.blockIndex,
          textIndex: editorState.document.cursor.position.textIndex,
          scrollY: mountedRef.current?.editor.getScrollY() ?? 0,
        });
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Wire up editor subscriptions, sync, and native bridges once the editor is
  // ready. Gated on `editor`; reads stable per-mount values (pageId, readonly,
  // the room callbacks) captured once for this keyed surface.
  useEffect(() => {
    if (!editor) return;
    // Derive the bridged instance from `editor` rather than trusting the
    // render-phase assignment above. Under StrictMode/HMR, React re-runs passive
    // effects as setup→cleanup→setup with no intervening render, and this
    // effect's cleanup nulls mountedRef.current — so the second setup would
    // otherwise read a null ref. Rebuilding here keeps the ref in sync for the
    // imperative handlers (and matches the object the render phase builds).
    const mounted: MountedEditorInstance =
      mountedRef.current?.editor === editor
        ? mountedRef.current
        : {
            editor,
            doc: editor.doc,
            portalContainer: editor.portalContainer,
            refocus: editor.refocus,
            blurInput: editor.blur,
            setKeyboardHeight: editor.setKeyboardHeight,
            destroy: editor.destroy,
          };
    mountedRef.current = mounted;
    const doc = editor.doc;
    const native = getBridge();

    // Reset serialization tracking and initialization flag for this mount.
    lastSerializedBlocksRef.current = null;
    editorInitializedRef.current = false;

    // Haptics + native link-opening are editor commands now:
    // the engine dispatches semantic commands and we map them to the
    // native shell, falling back to the web Vibration API. These handlers live
    // on this editor's command bus and die with it on destroy — no cleanup.
    const fireHaptic = (style: "light" | "medium" | "heavy") => {
      // Never let a haptic failure bubble into the editor's event loop.
      try {
        if (native) {
          void native.haptic.trigger(style);
          return;
        }
        if ("vibrate" in navigator) {
          navigator.vibrate(
            style === "light" ? 10 : style === "medium" ? 20 : 50,
          );
        }
      } catch (e) {
        console.debug("Haptic feedback not supported:", e);
      }
    };
    mounted.editor.registerCommand(CURSOR_DRAG_START, () =>
      fireHaptic("light"),
    );
    mounted.editor.registerCommand(CURSOR_DRAG_BOUNDARY, () =>
      fireHaptic("light"),
    );
    mounted.editor.registerCommand(CURSOR_DRAG_END, () => fireHaptic("medium"));
    mounted.editor.registerCommand(REGION_DRAG_START, ({ intensity }) =>
      fireHaptic(intensity),
    );
    if (native) {
      // Override the editor's window.open default with native navigation.
      mounted.editor.registerCommand(OPEN_LINK, ({ url }) => {
        void native.navigation.openUrl(url);
        return true;
      });
    }

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
    const snapshotHasContent = doc.getBlocks().some((b) => {
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
                    editor.change((c) => c.selectAll());
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
        // The editor (useEditor) and the doc (our cleanup effects) are torn
        // down separately; here we only undo this effect's own wiring.
        if (mountedRef.current === mounted) {
          mountedRef.current = null;
        }
      };
    }

    // Load persisted operations from SQLite (if any) and register them on the
    // doc. This catches the doc's version vector + clock/id counter up to what
    // the snapshot blocks already represent (the blocks were rebuilt from these
    // ops by the engine), without re-rendering — see Doc.load. New local ops
    // then out-order and out-counter historical ones.
    const platform = getPlatform();
    const opsLoadedPromise = platform.ops.load(pageId).then((persistedOps) => {
      if (persistedOps.length > 0 && docRef.current) {
        docRef.current.load(persistedOps);
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

    // Debounced snapshot writer — keeps the FS snapshot in sync after edits.
    // 2s delay avoids writing on every keystroke.
    let snapshotTimer: ReturnType<typeof setTimeout> | null = null;
    const saveSnapshot = (blocks: Block[]) => {
      if (snapshotTimer) clearTimeout(snapshotTimer);
      snapshotTimer = setTimeout(() => {
        platform.snapshots.save(pageId, blocks);
      }, 2000);
    };

    // Single fan-out for every document change. Local edits (u.local) are
    // broadcast to peers and persisted to SQLite here; remote ops are persisted
    // by the Replicator before they reach applyRemoteOps, so we only refresh the
    // FS snapshot for those. The doc's update event also drives the editor
    // re-render (via the editor's doc↔editor wiring), so there's no second fold.
    const offDocUpdate = doc.on("update", (u) => {
      if (u.local) {
        roomBroadcast(u.ops);
        platform.ops.persist(pageId, u.ops);
      }
      saveSnapshot(doc.getBlocks());
    });

    // Apply remote ops through the doc. applyUpdate dedups via the version
    // vector, advances the shared binding past everything received (so local
    // ops stay causally ahead), drives the editor, and fires offDocUpdate — all
    // synchronously, so the isApplyingRemoteOps guard still brackets the
    // editor's state-change notification and suppresses the local save path.
    const applyRemoteOps = (ops: Operation[]) => {
      isApplyingRemoteOpsRef.current = true;
      doc.applyUpdate(ops, "remote");
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
          const localVV = serializeVV(doc.getVersionVector());
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

    // Local-edit broadcast/persistence is handled by the doc.on("update")
    // subscription above — the editor feeds its local ops into the doc, and the
    // doc fans them out to peers + SQLite + the snapshot.

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
        // Resolve the block by id (index may have shifted during the upload).
        const block =
          mounted.editor.getState()?.document.page.blocks[blockIndex];
        if (!block || block.deleted || block.type !== "image") return;
        // Revoke the temporary blob URL we were displaying.
        if (block.url?.startsWith("blob:")) {
          URL.revokeObjectURL(block.url);
        }
        mounted.editor.change((c) =>
          c.setNodeAttrs(block.id, {
            url: imageData.url,
            alt: imageData.fileName,
          }),
        );
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

      // Anchor in canvas/container space (the overlay shifts it into viewport
      // space). On mobile these render as full-screen drawers, so x/y are only a
      // rough origin.
      const menuX = containerRect.width / 2;
      const menuY = 100;

      if (iconType === "image") {
        // Open the image upload/edit menu for the selected image — rendered as a
        // drawer on mobile by the CypherImageNode "image-upload" overlay.
        if (state.document.selection && !state.document.selection.isCollapsed) {
          const { anchor } = state.document.selection;
          const block = state.document.page.blocks[anchor.blockIndex];
          if (block && block.type === "image") {
            openImageUploadMenu(mounted.editor, anchor.blockIndex, menuX, menuY);
            return true;
          }
        }
        return false;
      } else if (iconType === "link") {
        // Open the link edit/create menu — rendered as a drawer on mobile by the
        // CypherLinkMark "link-edit" overlay.
        if (state.document.cursor) {
          const linkData = getLinkAtPosition(
            state.document.cursor.position,
            state,
          );

          if (linkData) {
            // Editing existing link
            openLinkEditMenu(mounted.editor, {
              blockIndex: state.document.cursor.position.blockIndex,
              startIndex: linkData.startIndex,
              endIndex: linkData.endIndex,
              url: linkData.url,
              text: linkData.text,
              x: menuX,
              y: menuY,
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

                openLinkEditMenu(mounted.editor, {
                  blockIndex: start.blockIndex,
                  startIndex: start.textIndex,
                  endIndex: end.textIndex,
                  url: "",
                  text: "",
                  selectedText,
                  x: menuX,
                  y: menuY,
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
      undo: () => mounted.editor.undo(),
      redo: () => mounted.editor.redo(),
      setBlockType: (type: string) =>
        mounted.editor.change((c) => c.setBlock(type as any)),
      focus: () => {
        mounted.editor.setFocus(true);
        mounted.editor.setInitialCursor();
      },
      onFormatButtonClick: handleFormatButtonClick,
      toggleBold: () => mounted.editor.change((c) => c.toggleMark("strong")),
      toggleItalic: () => mounted.editor.change((c) => c.toggleMark("emphasis")),
      toggleCode: () => mounted.editor.change((c) => c.toggleMark("code")),
      toggleStrikethrough: () => mounted.editor.change((c) => c.toggleMark("strike")),
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

      // Node-declared overlay slots (engine, framework-free) → host registry.
      // Recollected each tick; only pushed to React state when the set changes.
      const newOverlays = mounted.editor.collectOverlays();
      if (!nodeOverlaysEqual(newOverlays, lastNodeOverlaysRef.current)) {
        lastNodeOverlaysRef.current = newOverlays;
        setNodeOverlays(newOverlays);
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

      // These all render via the node/mark overlay registry now, driven by the
      // engine's active menu (collectOverlays → NODE_OVERLAYS):
      //   - link hover tooltip      → CypherLinkMark  → "link-tooltip"
      //   - link edit / create      → CypherLinkMark  → "link-edit"
      //   - image upload/edit popover→ CypherImageNode → "image-upload"
      //   - image hover buttons      → CypherImageNode → "image-hover"
      //   - block / inline math      → CypherMathNode / CypherMathMark
      // The only mirror kept here is the locked-mode signal: a text-input
      // popover (image upload or link edit) is open.
      const popoverOpen =
        state.ui.activeMenu.type === "overlay" &&
        (state.ui.activeMenu.key === "image-upload" ||
          state.ui.activeMenu.key === "link-edit");
      setModalPopoverOpen(popoverOpen);

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
      offDocUpdate();
      themeObserver.disconnect();
      offFontRegistry();

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

      // The editor (useEditor) is destroyed in the commit phase and the doc by
      // our dedicated cleanup effect; cursor/live-blocks are saved by the
      // layout-effect above (all while the editor is still alive). Here we only
      // undo this effect's own wiring.
      delete window.CypherEditorCallbacks;
      if (mountedRef.current === mounted) {
        mountedRef.current = null;
      }
    };
    // Runs once when the editor becomes available. The surface is remounted per
    // page (keyed wrapper), so pageId/readonly/snapshot are constant here, and
    // the room callbacks are stable per roomId — all captured once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

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
        editor.change((c) => c.selectAll());
        editor.closeActiveMenu();
        break;
    }
  };

  const getContextMenuItems = (): ContextMenuItem[] => {
    const hasSelection = contextMenuState?.hasSelection ?? false;

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

      // Paste reads the system clipboard via `navigator.clipboard` (editor.paste
      // → pasteFromSystemClipboard). Clipboard *read* is gated by the browser:
      // Chromium/Safari/native WebViews prompt-then-allow on this click gesture,
      // Firefox restricts it for pages — there the action just no-ops gracefully.
      items.push({
        id: "paste",
        label: t("contextMenu.paste", "Paste"),
        icon: <Clipboard size={16} />,
        action: () => handleContextMenuAction("paste"),
      });
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
          isStrikethrough = activeMarks.some((f) => f.type === "strike");
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
            action: () =>
              mountedRef.current?.editor.change((c) => c.toggleMark("strong")),
            active: isBold,
          },
          {
            id: "format-italic",
            label: t("contextMenu.italic", "Italic"),
            icon: <Italic size={16} />,
            action: () =>
              mountedRef.current?.editor.change((c) => c.toggleMark("emphasis")),
            active: isItalic,
          },
          {
            id: "format-code",
            label: t("contextMenu.code", "Code"),
            icon: <Code size={16} />,
            action: () =>
              mountedRef.current?.editor.change((c) => c.toggleMark("code")),
            active: isCode,
          },
          {
            id: "format-strikethrough",
            label: t("contextMenu.strikethrough", "Strikethrough"),
            icon: <Strikethrough size={16} />,
            action: () =>
              mountedRef.current?.editor.change((c) => c.toggleMark("strike")),
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
              const mountedEditor = mountedRef.current?.editor;
              if (!containerRect || !mountedEditor) return;
              // Open the link create menu — rendered as a drawer on mobile by
              // the CypherLinkMark "link-edit" overlay.
              openLinkEditMenu(mountedEditor, {
                blockIndex: start.blockIndex,
                startIndex: start.textIndex,
                endIndex: end.textIndex,
                url: "",
                text: "",
                selectedText,
                x: containerRect.width / 2,
                y: 100,
              });
            },
          },
        ],
      });
    }

    return items;
  };

  // Lock the editor (canvas stops capturing input) while a text-input popover
  // (image upload/edit or link edit) is open — see `modalPopoverOpen`.
  useEffect(() => {
    if (!mountedRef.current?.editor) return;

    const currentState = mountedRef.current.editor.getState();
    if (!currentState) return;

    if (modalPopoverOpen) {
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
  }, [modalPopoverOpen]);

  return (
    <div
      // The hook owns `containerRef` (it mounts the canvas here); we keep
      // `wrapperRef` for the existing layout/positioning reads. One element,
      // both refs.
      ref={(el) => {
        wrapperRef.current = el;
        containerRef.current = el;
      }}
      className={cn(
        "relative w-full h-full overflow-hidden focus:outline-none",
        className,
      )}
      // The editable surface and its ARIA semantics (role="textbox",
      // aria-label, aria-multiline) now live on the engine's contenteditable
      // input element; this wrapper is just a layout container.
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
              editor={mountedRef.current.editor}
              x={slashMenuState.x}
              y={slashMenuState.y}
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

      {/* Link tooltip + link edit/create popover render via the mark-overlay
          registry below (CypherLinkMark.overlays → "link-tooltip" /
          "link-edit"). */}

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
              <Component
                overlay={overlay}
                editor={mounted.editor}
                portalContainer={mounted.portalContainer}
                refocus={mounted.refocus}
              />
            </div>,
            mounted.portalContainer,
          );
        });
      })()}

      {/* Image upload/edit popover + hover buttons render via the node-overlay
          registry above (CypherImageNode.overlays → "image-upload" /
          "image-hover"). The locked-mode signal is the `modalPopoverOpen`
          mirror, derived from the engine's active menu. */}

      {/* Block-math edit popover renders via the node-overlay registry above
          (CypherMathNode.overlays → NODE_OVERLAYS["math-edit"]). */}

      {/* Inline-math edit popover renders via the node-overlay registry above
          (CypherMathMark.overlays → NODE_OVERLAYS["inline-math-edit"]). */}

      {/* Image hover buttons + native image drawer render via the
          node-overlay registry above (CypherImageNode.overlays → "image-hover"
          / "image-upload"). The native link drawer renders via the mark-overlay
          registry (CypherLinkMark → "link-edit"). */}


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
      {!readonly && mobileToolbar.isEditorFocused && isTouchDevice() && (
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
          onUndo={() => mountedRef.current?.editor.undo()}
          onRedo={() => mountedRef.current?.editor.redo()}
          onToggleBold={() =>
            mountedRef.current?.editor.change((c) => c.toggleMark("strong"))
          }
          onToggleItalic={() =>
            mountedRef.current?.editor.change((c) => c.toggleMark("emphasis"))
          }
          onToggleCode={() =>
            mountedRef.current?.editor.change((c) => c.toggleMark("code"))
          }
          onToggleStrikethrough={() =>
            mountedRef.current?.editor.change((c) => c.toggleMark("strike"))
          }
          onSetBlockType={(type) =>
            mountedRef.current?.editor.change((c) => c.setBlock(type as any))
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
            containerRect={wrapperRef.current?.getBoundingClientRect() ?? null}
          />,
          document.body,
        )}
    </div>
  );
}
