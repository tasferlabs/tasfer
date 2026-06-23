import { useP2PRoom, type SyncState } from "@/app/hooks/useP2PRoom";
import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import { getBridge } from "@/platform/bridge";
import {
  CLOSE_CONTEXT_MENU,
  CONTEXT_MENU_POINTER_MOVE,
  CONTEXT_MENU_RELEASE,
  CURSOR_DRAG_BOUNDARY,
  CURSOR_DRAG_END,
  CURSOR_DRAG_MOVE,
  CURSOR_DRAG_START,
  IMAGE_PASTE,
  OPEN_CONTEXT_MENU,
  OPEN_LINK,
  REGION_DRAG_START,
  SCROLL,
  createDoc,
  mergeRegister,
  serializeVV,
  type Block,
  type CursorDragInfo,
  type Decoration,
  type Doc,
  type MountedEditor as MountedEditorInstance,
  type Operation,
} from "@cypherkit/editor";
import {
  cursorPresenceToDecorations,
  selectionToCursorPresence,
  type CursorPresence,
  type CursorUser,
} from "@cypherkit/provider-core/cursors";
import {
  clearFailedImageCache,
  isTextualBlock,
  isTouchDevice,
  type EditorStrings,
  type NodeOverlay,
  type PlaceholderStyles,
  type TextStyle,
} from "@cypherkit/editor/internal";
import { useEditor } from "@cypherkit/react";
import {
  appSchema,
  type LinkEditOverlayData,
  openImageUploadMenu,
  openLinkEditMenu,
} from "../editorSchema";
import { getPlatform } from "@/platform";
import { CODE_LANGUAGES, codeLanguageLabel } from "@cypherkit/editor/internal";
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
import { LinkDrawer } from "../editor/LinkDrawer";
import { LinkEditPopover } from "../editor/LinkEditPopover";
import { LinkTooltip } from "../editor/LinkTooltip";
import { InlineMathOverlay } from "../editor/InlineMathOverlay";
import { MathCommandMenu } from "../editor/MathCommandMenu";
import { SlashActionMenu } from "../editor/SlashActionMenu";
import useResponsive from "./hooks/useResponsive";
import i18next from "i18next";
import { cssVarsToTheme, readEditorTokens } from "../editorTheme";
import { getAppFontRegistry, onAppFontRegistryChange } from "../fonts";
import { cn } from "../lib/utils";
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
    placeholderParagraph: i18next.t("editor.typeForActions"),
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
  const { blockId } = overlay;
  const uploadStatus =
    (
      overlay.data as {
        uploadStatus?: "idle" | "uploading" | "complete" | "error";
      }
    )?.uploadStatus ?? "idle";

  const containerRect = portalContainer.getBoundingClientRect();

  const close = () => {
    editor.host.closeActiveMenu();
    // Restore the native/mobile toolbar after the drawer dismisses.
    if (window.CypherBridge) refocus();
  };

  return (
    <ImageUploadPopover
      x={containerRect.left + overlay.rect.x}
      y={containerRect.top + overlay.rect.y}
      uploadStatus={uploadStatus}
      onUpload={async (file) => {
        const block = editor.query.block({ block: blockId });
        if (!block || block.type !== "image") return;

        // Clear any failed-cache entry for the URL we're replacing.
        const currentUrl = block.attrs.url;
        if (typeof currentUrl === "string") {
          clearFailedImageCache(currentUrl);
        }

        editor.host.setNodeViewState(block.id, { uploadStatus: "uploading" });

        try {
          const imageData = await uploadImage(file);
          // Address by id — the upload may have shifted the block index.
          editor.change((c) =>
            c.setBlock(
              { url: imageData.url, alt: imageData.fileName },
              { block: block.id },
            ),
          );
          editor.host.setNodeViewState(block.id, null);
          editor.host.closeActiveMenu();
        } catch (error) {
          console.error("Image upload failed:", error);
          editor.host.setNodeViewState(block.id, { uploadStatus: "error" });
        }
      }}
      onUrlSubmit={(url) => {
        const block = editor.query.block({ block: blockId });
        if (!block || block.type !== "image") return;

        // Clear failed cache for this URL to allow retry
        clearFailedImageCache(url);

        editor.change((c) => c.setBlock({ url }, { block: block.id }));
        editor.host.setNodeViewState(block.id, null);
      }}
      onDelete={() => {
        // "Remove Image" deletes the block (was a no-op on the desktop edit
        // path before this migration; the mobile drawer already deleted).
        const block = editor.query.block({ block: blockId });
        if (block) editor.change((c) => c.deleteBlock({ block: block.id }));
        close();
      }}
      onClose={close}
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
  const { blockId } = overlay;
  const block = editor.query.block({ block: blockId });
  if (block?.type !== "image" || typeof block.attrs.url !== "string")
    return null;
  const url = block.attrs.url;
  const alt = typeof block.attrs.alt === "string" ? block.attrs.alt : undefined;

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
          variant="secondary"
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
          variant="secondary"
          size="sm"
          onClick={(e) => {
            const buttonRect = e.currentTarget.getBoundingClientRect();
            const containerRect = portalContainer.getBoundingClientRect();
            openImageUploadMenu(
              editor,
              blockId,
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
  const { blockId } = overlay;
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
          editor.setSelection(null);
          openLinkEditMenu(editor, {
            blockId,
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
  const { blockId } = overlay;
  const { url, text, selectedText, startIndex, endIndex } =
    overlay.data as LinkEditOverlayData;
  const containerRect = portalContainer.getBoundingClientRect();
  const x = containerRect.left + overlay.rect.x;
  const y = containerRect.top + overlay.rect.y;

  const close = () => {
    editor.host.closeActiveMenu();
    // Restore the native/mobile toolbar after the drawer dismisses.
    if (window.CypherBridge) refocus();
  };
  const update = (newUrl: string, newText: string) =>
    editor.change((c) => {
      // newText is required (an empty range/text would shift indices); the
      // caller's UI guards against empty input.
      if (!newText) return;
      const block = editor.query.block({ block: blockId });
      if (!block) return;
      const link = { type: "link", attrs: { url: newUrl } };
      // The link's existing text is `text` (edit) or the selected text (create).
      // When it's unchanged, just (re)apply the mark so co-existing marks and
      // character ids survive; otherwise replace the run with the new text.
      const oldText = text ?? selectedText ?? "";
      if (newText === oldText) {
        c.setMark("link", {
          attrs: link.attrs,
          range: {
            from: { block: block.id, offset: startIndex },
            to: { block: block.id, offset: startIndex + newText.length },
          },
        });
      } else {
        c.insertText(
          newText,
          {
            from: { block: block.id, offset: startIndex },
            to: { block: block.id, offset: endIndex },
          },
          link,
        );
      }
    });
  const clearLink = () =>
    editor.change((c) => {
      const block = editor.query.block({ block: blockId });
      if (!block) return;
      c.setMark("link", {
        active: false,
        range: {
          from: { block: block.id, offset: startIndex },
          to: { block: block.id, offset: endIndex },
        },
      });
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

/**
 * Renders the language picker for a `CodeNode`-declared `"code-language"` slot.
 * The descriptor anchors a 1×1 point at the block box's top-right corner; the
 * chip insets itself from there. The current language is read live off the block
 * and a selection is written back via `setBlock` (a `language` block_set op),
 * so the document stays the single source of truth — no React-side state.
 */
const CodeLanguageOverlay: ComponentType<NodeOverlayProps> = ({
  overlay,
  editor,
}) => {
  const { t } = useTranslation();
  const { blockId } = overlay;
  const block = editor.query.block({ block: blockId });
  if (block?.type !== "code") return null;

  const language = block.attrs.language;
  const currentLabel = codeLanguageLabel(
    typeof language === "string" ? language : undefined,
  );
  const items = CODE_LANGUAGES.map((l) => l.label);

  const handleChange = (label: string | null) => {
    const language = CODE_LANGUAGES.find((l) => l.label === label)?.id ?? "";
    const b = editor.query.block({ block: blockId });
    if (b && b.type === "code") {
      editor.change((c) => c.setBlock({ language }, { block: b.id }));
    }
  };

  return (
    <div
      style={{
        position: "absolute",
        right: "8px",
        top: "8px",
        pointerEvents: "auto",
      }}
    >
      <Combobox items={items} value={currentLabel} onValueChange={handleChange}>
        <ComboboxInput
          className="h-7 w-auto gap-1 rounded-md border-border/60 bg-background/80 px-2 shadow-none backdrop-blur-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          placeholder={t("code.plainText", "Plain Text")}
          aria-label={t("code.selectLanguage", "Select language")}
          title={t("code.selectLanguage", "Select language")}
        />
        <ComboboxContent className="w-44">
          <ComboboxList>
            {(item) => (
              <ComboboxItem key={item} value={item}>
                {item}
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
    </div>
  );
};

const NODE_OVERLAYS: Record<string, ComponentType<NodeOverlayProps>> = {
  "image-upload": ImageUploadOverlay,
  "image-hover": ImageHoverOverlay,
  "link-tooltip": LinkTooltipOverlay,
  "link-edit": LinkEditOverlay,
  "code-language": CodeLanguageOverlay,
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
      x.blockId !== y.blockId ||
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
  /** Stable CRDT block id (not an index — survives concurrent edits). */
  block: string;
  offset: number;
  scrollY: number;
  /** Caret Y within the viewport, used to restore without laying out prior blocks. */
  viewportOffsetY?: number;
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
  onContentUpdate?: (blocks: Block[]) => void;
  autoFocus?: boolean;
  /** Unique page ID for CRDT sync - if provided, enables live collaboration */
  pageId: string;
  /** Space ID that owns this page - required for P2P sync to use the correct topic */
  spaceId?: string;
  /** Callback when sync state changes */
  onSyncStateChange?: (state: SyncState) => void;
  /** Callback when active users change */
  onAwarenessChange?: (users: CursorUser[]) => void;
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

// Find-in-document highlight colors (host-owned now that the engine paints
// generic decorations rather than knowing about "search"). Active match is
// emphasized; both opt into a scrollbar gutter marker.
const SEARCH_HIGHLIGHT_COLOR = "#facc15";
const SEARCH_HIGHLIGHT_ACTIVE_COLOR = "#f97316";
const SEARCH_HIGHLIGHT_OPACITY = 0.35;
const SEARCH_HIGHLIGHT_ACTIVE_OPACITY = 0.5;

/** Build the find-decoration list for a set of matches and the active index. */
function searchDecorations(
  matches: { blockId: string; startIndex: number; endIndex: number }[],
  activeIndex: number,
): Decoration[] {
  return matches.map((m, i) => {
    const isActive = i === activeIndex;
    return {
      kind: "range",
      range: {
        from: { block: m.blockId, offset: m.startIndex },
        to: { block: m.blockId, offset: m.endIndex },
      },
      color: isActive ? SEARCH_HIGHLIGHT_ACTIVE_COLOR : SEARCH_HIGHLIGHT_COLOR,
      opacity: isActive
        ? SEARCH_HIGHLIGHT_ACTIVE_OPACITY
        : SEARCH_HIGHLIGHT_OPACITY,
      gutter: true,
    };
  });
}

/** Decoration layer name for a remote peer's cursor/selection. */
const presenceLayer = (peerId: string) => `presence:${peerId}`;

/**
 * Approximate height of the floating {@link MobileKeyboardToolbar}. When the
 * soft keyboard is open we shrink the editor container by the keyboard height
 * plus this offset so the caret stays clear of both the keyboard and the
 * toolbar that floats just above it. (Keyboard-aware sizing is the host's
 * concern, not the engine's — the editor just renders into whatever size its
 * container reports via ResizeObserver.)
 */
const KEYBOARD_TOOLBAR_HEIGHT = 48;

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
  const [contextMenuState, setContextMenuState] = useState<{
    x: number;
    y: number;
    hasSelection: boolean;
    hoveredItemId?: string | null;
  } | null>(null);

  // True while a text-input popover (image upload/edit or link edit) is open, so
  // the editor enters "suspended" mode and the canvas stops capturing input. These
  // popovers now render via the node/mark overlay registry; this mirror is just
  // the suspended-mode signal, derived from the engine's active menu.
  const [modalPopoverOpen, setModalPopoverOpen] = useState(false);

  // Whether the mobile cursor-drag magnifier is showing. Bracketed by the
  // engine's CURSOR_DRAG_START/END actions; the loupe anchors its body to the
  // caret (resolving live coords itself) and reads the latest finger geometry
  // below for the pointer aim + fingertip clearance.
  const [magnifierActive, setMagnifierActive] = useState(false);
  const latestTouchRef = useRef<CursorDragInfo>({
    touchX: 0,
    touchY: 0,
    touchRadiusX: 0,
    touchRadiusY: 0,
  });

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
    { blockId: string; startIndex: number; endIndex: number }[]
  >([]);
  const [findActiveIndex, setFindActiveIndex] = useState(0);

  // Register find callback for PageSettings drawer
  useEffect(() => {
    setOnOpenFind(() => setFindBarOpen(true));
    return () => setOnOpenFind(null);
  }, [setOnOpenFind]);

  const lastContextMenuStateRef = useRef<typeof contextMenuState>(null);
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

  // Shrink the editor container while the soft keyboard is open so the caret
  // stays above the keyboard and the floating toolbar. The engine resizes its
  // canvas to match the container (ResizeObserver), so this is purely a host
  // layout concern — kept out of the engine on purpose.
  const keyboardInset =
    isTouchDevice() && isKeyboardOpen
      ? keyboardHeight + KEYBOARD_TOOLBAR_HEIGHT
      : 0;

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
    ((awarenesspeerId: string, state: CursorPresence | null) => void) | null
  >(null);
  const onRoomFirstPeerRef = useRef<(() => void) | null>(null);
  const onRoomPeerJoinedRef = useRef<((peerId: string) => void) | null>(null);
  const onRoomAwarenessStatesRef = useRef<
    ((states: Record<string, CursorPresence>) => void) | null
  >(null);
  const onRoomJoinedRef = useRef<((hasOtherPeers: boolean) => void) | null>(
    null,
  );
  // Tracks remote peers' identities (for the active-users avatar list), now that
  // the editor no longer stores awareness — it only renders decorations.
  const remoteUsersRef = useRef<Map<string, CursorUser>>(new Map());

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
        (pId: string, state: CursorPresence | null) => {
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
        (states: Record<string, CursorPresence>) => {
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
      refocus: () => editor.focus(),
      blurInput: editor.blur,
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
  // editor — so editor.state / the doc still return live data here.
  useLayoutEffect(() => {
    if (readonly) return;
    return () => {
      const editorApi = mountedRef.current?.editor;
      if (!editorApi) return;
      const blocks = docRef.current?.getRawBlocks();
      if (blocks) {
        liveBlocksRef.current = { blocks, pageId };
      }
      const range = editorApi.state.selection.range;
      const caret =
        range && typeof range === "object" && "offset" in range
          ? { block: range.block, offset: range.offset ?? 0 }
          : null;
      if (caret) {
        const caretCoords = editorApi.view.coordsAtPos("caret");
        saveCursorPosition(pageId, {
          block: caret.block,
          offset: caret.offset,
          scrollY: editorApi.view.getScrollY(),
          viewportOffsetY: caretCoords?.y,
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
            refocus: () => editor.focus(),
            blurInput: editor.blur,
            destroy: editor.destroy,
          };
    mountedRef.current = mounted;
    const doc = editor.doc;
    const native = getBridge();

    // Haptics + native link-opening are editor actions now:
    // the engine dispatches semantic actions and we map them to the
    // native shell, falling back to the web Vibration API.
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

    // Context menu is fully host-owned now: the engine emits OPEN_CONTEXT_MENU
    // (canvas coords + selection flag); we render our own <ContextMenu> and own
    // its hover/dismissal. The engine tracks "a host menu is capturing" itself
    // from the OPEN/CLOSE actions (to arbitrate focus + the long-press
    // drag/release it forwards via POINTER_MOVE / RELEASE) — we just dispatch
    // CLOSE_CONTEXT_MENU to dismiss. Registered for both readonly/editable mounts.
    const setMenu = (next: typeof contextMenuState) => {
      lastContextMenuStateRef.current = next;
      setContextMenuState(next);
    };
    // Hit-test the host menu's items by the raw client point (the menu renders in
    // a portal, so it's a normal DOM hit-test — the same one the engine used to
    // do inline before the menu moved fully host-side).
    const menuButtonAt = (
      clientX: number,
      clientY: number,
    ): HTMLElement | null => {
      const el = document.elementFromPoint(clientX, clientY);
      const button = el?.closest("button[data-context-menu-item-id]");
      return button instanceof HTMLElement ? button : null;
    };

    // Every action handler registered on this editor's bus, collected into one
    // disposer (Lexical's mergeRegister). The effect re-runs whenever `editor`
    // changes, and StrictMode double-invokes it — so dropping these disposers
    // would stack duplicate handlers (haptics firing twice, the menu opening
    // twice). Both cleanup paths (readonly early-return + the main one) call
    // disposeActions().
    const disposeActions = mergeRegister(
      mounted.editor.registerAction(CURSOR_DRAG_START, (info) => {
        fireHaptic("light");
        latestTouchRef.current = info;
        setMagnifierActive(true);
      }),
      mounted.editor.registerAction(CURSOR_DRAG_MOVE, (info) => {
        latestTouchRef.current = info;
      }),
      mounted.editor.registerAction(CURSOR_DRAG_BOUNDARY, () =>
        fireHaptic("light"),
      ),
      mounted.editor.registerAction(CURSOR_DRAG_END, () => {
        fireHaptic("medium");
        setMagnifierActive(false);
      }),
      mounted.editor.registerAction(REGION_DRAG_START, ({ intensity }) =>
        fireHaptic(intensity),
      ),
      // Override the editor's window.open default with native navigation.
      ...(native
        ? [
            mounted.editor.registerAction(OPEN_LINK, ({ url }) => {
              void native.navigation.openUrl(url);
              return true;
            }),
          ]
        : []),
      mounted.editor.registerAction(
        OPEN_CONTEXT_MENU,
        ({ x, y, hasSelection }) => {
          const rect = wrapperRef.current?.getBoundingClientRect();
          if (!rect) return false;
          setMenu({
            x: rect.left + x,
            y: rect.top + y,
            hasSelection,
            hoveredItemId: null,
          });
          return true;
        },
      ),
      mounted.editor.registerAction(
        CONTEXT_MENU_POINTER_MOVE,
        ({ clientX, clientY }) => {
          const hoveredItemId =
            menuButtonAt(clientX, clientY)?.getAttribute(
              "data-context-menu-item-id",
            ) ?? null;
          setContextMenuState((prev) => {
            if (!prev || prev.hoveredItemId === hoveredItemId) return prev;
            const next = { ...prev, hoveredItemId };
            lastContextMenuStateRef.current = next;
            return next;
          });
        },
      ),
      mounted.editor.registerAction(
        CONTEXT_MENU_RELEASE,
        ({ clientX, clientY }) => {
          // Released over an item → run it (its onClick fires the action and our
          // onClose, which clears the capture flag). Released elsewhere → keep
          // the menu open for tapping; a later tap dispatches CLOSE_CONTEXT_MENU.
          menuButtonAt(clientX, clientY)?.click();
        },
      ),
      mounted.editor.registerAction(CLOSE_CONTEXT_MENU, () => {
        setMenu(null);
      }),
    );

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
    const snapshotHasContent = doc.getRawBlocks().some((b) => {
      if (isTextualBlock(b)) return b.charRuns.some((r) => r.text.length > 0);
      return true; // image and line blocks are always real content
    });

    if (snapshotHasContent) {
      // Content is already in the snapshot — reveal after the canvas renders its first frame.
      requestAnimationFrame(() => setReadyPageId(pageId));
    }

    // Observe scroll position (a node could claim SCROLL to override page
    // scrolling; the host just tracks the offset to position floating UI).
    mounted.editor.registerAction(SCROLL, ({ scrollY }) => {
      onScrollRef.current?.(scrollY);
    });

    // Skip offline store and sync setup in readonly mode
    if (readonly) {
      // In readonly mode, we only render the content - no sync, no offline store.
      // Subscribe only to re-collect node overlays (the context menu is wired via
      // the OPEN_CONTEXT_MENU action above, not derived from state here).
      const unsubscribe = mounted.editor.subscribe(() => {
        // Node-declared overlay slots (engine, framework-free) → host registry.
        // Recollected each tick; only pushed to React state when the set changes.
        const newOverlays = mounted.editor.host.collectOverlays();
        if (!nodeOverlaysEqual(newOverlays, lastNodeOverlaysRef.current)) {
          lastNodeOverlaysRef.current = newOverlays;
          setNodeOverlays(newOverlays);
        }
        // The context menu is host-owned via the OPEN_CONTEXT_MENU action
        // (registered above), no longer derived from editor state here.
      });

      // Readonly mode never receives sync updates, so reveal immediately if not already done.
      if (!snapshotHasContent) {
        setReadyPageId(pageId);
      }

      return () => {
        unsubscribe();
        disposeActions();
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
        mounted.editor.host.restoreFromSnapshot(blocks);
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
      saveSnapshot(doc.getRawBlocks());
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
      publishLocalAwareness();
    };

    onRoomAwarenessRef.current = (awarenesspeerId, state) => {
      if (state) {
        mounted.editor.view.setDecorations(
          presenceLayer(awarenesspeerId),
          cursorPresenceToDecorations(awarenesspeerId, state),
        );
        remoteUsersRef.current.set(awarenesspeerId, state.user);
      } else {
        mounted.editor.view.clearDecorations(presenceLayer(awarenesspeerId));
        remoteUsersRef.current.delete(awarenesspeerId);
      }

      onAwarenessChange?.(Array.from(remoteUsersRef.current.values()));
    };

    onRoomAwarenessStatesRef.current = (states) => {
      for (const [awarenesspeerId, state] of Object.entries(states)) {
        mounted.editor.view.setDecorations(
          presenceLayer(awarenesspeerId),
          cursorPresenceToDecorations(awarenesspeerId, state),
        );
        remoteUsersRef.current.set(awarenesspeerId, state.user);
      }

      onAwarenessChange?.(Array.from(remoteUsersRef.current.values()));
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
        publishLocalAwareness();
      }
    };

    // Local-edit broadcast/persistence is handled by the doc.on("update")
    // subscription above — the editor feeds its local ops into the doc, and the
    // doc fans them out to peers + SQLite + the snapshot.

    // Publish our cursor/selection to the room whenever it moves. The editor no
    // longer owns awareness — it just emits "selectionchange"; we convert the
    // current selection to this app's awareness wire shape and broadcast it.
    // Guard: don't broadcast before P2P identity loads (localUserRef starts as
    // { peerId: "", color: "" }).
    const publishLocalAwareness = () => {
      if (!localUserRef.current.peerId) return;
      roomBroadcastAwareness(
        selectionToCursorPresence(
          mounted.editor.state.selection.range,
          localUserRef.current,
        ),
      );
    };
    const offSelectionChange = mounted.editor.on(
      "selectionchange",
      publishLocalAwareness,
    );
    publishLocalAwareness();

    // Handle pasted image files (e.g. screenshots) — upload and update block URL.
    // Observe-only (returns void): a custom image node could register higher and
    // return true to claim IMAGE_PASTE and handle its own upload.
    mounted.editor.registerAction(IMAGE_PASTE, ({ file, blockId }) => {
      void (async () => {
        try {
          const imageData = await uploadImage(file);
          // Resolve the block by id — the index may have shifted during upload.
          const block = mounted.editor.query.block({ block: blockId });
          if (!block || block.type !== "image") return;
          // Revoke the temporary blob URL we were displaying.
          const displayedUrl = block.attrs.url;
          if (
            typeof displayedUrl === "string" &&
            displayedUrl.startsWith("blob:")
          ) {
            URL.revokeObjectURL(displayedUrl);
          }
          mounted.editor.change((c) =>
            c.setBlock(
              { url: imageData.url, alt: imageData.fileName },
              { block: block.id },
            ),
          );
        } catch (error) {
          console.error("Image paste upload failed:", error);
        }
      })();
    });

    // Handle format button clicks from native
    // Returns true if handled, false if native should open block menu
    const handleFormatButtonClick = (): boolean => {
      const containerRect = wrapperRef.current?.getBoundingClientRect();
      if (!containerRect) return false;

      const iconType = currentIconTypeRef.current;

      // Anchor in canvas/container space (the overlay shifts it into viewport
      // space). On mobile these render as full-screen drawers, so x/y are only a
      // rough origin.
      const menuX = containerRect.width / 2;
      const menuY = 100;

      const editorApi = mounted.editor;
      const range = editorApi.state.selection.range;
      const selection =
        range && typeof range === "object" && "from" in range ? range : null;

      if (iconType === "image") {
        // Open the image upload/edit menu for the selected image — rendered as a
        // drawer on mobile by the CypherImageNode "image-upload" overlay.
        if (selection) {
          const block = editorApi.query.block(selection.from);
          if (block && block.type === "image") {
            openImageUploadMenu(editorApi, block.id, menuX, menuY);
            return true;
          }
        }
        return false;
      } else if (iconType === "link") {
        // Open the link edit/create menu — rendered as a drawer on mobile by the
        // CypherLinkMark "link-edit" overlay.

        // Editing an existing link under the caret.
        const link = editorApi.query.marks().find((m) => m.name === "link");
        if (link) {
          openLinkEditMenu(editorApi, {
            blockId: link.block,
            startIndex: link.from,
            endIndex: link.to,
            url: (link.attrs.url as string | undefined) ?? "",
            text: link.text,
            x: menuX,
            y: menuY,
          });
          return true;
        }

        // Creating a new link from a selection.
        if (
          selection &&
          typeof selection.from === "object" &&
          typeof selection.to === "object"
        ) {
          const { from, to } = selection;
          const block = editorApi.query.block(from);
          if (block && block.type !== "image") {
            const startIndex = "offset" in from ? (from.offset ?? 0) : 0;
            const endIndex = "offset" in to ? (to.offset ?? 0) : 0;
            const selectedText = block.text.substring(startIndex, endIndex);
            openLinkEditMenu(editorApi, {
              blockId: block.id,
              startIndex,
              endIndex,
              url: "",
              text: "",
              selectedText,
              x: menuX,
              y: menuY,
            });
            return true;
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
        mounted.editor.change((c) => c.setBlock({ type: type as any })),
      focus: () => {
        mounted.editor.setFocus(true);
        mounted.editor.setCaret("start", { onlyIfUnset: true });
      },
      onFormatButtonClick: handleFormatButtonClick,
      toggleStrong: () => mounted.editor.change((c) => c.setMark("strong")),
      toggleEmphasis: () => mounted.editor.change((c) => c.setMark("emphasis")),
      toggleCode: () => mounted.editor.change((c) => c.setMark("code")),
      toggleStrike: () => mounted.editor.change((c) => c.setMark("strike")),
    };

    window.CypherEditorCallbacks = editorMethods;

    // Content lifecycle rides the public `on("change")` op channel — `tx.isRemote`
    // tells local edits from sync, so no raw state is needed. `getRawBlocks()` is
    // the full CRDT array (incl. tombstones, matching the old `page.blocks`);
    // filtering tombstones yields the visible set word-count/export consumes.
    const emitContentUpdate = () => {
      onContentUpdateRef.current?.(
        doc.getRawBlocks().filter((b) => !b.deleted),
      );
    };
    // `on("change")` doesn't fire on mount, so seed the initial word count once.
    emitContentUpdate();
    const offContent = mounted.editor.on("change", (tx) => {
      emitContentUpdate();
      // Saves + find-bar close only for local edits; remote peers save their own.
      if (!tx.isRemote) {
        if (findBarOpenRef.current) handleFindCloseRef.current?.();
        onContentChangeRef.current?.(doc.getRawBlocks());
      }
    });

    // Per-tick UI chrome, derived purely from the public snapshot + query +
    // collected overlays. Fires on any state change — including scroll, so
    // overlay rects and the toolbar stay in sync as the document moves.
    const offUi = mounted.editor.subscribe((snapshot) => {
      // Node-declared overlay slots (engine, framework-free) → host registry.
      // Only pushed to React state when the set changes.
      const newOverlays = mounted.editor.host.collectOverlays();
      if (!nodeOverlaysEqual(newOverlays, lastNodeOverlaysRef.current)) {
        lastNodeOverlaysRef.current = newOverlays;
        setNodeOverlays(newOverlays);
      }
      // Suspend the canvas while a text-input popover (image upload or link
      // edit) is open. Those popovers surface as node/mark overlays, so detect
      // them by key here rather than reaching into the engine's active-menu
      // state. (link-tooltip / image-hover are non-modal and don't suspend.)
      setModalPopoverOpen(
        newOverlays.some(
          (o) => o.key === "image-upload" || o.key === "link-edit",
        ),
      );

      // Toolbar icon: image block selected → "image"; a link under the caret or
      // a single-block text selection → "link"; a selection spanning blocks →
      // "none"; otherwise "format".
      const range = snapshot.selection.range;
      const span =
        range && typeof range === "object" && "from" in range ? range : null;
      // A selection's endpoints are always absolute `{ block, offset }` points
      // (docSelection resolves them), but DocPoint's type also admits string
      // anchors — narrow to the object form before reading the block id.
      const blockOf = (p: typeof range): string | null =>
        p && typeof p === "object" && "block" in p ? p.block : null;
      let iconType: "link" | "image" | "format" | "none";
      if (span) {
        const fromBlock = blockOf(span.from);
        const toBlock = blockOf(span.to);
        if (fromBlock && toBlock && fromBlock !== toBlock) {
          iconType = "none";
        } else if (
          fromBlock &&
          mounted.editor.query.block({ block: fromBlock })?.type === "image"
        ) {
          iconType = "image";
        } else {
          iconType = "link";
        }
      } else if (mounted.editor.query.marks().some((m) => m.name === "link")) {
        iconType = "link";
      } else {
        iconType = "format";
      }
      currentIconTypeRef.current = iconType;

      // Mobile toolbar — entirely from the snapshot/query. `activeMarks` is the
      // selection-aware (intersection across the span + pending caret toggles)
      // mark set, so it replaces the old per-char format scan.
      const rawBlockType = mounted.editor.query.block()?.type ?? "paragraph";
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
        canUndo: snapshot.canUndo,
        canRedo: snapshot.canRedo,
        isBold: snapshot.activeMarks.has("strong"),
        isItalic: snapshot.activeMarks.has("emphasis"),
        isCode: snapshot.activeMarks.has("code"),
        isStrikethrough: snapshot.activeMarks.has("strike"),
        blockType,
        isEditorFocused: snapshot.isFocused,
      });
    });

    // Auto-focus the editor when requested
    if (autoFocus) {
      mounted.editor.setFocus(true);

      // Restore by stable block id and viewport-relative anchor. The height
      // index can jump to this block using estimates, so opening near the end
      // no longer requires measuring every preceding block first. Older saved
      // entries fall back to their raw scroll offset.
      const saved = loadCursorPosition(pageId);
      if (saved) {
        mounted.editor.setCaret({ block: saved.block, offset: saved.offset });
        if (saved.viewportOffsetY !== undefined) {
          mounted.editor.view.scrollToPosition(
            { block: saved.block, offset: saved.offset },
            { viewportOffsetY: saved.viewportOffsetY },
          );
        } else if (saved.scrollY > 0) {
          mounted.editor.view.updateViewport({ scrollY: saved.scrollY });
        }
      }
      mounted.editor.setCaret("start", { onlyIfUnset: true });
    }

    // Programmatic cursor restoration updates the viewport directly and does
    // not dispatch SCROLL. Seed host overlays with the restored offset so they
    // do not flash at the top of an already-scrolled document on first paint.
    onScrollRef.current?.(mounted.editor.view.getScrollY());

    return () => {
      offContent();
      offUi();
      disposeActions();
      offDocUpdate();
      offSelectionChange();
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

  // Re-publish our awareness when localUser becomes available, so connected
  // peers overwrite any stale entry they stored before our identity finished
  // loading (color: ""). The ongoing broadcast is driven by the editor's
  // "selectionchange" subscription wired in the mount effect above.
  useEffect(() => {
    if (mountedRef.current && localUser.peerId) {
      roomBroadcastAwareness(
        selectionToCursorPresence(
          mountedRef.current.editor.state.selection.range,
          localUser,
        ),
      );
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
      mountedRef.current?.editor.view.clearDecorations("search");
      return;
    }

    const matches: {
      blockId: string;
      startIndex: number;
      endIndex: number;
    }[] = [];
    const lowerSearch = text.toLowerCase();

    for (const block of mountedRef.current.editor.query.blocks({
      from: "start",
      to: "end",
    })) {
      const content = block.text.toLowerCase();
      if (!content) continue;

      let pos = 0;
      while (true) {
        const idx = content.indexOf(lowerSearch, pos);
        if (idx === -1) break;
        matches.push({
          blockId: block.id,
          startIndex: idx,
          endIndex: idx + text.length,
        });
        pos = idx + 1;
      }
    }

    setFindMatches(matches);
    const newActiveIndex = matches.length > 0 ? 0 : -1;
    setFindActiveIndex(newActiveIndex >= 0 ? newActiveIndex : 0);
    mountedRef.current.editor.view.setDecorations(
      "search",
      searchDecorations(matches, newActiveIndex >= 0 ? newActiveIndex : -1),
    );
    // Scroll to first match
    if (matches.length > 0) {
      mountedRef.current.editor.view.scrollToPosition({
        block: matches[0].blockId,
        offset: matches[0].startIndex,
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
      mountedRef.current.editor.view.setDecorations(
        "search",
        searchDecorations(findMatches, index),
      );
      const match = findMatches[index];
      if (match) {
        // setSelection speaks DocPoints, so the match's stable block id selects
        // the span directly — no index resolution needed.
        mountedRef.current.editor.setSelection({
          from: { block: match.blockId, offset: match.startIndex },
          to: { block: match.blockId, offset: match.endIndex },
        });
        mountedRef.current.editor.view.scrollToPosition({
          block: match.blockId,
          offset: match.startIndex,
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
    mountedRef.current?.editor.view.clearDecorations("search");
    // Refocus editor

    mountedRef.current?.editor.setFocus(true);
  }, []);
  handleFindCloseRef.current = handleFindClose;

  // Stable so the always-mounted SlashActionMenu doesn't re-register its engine
  // listeners on every render (wrapperRef is itself stable).
  const getSlashContainerRect = useCallback(
    () => wrapperRef.current?.getBoundingClientRect(),
    [],
  );

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
        editor.change((c) => c.select({ from: "start", to: "end" }));
        break;
    }
    // The menu's own onClose (fired right after the item action) clears the
    // host-capture flag and dismisses the popover.
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
      const block = mountedRef.current?.editor.query.block();
      if (block && block.type === "image" && block.attrs.url) {
        const url = block.attrs.url as string;
        const alt = block.attrs.alt as string | undefined;
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
      // The marks active across the selection (the canonical "all chars carry
      // it" reading, with explicit/caret-inherited formats folded in).
      const marks = mountedRef.current?.editor.state.activeMarks;
      const isBold = marks?.has("strong") ?? false;
      const isItalic = marks?.has("emphasis") ?? false;
      const isCode = marks?.has("code") ?? false;
      const isStrikethrough = marks?.has("strike") ?? false;

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
              mountedRef.current?.editor.change((c) => c.setMark("strong")),
            active: isBold,
          },
          {
            id: "format-italic",
            label: t("contextMenu.italic", "Italic"),
            icon: <Italic size={16} />,
            action: () =>
              mountedRef.current?.editor.change((c) => c.setMark("emphasis")),
            active: isItalic,
          },
          {
            id: "format-code",
            label: t("contextMenu.code", "Code"),
            icon: <Code size={16} />,
            action: () =>
              mountedRef.current?.editor.change((c) => c.setMark("code")),
            active: isCode,
          },
          {
            id: "format-strikethrough",
            label: t("contextMenu.strikethrough", "Strikethrough"),
            icon: <Strikethrough size={16} />,
            action: () =>
              mountedRef.current?.editor.change((c) => c.setMark("strike")),
            active: isStrikethrough,
          },
          {
            id: "format-link",
            label: t("contextMenu.link", "Link"),
            icon: <Link size={16} />,
            action: () => {
              const mountedEditor = mountedRef.current?.editor;
              const range = mountedEditor?.state.selection.range;
              // A non-collapsed selection resolves to a { from, to } of absolute
              // { block, offset } points; narrow off the wide DocRange union.
              if (
                !mountedEditor ||
                !range ||
                typeof range !== "object" ||
                !("from" in range)
              )
                return;
              const { from, to } = range;
              if (
                typeof from !== "object" ||
                "side" in from ||
                typeof to !== "object" ||
                "side" in to
              )
                return;
              const startIndex = from.offset ?? 0;
              const endIndex = to.offset ?? 0;
              const block = mountedEditor.query.block(from);
              if (!block || block.type === "image") return;
              const selectedText = block.text.substring(startIndex, endIndex);
              const containerRect = wrapperRef.current?.getBoundingClientRect();
              if (!containerRect) return;
              // Open the link create menu — rendered as a drawer on mobile by
              // the CypherLinkMark "link-edit" overlay.
              openLinkEditMenu(mountedEditor, {
                blockId: from.block,
                startIndex,
                endIndex,
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

    const mode = mountedRef.current.editor.state.mode;

    if (modalPopoverOpen) {
      // Set editor to suspended mode when popover opens (only if not already suspended)
      if (mode !== "suspended") {
        mountedRef.current.editor.host.setMode("suspended");
      }
    } else {
      // Restore to edit mode when popover closes (only if currently suspended)
      if (mode === "suspended") {
        mountedRef.current.editor.host.setMode("edit");
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
      // While the soft keyboard is open, cap the height so the canvas (which
      // tracks this element via ResizeObserver) ends above the keyboard and the
      // floating MobileKeyboardToolbar.
      style={
        keyboardInset > 0
          ? { height: `max(100px, calc(100% - ${keyboardInset}px))` }
          : undefined
      }
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
      {/* Slash menu — self-contained, always mounted: it observes the engine's
          TEXT_INPUT command to open and drives CONVERT_BLOCK to apply. */}
      {mountedRef.current?.portalContainer &&
        mountedRef.current.editor &&
        createPortal(
          <SlashActionMenu
            editor={mountedRef.current.editor}
            getContainerRect={getSlashContainerRect}
          />,
          mountedRef.current.portalContainer,
        )}

      {/* Math `\` command menu — Corca-style autocomplete inside math chips. */}
      {mountedRef.current?.portalContainer &&
        mountedRef.current.editor &&
        createPortal(
          <MathCommandMenu
            editor={mountedRef.current.editor}
            getContainerRect={getSlashContainerRect}
          />,
          mountedRef.current.portalContainer,
        )}

      {/* WYSIWYG inline-math overlay — a roomy, live mirror of the inline-math
          chip the caret is inside (the on-line chip is tiny to edit in). */}
      {mountedRef.current?.portalContainer &&
        mountedRef.current.editor &&
        createPortal(
          <InlineMathOverlay
            editor={mountedRef.current.editor}
            getContainerRect={getSlashContainerRect}
          />,
          mountedRef.current.portalContainer,
        )}

      {/* Context menu portal */}
      {contextMenuState && (
        <ContextMenu
          x={contextMenuState.x}
          y={contextMenuState.y}
          items={getContextMenuItems()}
          onClose={() => {
            // Clears the engine's capture flag (observer) and dismisses the menu
            // (our CLOSE_CONTEXT_MENU handler calls setMenu(null)).
            mountedRef.current?.editor.dispatch(CLOSE_CONTEXT_MENU);
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
              key={`${overlay.key}:${overlay.blockId}`}
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
          "image-hover"). The suspended-mode signal is the `modalPopoverOpen`
          mirror, derived from the engine's active menu. */}

      {/* The inline-math WYSIWYG mirror renders as a standalone portal
          (InlineMathOverlay, above), not via the node-overlay registry. */}

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
            mountedRef.current?.editor.change((c) => c.setMark("strong"))
          }
          onToggleItalic={() =>
            mountedRef.current?.editor.change((c) => c.setMark("emphasis"))
          }
          onToggleCode={() =>
            mountedRef.current?.editor.change((c) => c.setMark("code"))
          }
          onToggleStrikethrough={() =>
            mountedRef.current?.editor.change((c) => c.setMark("strike"))
          }
          onSetBlockType={(type) =>
            mountedRef.current?.editor.change((c) =>
              c.setBlock({ type: type as any }),
            )
          }
          onDismissKeyboard={() => mountedRef.current?.blurInput()}
        />
      )}

      {/* Cursor magnifier for mobile cursor drag repositioning */}
      {magnifierActive &&
        createPortal(
          <CursorMagnifier
            active={magnifierActive}
            getCaretCoords={() =>
              mountedRef.current?.editor.view.coordsAtPos("caret") ?? null
            }
            getTouch={() => latestTouchRef.current}
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
