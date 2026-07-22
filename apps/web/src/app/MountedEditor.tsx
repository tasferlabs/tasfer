import { type SyncState } from "@/app/hooks/useP2PRoom";
import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { Input } from "@/components/ui/input";
import { getPlatform } from "@/platform";
import { getBridge } from "@/platform/bridge";
import {
  CLOSE_CONTEXT_MENU,
  CONTEXT_MENU_POINTER_MOVE,
  CONTEXT_MENU_RELEASE,
  CURSOR_DRAG_BOUNDARY,
  CURSOR_DRAG_END,
  CURSOR_DRAG_MOVE,
  CURSOR_DRAG_START,
  DRAG_DETENT,
  IMAGE_PASTE,
  INDENT_CODE,
  INDENT_LIST_ITEM,
  MOVE_CURSOR_LEFT,
  MOVE_CURSOR_RIGHT,
  OPEN_CONTEXT_MENU,
  OPEN_LINK,
  OUTDENT_CODE,
  OUTDENT_LIST_ITEM,
  REGION_DRAG_START,
  SCROLL,
  TEXT_INPUT,
  mergeRegister,
  type Block,
  type CursorDragInfo,
  type Decoration,
  type DocPoint,
} from "@tasfer/editor";
import {
  INSERT_MATH_COMMAND,
  RESIZE_MATH_MATRIX,
  mathCommandInsertion,
  mathMatrixContext,
  mathMatrixContextInRange,
  mathMatrixResize,
  mathSourceAtEdge,
} from "@tasfer/editor/math";
import {
  CODE_LANGUAGES,
  cleanSnapshotForSave,
  clearFailedImageCache,
  canHaveFormats,
  codeLanguageLabel,
  isAndroid,
  isTextualBlock,
  isTouchDevice,
  type EditorWiring,
  type NodeOverlay,
  type PlaceholderStyles,
  type TextStyle,
} from "@tasfer/editor/internal";
import {
  cursorPresenceToDecorations,
  getDisplayName,
  selectionToCursorPresence,
  isSamePerson,
  type CursorPresence,
  type CursorUser,
} from "@tasfer/provider-core/cursors";
import {
  collidingDisplayNames,
  deviceIcon,
  isCollidingName,
} from "@/lib/presenceLabels";
import i18next from "i18next";
import {
  Bold,
  Check,
  Clipboard,
  Code,
  Copy,
  Download,
  Grid3x3,
  Image as ImageIcon,
  Italic,
  Link,
  Scissors,
  Search,
  Sigma,
  Strikethrough,
  Type,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { ContextMenu, type ContextMenuItem } from "../editor/ContextMenu";
import {
  toNativeMenu,
  getNativeContextMenuPresenter,
  prewarmMenuIcons,
} from "./nativeContextMenu";
import { FindBar } from "../editor/FindBar";
import { ImageUploadPopover } from "../editor/ImageUploadPopover";
import { LinkDrawer } from "../editor/LinkDrawer";
import { LinkEditPopover } from "../editor/LinkEditPopover";
import { LinkTooltip } from "../editor/LinkTooltip";
import { MathCommandMenu } from "../editor/MathCommandMenu";
import {
  activeTreeMath,
  treeMathAtAnchor,
  treeMathAtFocus,
  treeMathCommandRun,
} from "../editor/treeMath";
import { MatrixEditor } from "../editor/MatrixEditor";
import { SlashActionMenu } from "../editor/SlashActionMenu";
import {
  appSchema,
  openCodeLanguageMenu,
  openImageUploadMenu,
  openLinkEditMenu,
  type LinkEditOverlayData,
  type AppMountedEditor as MountedEditorInstance,
} from "../editorSchema";
import { useSafeAreaInsets } from "./hooks/useSafeAreaInsets";
import { cn } from "../lib/utils";
import { uploadImage } from "./api/images.api";
import { CursorMagnifier } from "./components/CursorMagnifier";
import { MobileKeyboardToolbar } from "./components/MobileKeyboardToolbar";
import {
  fontStyleToFamily,
  horizontalPaddingForWidth,
  editorThemeForDensity,
  usePageSettings,
} from "./contexts/PageSettingsContext";
import useResponsive from "./hooks/useResponsive";
import {
  activeBlockMathCommand,
  createMobileToolbarModel,
  isMobileToolbarBlockType,
  mathChipAssetName,
  type MobileToolbarAction,
  type MobileToolbarBlockType,
  type MobileToolbarMathContext,
  type MobileToolbarMatrixContext,
  type NativeMobileToolbarModel,
} from "./mobileToolbar";
import {
  isFormattingToolbarSuppressed,
  onFormattingToolbarSuppressionChange,
  postKeyboardAccessoryFocus,
} from "./mobileToolbarSuppression";
import { EditorLoadingState } from "./pages/EditorPage";
// The whole page mounts on the shared EditorCore (theme, strings, fonts, and
// live dark-mode/font re-theming) — the same core a TitleEditor uses, so both
// surfaces render identically and gain editor features together (see `editorCore`).
import { useEditorCore } from "./editorCore";
import {
  useCollaborativeDoc,
  type CollaborativeDoc,
} from "./useCollaborativeDoc";

function toolbarBlockTypeFromQueryBlock(
  block: { type: string; attrs?: Record<string, unknown> } | null | undefined,
): MobileToolbarBlockType {
  if (!block) return "paragraph";
  if (block.type === "heading") {
    const level = Number(block.attrs?.level);
    if (level === 1 || level === 2 || level === 3) {
      return `heading${level}` as MobileToolbarBlockType;
    }
    return "heading1";
  }
  return isMobileToolbarBlockType(block.type) ? block.type : "paragraph";
}

/**
 * The inline-math chip the caret rests in or directly abuts in block `blockId`,
 * or undefined. BOTH edges count as in the chip, mirroring the engine's
 * edge-join (typing at either boundary extends the same formula, so the math
 * toolbar should help there too):
 *
 * - The start edge / interior is left-inclusive — `query.marks` returns a run
 *   for `from <= offset < to`. This also covers a single-char chip, whose only
 *   caret stop is its start edge (a tap snaps there; see TextNode.hitTest).
 * - The end edge is right-exclusive in `query.marks`, so a caret at `to` (the
 *   common "I just finished the chip, keep going" spot) returns no run. Probe
 *   one position back: a math run ending exactly at the caret is the right edge.
 *
 * `marksAt` is `editor.query.marks` (an arrow property, so it stays bound);
 * generic over the schema's mark-info element so it accepts it as-is.
 */
function inlineMathChipAt<M extends { name: string; from: number; to: number }>(
  marksAt: (at?: DocPoint) => M[],
  blockId: string,
  caretOffset: number,
): M | undefined {
  const here = marksAt({ block: blockId, offset: caretOffset }).find(
    (mark) => mark.name === "math",
  );
  if (here) return here;
  if (caretOffset > 0) {
    const before = marksAt({ block: blockId, offset: caretOffset - 1 }).find(
      (mark) => mark.name === "math",
    );
    if (before && before.to === caretOffset) return before;
  }
  return undefined;
}

type EditorInstance = MountedEditorInstance["editor"];

/**
 * Where a matrix edit for the current caret would apply. Resolves the caret to a
 * math source and a source-local offset: a block equation is its whole text; an
 * inline chip is its own LaTeX at a chip-local offset (with `chip` carrying the
 * block-relative bounds so the caller can map offsets back). Null when the caret
 * is not in math. Used by both the toolbar drawer and the context menu.
 */
function matrixCaretTarget(editor: EditorInstance): {
  blockId: string;
  sourceLatex: string;
  localOffset: number;
  /** Far end of a same-block range selection; equals `localOffset` at a caret. */
  localEnd: number;
  chip: { from: number; to: number } | null;
} | null {
  const range = editor.state.selection.range;
  if (!range || typeof range !== "object") return null;
  let blockId: string | undefined;
  let offset: number | undefined;
  let end: number | undefined;
  if ("offset" in range && "block" in range) {
    blockId = range.block;
    offset = range.offset ?? 0;
  } else if ("from" in range) {
    const from = range.from;
    if (
      from &&
      typeof from === "object" &&
      !("side" in from) &&
      "block" in from
    ) {
      blockId = from.block;
      offset = from.offset ?? 0;
      const to = "to" in range ? range.to : undefined;
      if (
        to &&
        typeof to === "object" &&
        !("side" in to) &&
        "block" in to &&
        to.block === blockId
      ) {
        end = to.offset ?? 0;
      }
    }
  }
  if (blockId === undefined || offset === undefined) return null;

  const block = editor.query.block({ block: blockId, offset });
  if (!block) return null;
  if (block.type === "math") {
    return {
      blockId: block.id,
      sourceLatex: block.text,
      localOffset: offset,
      localEnd: end ?? offset,
      chip: null,
    };
  }
  const chip = inlineMathChipAt(editor.query.marks, block.id, offset);
  if (!chip) return null;
  return {
    blockId: block.id,
    sourceLatex: chip.text,
    localOffset: offset - chip.from,
    // A range reaching past the chip still only addresses this chip's LaTeX.
    localEnd: Math.min(end ?? offset, chip.to) - chip.from,
    chip: { from: chip.from, to: chip.to },
  };
}

/**
 * The grid the caret sits in, in the toolbar/context-menu shape — or null when
 * the caret is not inside a matrix. Thin adapter over {@link mathMatrixContext}
 * that maps the caret to its math source first.
 */
function matrixContextForCaret(
  editor: EditorInstance,
): MobileToolbarMatrixContext | null {
  // Structured math keeps its authoritative source and nested focus outside the
  // legacy flat selection. Resolve it first so the matrix action is available
  // both at a tree caret and while a construct inside MathNode/MathMark is held.
  const treeFocus = treeMathAtFocus(editor);
  const treeAnchor = treeMathAtAnchor(editor);
  const treeTargets = [treeFocus, treeAnchor].filter(
    (target): target is NonNullable<typeof target> => target !== null,
  );
  // A whole construct selection ends immediately after the matrix. That focus
  // is outside the environment's exclusive source span, while its anchor is on
  // the opening boundary; probe both endpoints before declaring no matrix.
  const treeEndpointCtx = treeTargets
    .map((target) => mathMatrixContext(target.source, target.sourceOffset))
    .find((ctx) => ctx !== null);
  // A mouse drag across the matrix can anchor before `\begin` AND focus on the
  // exclusive span end — both endpoint probes miss. Resolve the swept range.
  const treeRangeCtx =
    treeFocus &&
    treeAnchor &&
    treeFocus.blockId === treeAnchor.blockId &&
    treeFocus.contentId === treeAnchor.contentId &&
    treeFocus.sourceOffset !== treeAnchor.sourceOffset
      ? mathMatrixContextInRange(
          treeFocus.source,
          treeAnchor.sourceOffset,
          treeFocus.sourceOffset,
        )
      : null;
  const treeCtx = treeEndpointCtx ?? treeRangeCtx;
  const target = treeTargets.length === 0 ? matrixCaretTarget(editor) : null;
  const ctx =
    treeCtx ??
    (target
      ? (mathMatrixContext(target.sourceLatex, target.localOffset) ??
        (target.localEnd !== target.localOffset
          ? mathMatrixContextInRange(
              target.sourceLatex,
              target.localOffset,
              target.localEnd,
            )
          : null))
      : null);
  if (!ctx) return null;
  return {
    env: ctx.env,
    rows: ctx.rows,
    cols: ctx.cols,
    row: ctx.row,
    col: ctx.col,
  };
}

/**
 * Resize the matrix at the current caret to `rows` × `cols`. Rewrites the
 * enclosing environment's source span through the normal `editor.change` path;
 * for an inline chip it re-marks the (grown/shrunk) run as math so the rewrite
 * joins the chip rather than spilling raw LaTeX. The caret is left inside the
 * grid so a following resize still resolves it. No-op when the caret is not in a
 * matrix. Does not touch DOM focus — the resize is driven from a dialog/drawer
 * that must keep focus while it is open.
 */
function applyMatrixResize(
  editor: EditorInstance,
  rows: number,
  cols: number,
): void {
  if (treeMathAtFocus(editor)) {
    editor.dispatch(RESIZE_MATH_MATRIX, { rows, cols });
    return;
  }
  const target = matrixCaretTarget(editor);
  if (!target) return;
  const result = mathMatrixResize(
    target.sourceLatex,
    target.localOffset,
    rows,
    cols,
  );
  if (!result || result.edits.length === 0) return;

  const base = target.chip ? target.chip.from : 0;
  // Net length change — the chip's new end, for re-marking inline math.
  const delta = result.edits.reduce(
    (d, e) => d + (e.text.length - (e.end - e.start)),
    0,
  );
  // Apply right-to-left (descending start) so each edit's original offsets stay
  // valid against the yet-unmodified left side; at a shared start apply the
  // deletion (longer range) before the insertion so the new cells land at the
  // freed boundary.
  const ordered = [...result.edits].sort(
    (a, b) => b.start - a.start || b.end - b.start - (a.end - a.start),
  );

  editor.change((change) => {
    for (const e of ordered) {
      const from = { block: target.blockId, offset: e.start + base };
      const to = { block: target.blockId, offset: e.end + base };
      if (e.text.length === 0) change.deleteRange({ from, to });
      else change.insertText(e.text, { from, to });
    }
    // Inline chips: appended cells land inside the math mark's extent but don't
    // inherit it — re-mark the chip's new span so the grid stays one formula.
    if (target.chip) {
      const newTo = target.chip.to + delta;
      if (newTo > target.chip.from) {
        change.setMark("math", {
          active: true,
          range: {
            from: { block: target.blockId, offset: target.chip.from },
            to: { block: target.blockId, offset: newTo },
          },
        });
      }
    }
    change.select({ block: target.blockId, offset: result.caret + base });
  });
}

/**
 * Host overlay registry: maps a node-declared overlay `key` (see
 * {@link NodeOverlay}) to the React component that renders it. Node-declared
 * overlays are framework-free in the engine — this registry is where they
 * become real UI, positioned at the descriptor's `rect`.
 *
 * The built-in image-upload popover renders here: `TasferImageNode.overlays()`
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
 * Renders the image upload/edit popover for a `TasferImageNode`-declared
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
    if (window.TasferBridge) refocus();
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
 * `TasferImageNode`-declared `"image-hover"` slot. The descriptor's `rect` is
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
 * Renders the link hover tooltip for a `TasferLinkMark`-declared
 * `"link-tooltip"` slot. "Edit" promotes the hover menu to the `linkEdit` menu
 * in place (clearing the selection first, as the old flow did). In a readonly
 * document the Edit affordance is omitted, leaving only "Open".
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
        onDismiss={() => editor.host.clearLinkHover()}
        onOpen={() => {
          if (window.TasferBridge) {
            window.TasferBridge.navigation.openUrl(url);
          } else {
            window.open(url, "_blank", "noopener,noreferrer");
          }
        }}
        // Readonly documents show the tooltip for opening the link only —
        // editing the URL mutates the doc, so the Edit affordance is dropped
        // (the tooltip hides the button when `onEdit` is absent). Gated on
        // `isReadonlyBase` so it also holds in the select mode used for copy.
        onEdit={
          editor.state.isReadonlyBase
            ? undefined
            : () => {
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
              }
        }
      />
    </div>
  );
};

/**
 * Renders the link edit/create popover (desktop) or drawer (mobile) for a
 * `TasferLinkMark`-declared `"link-edit"` slot. Both update/clear the link via
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
    if (window.TasferBridge) refocus();
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
  refocus,
}) => {
  const { t } = useTranslation();
  const isMobile = useResponsive("(max-width: 768px)");
  const [search, setSearch] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const { blockId } = overlay;
  // On mobile the drawer's open state is the engine's `activeMenu` (mirrored onto
  // the descriptor's `data.open` by TasferCodeNode), so the picker can be opened
  // from the floating chip or the keyboard toolbar's "code language" button
  // through one source of truth. Closing clears the menu.
  const drawerOpen = Boolean((overlay.data as { open?: boolean })?.open);
  const closeDrawer = () => {
    editor.host.closeActiveMenu();
    setSearch("");
    // Restore the mobile keyboard/toolbar after the modal drawer dismisses.
    if (window.TasferBridge) refocus();
  };
  const block = editor.query.block({ block: blockId });
  if (block?.type !== "code") return null;

  const language = block.attrs.language;
  const currentLabel = codeLanguageLabel(
    typeof language === "string" ? language : undefined,
  );
  const items = CODE_LANGUAGES.map((l) => l.label);

  const handleChange = (label: string | null) => {
    const nextLanguage =
      CODE_LANGUAGES.find((l) => l.label === label)?.id ?? "";
    const b = editor.query.block({ block: blockId });
    if (b && b.type === "code") {
      editor.change((c) =>
        c.setBlock({ language: nextLanguage }, { block: b.id }),
      );
    }
  };

  const normalizedSearch = search.trim().toLowerCase();
  const filteredLanguages = CODE_LANGUAGES.filter((option) => {
    if (!normalizedSearch) return true;
    return [option.label, option.id, ...(option.aliases ?? [])].some((value) =>
      value.toLowerCase().includes(normalizedSearch),
    );
  });

  const triggerClassName =
    "h-7 w-auto gap-1 rounded-md border-border/60 bg-background/80 px-2 shadow-none backdrop-blur-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors";

  if (isMobile) {
    // No floating chip on mobile: the code block's language is edited entirely
    // from the keyboard toolbar's "code language" button, which opens this
    // drawer via the `code-language` menu (see `openCodeLanguageMenu`). The
    // component still mounts for every visible code block (the always-on overlay
    // slot), but renders nothing until that menu targets this block.
    return (
      <Drawer
        open={drawerOpen}
        onOpenChange={(open) => {
          if (!open) closeDrawer();
        }}
        modal={true}
        dismissible={true}
        shouldScaleBackground={false}
      >
        <DrawerContent
          data-editor-overlay
          className="md:h-[min(72vh,560px)] overflow-hidden"
          // Focus the search field as the drawer opens (Radix would otherwise
          // land focus on the first list item), so typing filters immediately
          // and the soft keyboard comes up ready for the query.
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            searchInputRef.current?.focus();
          }}
        >
          <div className="mx-auto flex h-full w-full max-w-lg flex-col">
            <DrawerHeader className="pb-2">
              <DrawerTitle>
                {t("code.selectLanguage", "Select language")}
              </DrawerTitle>
            </DrawerHeader>
            <div className="relative px-4 pb-3">
              <Search
                aria-hidden="true"
                className="absolute start-7 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                ref={searchInputRef}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t("editor.search", "Search...")}
                aria-label={t("editor.search", "Search...")}
                className="h-11 ps-10"
              />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto border-t border-border/50 p-2">
              {filteredLanguages.length > 0 ? (
                filteredLanguages.map((option) => (
                  <Button
                    key={option.id}
                    type="button"
                    variant="ghost"
                    className="h-11 w-full justify-start gap-3 px-3"
                    onClick={() => {
                      handleChange(option.label);
                      closeDrawer();
                    }}
                  >
                    <Check
                      className={cn(
                        "size-4 shrink-0",
                        currentLabel === option.label
                          ? "opacity-100"
                          : "opacity-0",
                      )}
                    />
                    <span>{option.label}</span>
                  </Button>
                ))
              ) : (
                <div className="px-4 py-10 text-center text-sm text-muted-foreground">
                  {t("common.noResults", "No results")}
                </div>
              )}
            </div>
          </div>
        </DrawerContent>
      </Drawer>
    );
  }

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
          className={triggerClassName}
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
  const resolvedUrl = await resolveImageUrl(url);

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

  const bridge = window.TasferBridge;
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

async function resolveImageUrl(url: string): Promise<string> {
  const isAlreadyUrl =
    url.startsWith("blob:") ||
    url.startsWith("data:") ||
    url.startsWith("http://") ||
    url.startsWith("https://");
  if (isAlreadyUrl) return url;
  try {
    return await getPlatform().assets.getUrl(url);
  } catch {
    // fall through; fetch will fail with the unresolved ref
    return url;
  }
}

/**
 * The async clipboard API only reliably accepts `image/png` across browsers, so
 * decode anything else through a canvas before writing.
 */
async function blobToPngBlob(blob: Blob): Promise<Blob> {
  if (blob.type === "image/png") return blob;
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d context unavailable");
    ctx.drawImage(bitmap, 0, 0);
    const png = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/png"),
    );
    if (!png) throw new Error("canvas.toBlob returned null");
    return png;
  } finally {
    bitmap.close();
  }
}

async function copyImageToClipboard(url: string): Promise<void> {
  const resolvedUrl = await resolveImageUrl(url);
  const response = await fetch(resolvedUrl);
  const blob = await response.blob();
  const png = await blobToPngBlob(blob);
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
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
const CURSOR_STORAGE_KEY = "tasfer:cursor-positions";
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
  /**
   * Receives the live editor handle once mounted (and `null` on unmount). Used
   * by the host to expose the editor to debug chrome (the staging DevToolbar's
   * Editor tab). Only the primary, editing instance should wire this — readonly
   * previews leave it unset so they never become the "active" editor.
   */
  onEditorReady?: (editor: MountedEditorInstance["editor"] | null) => void;
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
  /**
   * Reports the editor's current symmetric horizontal canvas padding (px),
   * which tracks the wide/narrow width setting and viewport size. Hosts use this
   * to align chrome overlaid on the canvas (e.g. the schedule tag) with the text
   * column. Fired on mount and whenever the padding changes.
   */
  onHorizontalPaddingChange?: (paddingPx: number) => void;
}

// Find-in-document highlight colors (host-owned now that the engine paints
// generic decorations rather than knowing about "search"). Active match is
// emphasized; both opt into a scrollbar gutter marker. Colors come from CSS
// variables so they track the theme / dark mode and a rebrand can retint them;
// the historical yellow/orange is the fallback when the vars are absent.
const SEARCH_HIGHLIGHT_FALLBACK = "#facc15";
const SEARCH_HIGHLIGHT_ACTIVE_FALLBACK = "#f97316";
const SEARCH_HIGHLIGHT_OPACITY = 0.35;
const SEARCH_HIGHLIGHT_ACTIVE_OPACITY = 0.5;

/** Read a CSS custom property off the document root, or a fallback (SSR/tests). */
function readRootCssVar(name: string, fallback: string): string {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return fallback;
  }
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return value || fallback;
}

/** Build the find-decoration list for a set of matches and the active index. */
function searchDecorations(
  matches: { blockId: string; startIndex: number; endIndex: number }[],
  activeIndex: number,
): Decoration[] {
  const baseColor = readRootCssVar(
    "--editor-search-highlight",
    SEARCH_HIGHLIGHT_FALLBACK,
  );
  const activeColor = readRootCssVar(
    "--editor-search-highlight-active",
    SEARCH_HIGHLIGHT_ACTIVE_FALLBACK,
  );
  return matches.map((m, i) => {
    const isActive = i === activeIndex;
    return {
      kind: "range",
      range: {
        from: { block: m.blockId, offset: m.startIndex },
        to: { block: m.blockId, offset: m.endIndex },
      },
      color: isActive ? activeColor : baseColor,
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
 * Minimum visualViewport shrink (CSS px) that counts as an open soft keyboard on
 * plain web. Comfortably above transient chrome like the mobile URL bar, so a
 * touch-capable desktop — which never opens a soft keyboard — stays below it and
 * keeps the mobile toolbar hidden.
 */
const MOBILE_WEB_KEYBOARD_MIN_INSET = 120;

interface KeyboardHeightMessage {
  type: "keyboard-height-changed";
  height: number;
  isOpen: boolean;
}

function isKeyboardHeightMessage(data: unknown): data is KeyboardHeightMessage {
  if (typeof data !== "object" || data === null) return false;

  const message = data as Partial<KeyboardHeightMessage>;
  return (
    message.type === "keyboard-height-changed" &&
    typeof message.height === "number" &&
    Number.isFinite(message.height) &&
    message.height >= 0 &&
    typeof message.isOpen === "boolean"
  );
}

// ---------------------------------------------------------------------------
// iOS native keyboard accessory toolbar
// ---------------------------------------------------------------------------
// On iOS the formatting toolbar is a native `inputAccessoryView` (see
// apps/ios/App/App/KeyboardAccessoryView.swift) glued to the keyboard by UIKit,
// instead of the in-webview React {@link MobileKeyboardToolbar} (which Android
// and the web still use). The web side here only mirrors toolbar state to native
// and exposes an action dispatcher the native bar calls back into.

/** True when running inside the native iOS (Capacitor/WKWebView) shell. */
const IS_IOS_NATIVE =
  (
    window as { Capacitor?: { getPlatform?: () => string } }
  ).Capacitor?.getPlatform?.() === "ios";

/** Post a message to the native `KeyboardToolbar` WKScriptMessageHandler. No-op
 * off iOS / when the handler isn't registered. The native accessory consumes the
 * flat `items` (plus a compact `mathRow` in math context) and has no use for the
 * web-only `layout`. */
function postKeyboardToolbar(model: NativeMobileToolbarModel): void {
  (
    window as {
      webkit?: {
        messageHandlers?: {
          KeyboardToolbar?: { postMessage(m: unknown): void };
        };
      };
    }
  ).webkit?.messageHandlers?.KeyboardToolbar?.postMessage(model);
}

// The accessory enable flag (`postKeyboardAccessoryFocus`) lives in
// `mobileToolbarSuppression.ts`, shared with compact surfaces (TitleEditor)
// that disable the accessory while they hold focus.

/**
 * Public mount component. Keys the collaborative wrapper per page (or read-only
 * mode) so a page switch tears the doc + editor down and rebuilds them for the
 * new page — the `key` is how we recreate them, replacing the old in-effect
 * teardown/rebuild.
 */
export function MountedEditor(props: MountedEditorProps) {
  return (
    <CollaborativeEditor
      key={`${props.pageId}::${props.readonly ? "ro" : "rw"}`}
      {...props}
    />
  );
}

/**
 * Owns the page's shared {@link Doc} and all its collaboration/persistence via
 * {@link useCollaborativeDoc} — hoisted ABOVE the editor — then renders the body
 * {@link PageEditor} as a view over it. Keeping doc ownership a level up means the
 * editor (a child) is always torn down before the doc, and lets other surfaces
 * (a live title/preview) attach to the same doc with sync wired exactly once.
 */
function CollaborativeEditor(props: MountedEditorProps) {
  const collab = useCollaborativeDoc({
    pageId: props.pageId,
    spaceId: props.spaceId,
    snapshot: props.snapshot,
    readonly: props.readonly ?? false,
    onSyncStateChange: props.onSyncStateChange,
  });
  return <PageEditor {...props} collab={collab} />;
}

interface PageEditorProps extends MountedEditorProps {
  /** The shared doc + collaboration handles this editor is a view over. */
  collab: CollaborativeDoc;
}

/**
 * PageEditor — the full-page WYSIWYG editor: the app's core editing experience
 * over an entire document. It renders and edits the shared `Doc` (owned by
 * {@link useCollaborativeDoc} above it) through the shared {@link useEditorCore}
 * mount — the same core the compact {@link TitleEditor} uses — and owns the page
 * chrome: presence rendering, the mobile + native toolbars, context menu, find
 * bar, node/mark overlays, and cursor persistence.
 */
function PageEditor({
  collab,
  className = "",
  onContentChange,
  onContentUpdate,
  autoFocus = false,
  pageId,
  onAwarenessChange,
  onRestoreReady,
  onEditorReady,
  readonly = false,
  padding,
  blockStyleOverrides,
  placeholderOverrides,
  onScroll,
  onHorizontalPaddingChange,
}: PageEditorProps) {
  const { setOnOpenFind, fontStyle, editorWidth, density } = usePageSettings();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const { t } = useTranslation();
  const mountedRef = useRef<MountedEditorInstance | null>(null);
  // The shared doc is owned above us by useCollaborativeDoc; we're a view over it.
  const doc = collab.doc;
  const onScrollRef = useRef(onScroll);
  // Latest selected font family, read at mount time without making it a mount
  // dependency (changing it re-themes via setTheme below, not a full re-mount).
  const fontStyleRef = useRef(fontStyle);
  fontStyleRef.current = fontStyle;
  onScrollRef.current = onScroll;
  const onHorizontalPaddingChangeRef = useRef(onHorizontalPaddingChange);
  onHorizontalPaddingChangeRef.current = onHorizontalPaddingChange;
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

  // The matrix editor surface (dialog on desktop, drawer on touch): null while
  // closed, else the live dimensions of the grid the caret sits in. Both the
  // context menu's "Edit matrix" and the mobile toolbar's matrix button open it;
  // its steppers resize the grid in place, and the stored dimensions are refreshed
  // from the caret after each edit so the preview mirrors the real matrix.
  const [matrixEditor, setMatrixEditor] = useState<{
    rows: number;
    cols: number;
  } | null>(null);

  // Open the matrix editor from the current caret's grid, or no-op when the caret
  // is not in one. Shared by the toolbar action and the context-menu item.
  const openMatrixEditor = useCallback(() => {
    const editor = mountedRef.current?.editor;
    const ctx = editor ? matrixContextForCaret(editor) : null;
    if (ctx) setMatrixEditor({ rows: ctx.rows, cols: ctx.cols });
  }, []);

  // Resize the caret's grid, then re-read its dimensions so the surface reflects
  // the applied (and clamped) size.
  const handleMatrixResize = useCallback((rows: number, cols: number) => {
    const editor = mountedRef.current?.editor;
    if (!editor) return;
    applyMatrixResize(editor, rows, cols);
    const ctx = matrixContextForCaret(editor);
    setMatrixEditor(ctx ? { rows: ctx.rows, cols: ctx.cols } : { rows, cols });
  }, []);

  const closeMatrixEditor = useCallback(() => {
    setMatrixEditor(null);
    // Restore the caret on desktop; on touch this would re-raise the soft keyboard
    // right after dismissing the drawer, so leave focus where the drawer left it.
    if (!isTouchDevice()) mountedRef.current?.editor.focus();
  }, []);

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
    isMath: false,
    canOpenMathCommands: false,
    isStrikethrough: false,
    blockType: "paragraph" as MobileToolbarBlockType,
    listIndent: 0,
    todoChecked: false,
    math: null as MobileToolbarMathContext | null,
    linkActive: false,
    canCreateLink: false,
  });

  // The soft-keyboard inset (CSS px) the editor's viewport height is reduced by,
  // so the canvas — caret, bottom peer chrome — stays above the keyboard. Both
  // mobile WebViews now keep their FULL height when the keyboard opens (Android is
  // edge-to-edge; iOS runs Capacitor Keyboard `resize: "none"`), so the inset is
  // reported per platform: Android posts it from MainActivity; iOS derives it from
  // visualViewport (effect below). Zero on desktop and whenever the keyboard is
  // closed.
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  // Whether the soft keyboard is currently open; drives the mobile toolbar's
  // visibility. Owned per platform by the effects below.
  const [keyboardOpen, setKeyboardOpen] = useState(false);

  // Another surface (e.g. a focused TitleEditor — a plain input-like field with
  // no block formatting) can claim the keyboard and suppress this editor's
  // formatting toolbar; the keyboard-open signals above are keyboard-scoped,
  // not surface-scoped, so without this the body's bar rides a keyboard that
  // another editor raised (rename dialog, calendar draft sheet).
  const [toolbarSuppressed, setToolbarSuppressed] = useState(
    isFormattingToolbarSuppressed,
  );
  useEffect(
    () =>
      onFormattingToolbarSuppressionChange(() =>
        setToolbarSuppressed(isFormattingToolbarSuppressed()),
      ),
    [],
  );

  // Whether the soft keyboard is currently open. This — not editor focus — drives
  // the mobile toolbar so it rides the keyboard: it appears when
  // the keyboard opens and disappears the instant it closes, including external
  // dismissals (Android back button, iOS swipe-down) that leave the editor still
  // logically focused. The signal source differs per platform; see the effects
  // below. Once a native source reports, the visualViewport fallback is ignored.
  const hasNativeKeyboardRef = useRef(false);

  // Whether the editor surface currently holds focus. On plain web this gates the
  // visualViewport keyboard check so the editor's toolbar never reacts to a soft
  // keyboard raised by some unrelated input.
  const editorFocusedRef = useRef(false);
  // Re-run the web visualViewport keyboard check on demand. Focus arrives before
  // the keyboard finishes animating in, so a resize event may already be open by
  // the time we focus; calling this on focus re-evaluates the current viewport.
  const syncWebKeyboardRef = useRef<(() => void) | null>(null);

  // Native shells post the IME inset with both the height for positioning and an
  // isOpen flag so position and visibility stay in lockstep. Android: MainActivity
  // posts it (resize:"native" is a no-op on the edge-to-edge WebView). iOS:
  // TasferViewController posts it from UIKit's keyboard frame, because under
  // Capacitor Keyboard resize:"none" the WKWebView keeps its full height and
  // visualViewport never shrinks — so there is no viewport-derived signal there.
  useEffect(() => {
    const handleKeyboardHeight = (event: MessageEvent) => {
      if (event.source !== window || !isKeyboardHeightMessage(event.data)) {
        return;
      }

      hasNativeKeyboardRef.current = true;
      setKeyboardHeight(event.data.isOpen ? event.data.height : 0);
      // The IME inset and toolbar visibility stay in lockstep: the bar shows only
      // while the keyboard is open, and an external dismissal (back button) that
      // leaves the editor focused still hides it.
      setKeyboardOpen(event.data.isOpen);
    };

    window.addEventListener("message", handleKeyboardHeight);
    return () => window.removeEventListener("message", handleKeyboardHeight);
  }, []);

  // Web (mobile and desktop): the only reliable cross-browser signal that a soft
  // keyboard is actually on screen is visualViewport shrinking. Desktop browsers
  // never shrink it on focus — even touch-capable ones (touchscreen laptops,
  // device-emulation) that report `maxTouchPoints > 0` — so this is what keeps
  // the mobile toolbar off the desktop. Skipped on iOS native (its WebView resize
  // keeps the viewport full, so focus is the signal there) and once a native
  // source reports (Android), whose IME message takes precedence.
  useEffect(() => {
    if (IS_IOS_NATIVE) return;
    const vv = window.visualViewport;
    if (!vv) return;
    // Edge-to-edge Android Chrome under-reports the keyboard: with the IME open,
    // the visualViewport shrink (and the VirtualKeyboard API rect alike) is
    // short by exactly the gesture-nav bar, and `env(safe-area-inset-bottom)`
    // reads 0 at that same moment (measured on a Pixel 10 Pro: 946px IME inset,
    // 883px viewport shrink, 63px nav bar). The nav-bar height is observable
    // only while the keyboard is closed, so probe it then and fold the captured
    // value into the open inset. iOS Safari's shrink already spans the full
    // keyboard, hence the Android gate.
    const probe = document.createElement("div");
    probe.style.cssText =
      "position:fixed;top:0;left:0;visibility:hidden;pointer-events:none;" +
      "padding-bottom:var(--safe-area-inset-bottom,env(safe-area-inset-bottom,0px));";
    document.body.appendChild(probe);
    let closedSafeAreaBottom = 0;
    const sync = () => {
      if (hasNativeKeyboardRef.current) return;
      const inset = window.innerHeight - vv.height - vv.offsetTop;
      // inset <= 0 means no keyboard overlays the viewport at all — the only
      // state where the nav-bar inset is visible to CSS. Not `!open`: an IME
      // raised by a non-editor input keeps `open` false while already zeroing
      // the env value.
      if (inset <= 0) {
        closedSafeAreaBottom =
          parseFloat(getComputedStyle(probe).paddingBottom) || 0;
      }
      const open =
        editorFocusedRef.current && inset > MOBILE_WEB_KEYBOARD_MIN_INSET;
      setKeyboardOpen(open);
      // Browsers that overlay the keyboard on the layout viewport (iOS Safari,
      // edge-to-edge Android Chrome) leave `position: fixed` elements behind
      // it, so the toolbar and canvas must yield this inset, same as the
      // native-message path. Browsers that resize the layout viewport instead
      // report ~0 here and `bottom: 0` is already right. Rounded because
      // vv.height is fractional; the `open` gate keeps over-scroll
      // rubber-banding (negative insets) and desktop viewports at 0. Mirrors
      // useKeyboardInset's web fallback.
      setKeyboardHeight(
        open ? Math.round(inset + (isAndroid() ? closedSafeAreaBottom : 0)) : 0,
      );
    };
    sync();
    syncWebKeyboardRef.current = sync;
    vv.addEventListener("resize", sync);
    vv.addEventListener("scroll", sync);
    return () => {
      syncWebKeyboardRef.current = null;
      vv.removeEventListener("resize", sync);
      vv.removeEventListener("scroll", sync);
      probe.remove();
    };
  }, []);

  // iOS native keyboard height comes from the TasferViewController message
  // handled above, NOT visualViewport: under Capacitor Keyboard `resize: "none"`
  // (see capacitor.config) the WKWebView keeps its full height when the keyboard
  // opens and visualViewport never shrinks, so a viewport-derived inset would
  // read 0 (or a negative rubber-band value on scroll) and leave the canvas and
  // the bottom fixed overlays behind the keyboard. Deliberately NOT
  // resize:"native": that shrank the whole document on every keyboard toggle,
  // reflowing the app layout and repainting every viewport-sized canvas.
  // keyboardOpen is still driven by focus (above/below), and the native inset
  // message keeps it in lockstep with the actual keyboard.

  // Self-heal images that failed while offline. Connectivity is a platform
  // concern, so the `online` reset lives in the host: drop every parked failure
  // (the editor caps automatic retries, so a sustained outage parks them) and
  // force a repaint, which re-attempts each broken image's load from scratch.
  useEffect(() => {
    const handleOnline = () => {
      clearFailedImageCache();
      mountedRef.current?.editor.view.updateViewport({});
    };
    window.addEventListener("online", handleOnline);
    return () => window.removeEventListener("online", handleOnline);
  }, []);

  const dismissMobileKeyboard = useCallback(() => {
    setKeyboardHeight(0);
    mountedRef.current?.editor?.blur();

    // Dismissing the keyboard via a toolbar tap makes the browser dispatch a
    // synthetic "ghost" click ~300ms later. It lands on the editor canvas, which
    // the engine treats as a request to focus — re-opening the keyboard we just
    // dismissed. Swallow that single click in the capture phase before it can
    // reach the canvas's listener. This is a host keyboard concern, so it lives
    // here rather than inside the host-agnostic editor engine.
    let timer = 0;
    const cleanup = () => {
      window.removeEventListener("click", swallowGhostClick, true);
      window.clearTimeout(timer);
    };
    const swallowGhostClick = (event: MouseEvent) => {
      if ((event.target as HTMLElement | null)?.tagName === "CANVAS") {
        event.stopPropagation();
      }
      cleanup();
    };
    timer = window.setTimeout(cleanup, 700);
    window.addEventListener("click", swallowGhostClick, true);
  }, []);

  const handleMobileToolbarAction = useCallback(
    (action: MobileToolbarAction) => {
      const editor = mountedRef.current?.editor;
      if (!editor) return;

      switch (action.type) {
        case "undo":
          editor.undo();
          break;
        case "redo":
          editor.redo();
          break;
        case "toggle-bold":
          editor.change((change) => change.setMark("strong"));
          break;
        case "toggle-italic":
          editor.change((change) => change.setMark("emphasis"));
          break;
        case "toggle-code":
          editor.change((change) => change.setMark("code"));
          break;
        case "toggle-math":
          // With a selection the chosen text becomes the chip's LaTeX; with an
          // empty caret this arms a pending math format so the next typed text
          // forms the chip.
          editor.change((change) => change.setMark("math"));
          editor.focus();
          break;
        case "open-math-commands": {
          const tree = activeTreeMath(editor);
          if (tree) {
            editor.dispatch(TEXT_INPUT, {
              text: "\\",
              blockIndex: 0,
              textIndex: tree.sourceOffset,
            });
            editor.change((change) => change.insertText("\\"));
            editor.focus();
            break;
          }
          const range = editor.state.selection.range;
          if (
            !range ||
            typeof range !== "object" ||
            !("offset" in range) ||
            !editor.state.selection.empty
          ) {
            break;
          }

          const block = editor.query.block(range);
          const caretOffset = range.offset ?? 0;
          // Inserting `\` at either chip edge joins the chip via MathNode's
          // edge-join observer, so both edges open the menu.
          const insideInlineMath =
            block != null &&
            inlineMathChipAt(editor.query.marks, block.id, caretOffset) !==
              undefined;
          if (block?.type !== "math" && !insideInlineMath) break;

          // Match a typed backslash: notify command-menu observers before the
          // edit commits, then let the normal insertion pipeline update the
          // equation and trigger a subscription tick that opens the palette.
          editor.dispatch(TEXT_INPUT, {
            text: "\\",
            blockIndex: 0,
            textIndex: caretOffset,
          });
          editor.change((change) => change.insertText("\\"));
          editor.focus();
          break;
        }
        case "insert-math-command": {
          // Tapping a chip in the contextual math row. Mirror the `\` menu's
          // insert: when a `\command` is being typed, replace it; otherwise drop
          // the construct at the caret. Either way leave the caret in the first
          // `{}` slot. Works in both math contexts the row shows in: a block
          // equation, or an inline chip (its LaTeX lives in the block text, so
          // the offsets below are block-relative either way).
          const tree = activeTreeMath(editor);
          if (tree) {
            const insertion = mathCommandInsertion(
              action.latex,
              tree.source[tree.sourceOffset] ?? "",
            );
            editor.dispatch(INSERT_MATH_COMMAND, {
              text: insertion.text,
              caretOffset: insertion.caretOffset,
            });
            editor.focus();
            break;
          }
          const range = editor.state.selection.range;
          if (
            !range ||
            typeof range !== "object" ||
            !("offset" in range) ||
            !editor.state.selection.empty
          ) {
            break;
          }
          const block = editor.query.block(range);
          if (!block) break;
          const caretOffset = range.offset ?? 0;
          if (block.type === "math") {
            const insertion = mathCommandInsertion(
              action.latex,
              block.text[caretOffset] ?? "",
            );
            editor.dispatch(INSERT_MATH_COMMAND, {
              text: insertion.text,
              caretOffset: insertion.caretOffset,
            });
            editor.focus();
            break;
          }
          // The inline chip the caret rests in or abuts (either edge counts).
          // Display equations returned above through the structural action.
          const chip = inlineMathChipAt(
            editor.query.marks,
            block.id,
            caretOffset,
          );
          if (!chip) break;
          const active = activeBlockMathCommand(block.text, caretOffset);
          // The formula character right after the insertion point — the rest
          // of the block for an equation, but only up to the chip's end for
          // inline math (text past the chip is prose, which can't fuse with a
          // command). A letter there needs a separator space or committing
          // `\pi` in `a\pi|a` leaves the fused unknown `\pia`;
          // `mathCommandInsertion` appends it.
          const following =
            caretOffset < chip.to ? (block.text[caretOffset] ?? "") : "";
          const insertion = mathCommandInsertion(action.latex, following);
          editor.change((change) => {
            if (active) {
              change.insertText(insertion.text, {
                from: { block: block.id, offset: active.backslashIndex },
                to: { block: block.id, offset: caretOffset },
              });
            } else {
              change.insertText(insertion.text);
            }
            // Dropping a construct at a chip's edge (a single-char chip has no
            // interior caret stop, so the construct lands just outside the math
            // mark — raw LaTeX abutting the chip) leaves it unmarked. Re-mark the
            // chip's full grown extent so the construct joins it into one
            // formula. Idempotent for an interior drop already inside the mark.
            if (chip) {
              const delta = active
                ? insertion.text.length - (caretOffset - active.backslashIndex)
                : insertion.text.length;
              change.setMark("math", {
                active: true,
                range: {
                  from: { block: block.id, offset: chip.from },
                  to: { block: block.id, offset: chip.to + delta },
                },
              });
            }
            const caretBase = active ? active.backslashIndex : caretOffset;
            change.select({
              block: block.id,
              offset: caretBase + insertion.caretOffset,
            });
          });
          editor.focus();
          break;
        }
        case "toggle-strikethrough":
          editor.change((change) => change.setMark("strike"));
          break;
        case "set-block":
          editor.change((change) =>
            change.setBlock({ type: action.blockType as never }),
          );
          break;
        case "caret-left":
          // Pure caret step (the engine's left-arrow primitive). In math it snaps
          // over a whole construct and out to its edge — how you leave a `\dot`,
          // a script slot or a fraction when the soft keyboard has no arrow keys.
          editor.dispatch(MOVE_CURSOR_LEFT);
          editor.focus();
          break;
        case "caret-right":
          editor.dispatch(MOVE_CURSOR_RIGHT);
          editor.focus();
          break;
        case "indent-list":
          editor.dispatch(INDENT_LIST_ITEM);
          editor.focus();
          break;
        case "outdent-list":
          editor.dispatch(OUTDENT_LIST_ITEM);
          editor.focus();
          break;
        case "indent-code":
          // Indent the caret's line(s) in a code block (the soft-keyboard
          // counterpart to Tab). Line-based, like the list indent above.
          editor.dispatch(INDENT_CODE);
          editor.focus();
          break;
        case "outdent-code":
          editor.dispatch(OUTDENT_CODE);
          editor.focus();
          break;
        case "toggle-todo": {
          const block = editor.query.block();
          if (block?.type !== "todo_list") break;
          const checked = Boolean(block.attrs.checked);
          editor.change((change) =>
            change.setBlock({ checked: !checked }, { block: block.id }),
          );
          editor.focus();
          break;
        }
        case "edit-code": {
          // Open the code block's language picker as a drawer/sheet — the
          // in-webview counterpart to the floating language chip. Rendered on
          // mobile by the TasferCodeNode "code-language" overlay.
          const block = editor.query.block();
          if (block?.type !== "code") break;
          openCodeLanguageMenu(editor, block.id);
          break;
        }
        case "edit-link": {
          // The drawer's link control. Edit the link under the caret/selection
          // when one exists; otherwise turn the current text selection into a new
          // link. Mirrors the native accessory's link button
          // (handleFormatButtonClick). Rendered as a drawer on mobile by the
          // TasferLinkMark "link-edit" overlay.
          const link = editor.query.marks().find((m) => m.name === "link");
          if (link) {
            openLinkEditMenu(editor, {
              blockId: link.block,
              startIndex: link.from,
              endIndex: link.to,
              url: (link.attrs.url as string | undefined) ?? "",
              text: link.text,
              x: 0,
              y: 0,
            });
            break;
          }
          // Create from a non-empty text selection: the chosen text becomes the
          // link's text and the drawer collects the URL.
          const range = editor.state.selection.range;
          const selection =
            range && typeof range === "object" && "from" in range
              ? range
              : null;
          if (
            selection &&
            typeof selection.from === "object" &&
            typeof selection.to === "object"
          ) {
            const { from, to } = selection;
            const block = editor.query.block(from);
            if (block && block.type !== "image") {
              const startIndex = "offset" in from ? (from.offset ?? 0) : 0;
              const endIndex = "offset" in to ? (to.offset ?? 0) : 0;
              const selectedText = block.text.substring(startIndex, endIndex);
              openLinkEditMenu(editor, {
                blockId: block.id,
                startIndex,
                endIndex,
                url: "",
                text: "",
                selectedText,
                x: 0,
                y: 0,
              });
            }
          }
          break;
        }
        case "edit-image": {
          // Open the settings drawer for the selected image (replace/remove),
          // rendered on mobile by the TasferImageNode "image-upload" overlay.
          const block = editor.query.block();
          if (block?.type !== "image") break;
          openImageUploadMenu(editor, block.id, 0, 0);
          break;
        }
        case "open-matrix-editor":
          openMatrixEditor();
          break;
        case "dismiss":
          dismissMobileKeyboard();
          break;
      }
    },
    [dismissMobileKeyboard, openMatrixEditor],
  );

  useEffect(() => {
    if (!IS_IOS_NATIVE) return;
    const win = window as unknown as {
      __tasferKeyboardAction?: (action: MobileToolbarAction) => void;
    };
    win.__tasferKeyboardAction = handleMobileToolbarAction;
    return () => {
      delete win.__tasferKeyboardAction;
    };
  }, [handleMobileToolbarAction]);

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

  // Tracks remote peers' full presence (caret/selection + identity); the editor
  // renders decorations from this. We keep the whole presence (not just the user)
  // so a name collision among peers can re-derive every peer's cursor label, not
  // only the one that just updated. Fed by the awareness channel from the hook.
  const remotePresenceRef = useRef<Map<string, CursorPresence>>(new Map());

  // This tab's identity + color, read from the hook that owns the room. Held in a
  // ref so the presence handlers and awareness broadcast read the latest without
  // re-running the mount effect.
  const localUserRef = useRef(collab.localUser);
  localUserRef.current = collab.localUser;

  // ── Mount via the shared EditorCore ──────────────────────────────────────
  // The shared CRDT `doc` (owned by useCollaborativeDoc above us) is the single
  // source of truth; we pass it in so this surface is a view over it. useEditorCore
  // (wrapping `useEditor`) owns the editor lifecycle and mounts the canvas into
  // `containerRef`. The doc outlives the editor: as our parent, the hook tears the
  // doc down only after this child editor has unmounted.
  const { containerRef, editor } = useEditorCore({
    doc,
    schema: appSchema,
    editable: !readonly,
    pageId,
    padding,
    blockStyleOverrides,
    placeholderOverrides,
    // Shared strings, base theme (CSS `--editor-*` tokens + font registry + node
    // strings), and live dark-mode/font re-theming all come from useEditorCore.
    // The only body-specific bit is the selected serif/sans family, passed as a
    // theme override; it also updates live via the setTheme effect below.
    theme: { fontFamily: fontStyleToFamily(fontStyleRef.current) },
  });

  // Keep the off-screen peer indicators clear of the platform safe area (notch,
  // home indicator). Reading env(safe-area-inset-*) is a host concern; we feed
  // the measured pixels into the indicator's themeable insets so the engine
  // never needs to know what a safe area is. Re-applied on mount and whenever
  // the insets change (orientation, etc.).
  //
  // The TOP inset is deliberately NOT fed here: the app header (`.appHeader`)
  // already reserves `safe-area-inset-top` in its own height and sits above the
  // editor in flow, so the canvas top is already below the status bar/notch.
  // Passing safeArea.top would double-count it and push the top ("above")
  // indicator visibly down the viewport (most obvious on mobile). The bottom and
  // leading edges get their insets because the canvas does reach the screen
  // bottom (home indicator) and leading edge.
  const safeArea = useSafeAreaInsets();
  useEffect(() => {
    editor?.setTheme({
      styles: {
        remoteCursor: {
          outOfViewIndicator: {
            insetTop: 0,
            insetBottom: safeArea.bottom,
            insetInlineStart: safeArea.left,
          },
        },
      },
    });
  }, [editor, safeArea.bottom, safeArea.left]);

  // Push the selected editor width (wide/narrow page setting) into the live
  // editor as canvas padding. The canvas is headless (no CSS max-width), so a
  // "narrow" reading column is expressed as symmetric horizontal padding
  // computed from the measured canvas width, recomputed on resize. The width
  // control is desktop-only; on mobile this falls through to the engine's
  // default gutter. setTheme reflows text without a re-mount.
  useEffect(() => {
    const el = wrapperRef.current;
    if (!editor || !el) return;
    const apply = () => {
      const horizontal = horizontalPaddingForWidth(
        editorWidth,
        el.clientWidth,
        window.innerWidth > 768,
      );
      editor.setTheme({
        styles: {
          canvas: { paddingLeft: horizontal, paddingRight: horizontal },
        },
      });
      onHorizontalPaddingChangeRef.current?.(horizontal);
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(el);
    return () => observer.disconnect();
  }, [editor, editorWidth]);

  // Push the display-density scale (line-spacing multiplier page setting) into
  // the live editor. It scales the flow-text line heights and inter-block gaps;
  // setTheme deep-merges, so this rides alongside the font/width/token patches
  // and reflows text without a re-mount.
  useEffect(() => {
    if (!editor) return;
    editor.setTheme(editorThemeForDensity(density));
  }, [editor, density]);

  // The existing native iOS accessory and the Android React toolbar consume the
  // exact same model. Only transport and rendering differ.
  const lastNativeToolbarRef = useRef("");
  const mobileToolbarModel = useMemo(
    () =>
      createMobileToolbarModel(
        {
          // Selecting an image keeps the editor focused but may not raise the
          // soft keyboard, so also show the bar (with its image settings button)
          // whenever an image block is the selection. iOS ignores `visible` —
          // UIKit attaches the accessory only with the keyboard.
          visible:
            !readonly &&
            !toolbarSuppressed &&
            (keyboardOpen || mobileToolbar.blockType === "image"),
          bottomInset: keyboardHeight,
          ...mobileToolbar,
        },
        (key, fallback) => t(key, fallback ?? key),
      ),
    [
      keyboardHeight,
      keyboardOpen,
      mobileToolbar,
      readonly,
      t,
      toolbarSuppressed,
    ],
  );
  useEffect(() => {
    if (!IS_IOS_NATIVE) return;
    // The native accessory renders the flat `items` and ignores the in-webview
    // `layout` — except the math chip row, which it can't draw from `layout`'s
    // live SVG chips. So in math context we hand it a compact `mathRow` keyed to
    // the pre-rendered glyph assets; everywhere else `layout` is simply dropped.
    const { layout, ...rest } = mobileToolbarModel;
    const nativeModel: NativeMobileToolbarModel =
      layout.middle.kind === "math"
        ? {
            ...rest,
            mathRow: {
              query: layout.middle.query,
              chips: layout.middle.chips.map((chip) => ({
                asset: mathChipAssetName(chip.id),
                latex: chip.latex,
                name: chip.name,
              })),
              noMatchLabel: t(
                "editor.math.noConstructs",
                "No matching constructs",
              ),
            },
          }
        : rest;
    const serialized = JSON.stringify(nativeModel);
    if (serialized === lastNativeToolbarRef.current) return;
    lastNativeToolbarRef.current = serialized;
    postKeyboardToolbar(nativeModel);
  }, [mobileToolbarModel, t]);

  useEffect(() => {
    const offFocus = editor?.on("focus", () => {
      editorFocusedRef.current = true;
      if (IS_IOS_NATIVE) {
        // iOS native's WebView keeps the viewport full when the keyboard opens,
        // so focus is the keyboard signal. Enable the native accessory only while
        // the canvas surface holds focus, so other inputs don't inherit it.
        setKeyboardOpen(true);
        postKeyboardAccessoryFocus(true);
      } else {
        // Web/Android: re-evaluate visualViewport now that the editor is focused
        // (the keyboard may already be open). Android's native IME message, once
        // it reports, takes over via the precedence guard in the sync.
        syncWebKeyboardRef.current?.();
      }
    });
    const offBlur = editor?.on("blur", () => {
      editorFocusedRef.current = false;
      if (IS_IOS_NATIVE) {
        setKeyboardOpen(false);
        postKeyboardAccessoryFocus(false);
      } else if (!hasNativeKeyboardRef.current) {
        // Native IME messages own visibility once they report; otherwise losing
        // focus dismisses the keyboard, so hide the toolbar with it.
        setKeyboardOpen(false);
      }
    });
    return () => {
      offFocus?.();
      offBlur?.();
      // The editor is going away; never leave the accessory enabled for whatever
      // input gains focus next (e.g. on another page with no editor mounted).
      if (IS_IOS_NATIVE) postKeyboardAccessoryFocus(false);
    };
  }, [editor]);
  // Bridge the hook's TasferEditor into the MountedEditorInstance shape the
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

  // Expose the live editor handle to host debug chrome (DevToolbar's Editor
  // tab). Read the callback through a ref so a changed callback identity doesn't
  // re-run the register/unregister cycle — only the editor's mount/unmount does.
  const onEditorReadyRef = useRef(onEditorReady);
  onEditorReadyRef.current = onEditorReady;
  useEffect(() => {
    if (!editor) return;
    onEditorReadyRef.current?.(editor);
    return () => onEditorReadyRef.current?.(null);
  }, [editor]);

  // Persist cursor position on unmount, while the editor is still alive. As a
  // layout-effect cleanup declared after the editor mount, it runs in the commit
  // phase before useEditor's own layout cleanup destroys the editor — so
  // editor.state / view still return live data here. (The doc's lifetime and the
  // HMR live-blocks stash are owned by useCollaborativeDoc, a level up.)
  //
  // Unmount alone is not enough: a full page reload/close tears the page down
  // without running React cleanups, so we also persist on pagehide and on
  // visibilitychange→hidden (the pair sync-lifecycle uses — mobile WebViews can
  // kill a hidden page without ever firing pagehide).
  useLayoutEffect(() => {
    if (readonly) return;
    const persistCursor = () => {
      const editorApi = mountedRef.current?.editor;
      if (!editorApi) return;
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
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") persistCursor();
    };
    window.addEventListener("pagehide", persistCursor);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("pagehide", persistCursor);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      persistCursor();
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

    // Route copy/cut/paste through the native clipboard bridge. `navigator.clipboard`
    // read/write is gated behind a transient user activation that a programmatic
    // clipboard op can't satisfy — notably a context-menu "Paste", whose action
    // runs in the native menu's resolution callback with no live gesture — so it
    // silently fails inside the WebView. The bridge talks to the platform clipboard
    // directly. It is text-only, so we stash the last copy's rich payload and return
    // its html on a read whose clipboard text still matches: in-app round-trips stay
    // lossless (bold/links survive) while external apps receive plain text.
    if (native) {
      // `setClipboard` is engine-internal wiring (EditorWiring), off the public
      // EditorApi the handle is typed as — reach it through the concrete class.
      const wiring = mounted.editor as unknown as EditorWiring;
      let lastCopy: { plainText: string; html: string } | null = null;
      wiring.setClipboard({
        async write(payload) {
          lastCopy = { plainText: payload.plainText, html: payload.html };
          await native.clipboard.copy(payload.plainText);
        },
        async read() {
          const text = await native.clipboard.paste();
          if (text && lastCopy && text === lastCopy.plainText) {
            return { text, html: lastCopy.html };
          }
          return { text };
        },
      });
    }

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
      mounted.editor.registerAction(DRAG_DETENT, () => fireHaptic("light")),
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
          const vx = rect.left + x;
          const vy = rect.top + y;

          // Native path: present a platform menu instead of the Radix popover.
          // iOS/Android go through the unified bridge; desktop (Electron) routes
          // over its IPC bridge. Plain web has no presenter and falls through to
          // the popover below. We build the same host items, ship a serializable
          // model, then run the chosen item's action. `CLOSE_CONTEXT_MENU` (via
          // finally) clears the engine's host-capture flag whether or not an
          // item was picked.
          const presentNativeMenu = getNativeContextMenuPresenter();
          if (presentNativeMenu) {
            const { model, actions } = toNativeMenu(
              getContextMenuItemsRef.current(hasSelection),
            );
            void presentNativeMenu({
              model,
              anchor: { x: vx, y: vy, width: 1, height: 1 },
            })
              .then((chosenId) => {
                if (chosenId) actions.get(chosenId)?.();
              })
              .catch(() => {
                // A presenter failure must not strand the engine in capture
                // mode; the finally below still dispatches CLOSE_CONTEXT_MENU.
              })
              .finally(() => {
                mounted.editor.dispatch(CLOSE_CONTEXT_MENU);
              });
            return true;
          }

          setMenu({
            x: vx,
            y: vy,
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

    // Pre-rasterize native-menu icons for the current theme so the first
    // long-press / right-click already shows them (native hosts only; a no-op
    // cost on plain web since the menu is never requested natively there).
    prewarmMenuIcons();

    // Re-pushing the editor theme on dark-mode and font-registry changes is now
    // owned by useEditorCore (useLiveEditorTheme), shared with every surface.
    // The only theme-linked concern left here is host-specific: re-rasterize the
    // native context-menu icons in the new color when the root class flips.
    const menuIconThemeObserver = new MutationObserver(() => {
      prewarmMenuIcons();
    });
    menuIconThemeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
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

    // Reproduce vaul's native scroll-container behaviour for the canvas editor,
    // which scrolls itself and so exposes no `scrollTop` for vaul to read. When
    // the editor is at the top we leave the surface draggable so a downward drag
    // still closes the drawer; once scrolled we set `data-vaul-no-drag` so the
    // swipe scrolls the canvas instead of dragging the drawer. (vaul caches its
    // decision per gesture, so a drag that starts mid-document keeps scrolling
    // even after it reaches the top — matching a real scroll container.) Inert
    // outside a drawer; only written when the at-top state actually flips.
    const syncDrawerDragGuard = (scrollY: number) => {
      const el = wrapperRef.current;
      if (!el) return;
      const suppressDrag = scrollY > 0;
      if (el.hasAttribute("data-vaul-no-drag") !== suppressDrag) {
        el.toggleAttribute("data-vaul-no-drag", suppressDrag);
      }
    };

    // Observe scroll position (a node could claim SCROLL to override page
    // scrolling; the host just tracks the offset to position floating UI).
    mounted.editor.registerAction(SCROLL, ({ scrollY }) => {
      onScrollRef.current?.(scrollY);
      syncDrawerDragGuard(scrollY);
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
        menuIconThemeObserver.disconnect();
        // The editor (useEditor) and the doc (our cleanup effects) are torn
        // down separately; here we only undo this effect's own wiring.
        if (mountedRef.current === mounted) {
          mountedRef.current = null;
        }
      };
    }

    // Ops sync + persistence (broadcast, apply-remote, ops load, FS snapshot) are
    // owned by useCollaborativeDoc above us — the doc fans local edits out to peers
    // + SQLite + the snapshot, and applies remote ops, all without the editor. Here
    // we wire only the editor-scoped half: revealing the canvas, restore, and
    // presence (rendering peers' cursors + publishing our own).

    // Reveal the canvas once the hook confirms persisted ops have loaded (the VV is
    // accurate). If the snapshot already had content we revealed above.
    collab.opsLoaded.then(() => {
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

    // Publish our cursor/selection to the room whenever it moves. The editor
    // doesn't own awareness — it emits "selectionchange"; we convert the live
    // selection to this app's awareness wire shape and broadcast it through the
    // hook's channel. Guard: don't broadcast before P2P identity loads (localUser
    // starts as { peerId: "", color: "" }).
    const publishLocalAwareness = () => {
      if (!localUserRef.current.peerId) return;
      collab.awareness.broadcast(
        selectionToCursorPresence(
          mounted.editor.state.selection.range,
          localUserRef.current,
        ),
      );
    };

    // Caret label for a nameless peer: "You" when it's the local user's own
    // other tab (same device), otherwise a neutral "Anonymous".
    const presenceNameFallback = (state: CursorPresence) =>
      isSamePerson(state.user, localUserRef.current.deviceId)
        ? i18next.t("collaboration.you", "You")
        : i18next.t("collaboration.anonymous", "Anonymous");

    // Re-render every remote peer's cursor from the tracked presence. A peer's
    // label depends on the whole set (a device hint is appended only when another
    // connected peer shares its name), so any join/leave/update recomputes all of
    // them — not just the peer that changed.
    const refreshPresenceDecorations = () => {
      const entries = [...remotePresenceRef.current.entries()];
      const names = entries.map(([, state]) =>
        getDisplayName(state.user, presenceNameFallback(state)),
      );
      const colliding = collidingDisplayNames(names);
      entries.forEach(([peerId, state], i) => {
        // Only mark the device when another peer shares this name — the glyph's
        // only job is to tell same-named collaborators apart.
        const icon = isCollidingName(names[i], colliding)
          ? deviceIcon(state.user.deviceType)
          : undefined;
        mounted.editor.view.setDecorations(
          presenceLayer(peerId),
          cursorPresenceToDecorations(
            peerId,
            state,
            presenceNameFallback(state),
            icon,
          ),
        );
      });
      onAwarenessChange?.(entries.map(([, state]) => state.user));
    };

    // Connect this (primary) surface to the hook's awareness transport: render
    // incoming peer presence as cursors, and re-publish ours when a peer joins or
    // we (re)join a populated room so they see our cursor.
    const disconnectAwareness = collab.awareness.connect({
      onUpdate: (awarenessPeerId, state) => {
        if (state) {
          remotePresenceRef.current.set(awarenessPeerId, state);
        } else {
          mounted.editor.view.clearDecorations(presenceLayer(awarenessPeerId));
          remotePresenceRef.current.delete(awarenessPeerId);
        }
        refreshPresenceDecorations();
      },
      onStates: (states) => {
        for (const [awarenessPeerId, state] of Object.entries(states)) {
          remotePresenceRef.current.set(awarenessPeerId, state);
        }
        refreshPresenceDecorations();
      },
      onPeerJoined: () => publishLocalAwareness(),
      onRejoin: () => publishLocalAwareness(),
    });

    const offSelectionChange = mounted.editor.on(
      "selectionchange",
      publishLocalAwareness,
    );
    // Typing moves the caret too, but the engine classifies that as a "change"
    // (content) event — "selectionchange" fires only for caret/selection moves
    // with no content change. Without also publishing on "change", a peer's
    // cursor freezes while they type and only jumps on their next click or
    // selection. publishLocalAwareness ignores the ChangeTransaction arg and
    // re-reads the live selection, so it works for both local and remote edits
    // (a remote insert before our caret shifts our offset, which peers must see).
    const offChangeAwareness = mounted.editor.on(
      "change",
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
        // drawer on mobile by the TasferImageNode "image-upload" overlay.
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
        // TasferLinkMark "link-edit" overlay.

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
        mounted.editor.focus();
        mounted.editor.setCaret("start", { onlyIfUnset: true });
      },
      onFormatButtonClick: handleFormatButtonClick,
      toggleStrong: () => mounted.editor.change((c) => c.setMark("strong")),
      toggleEmphasis: () => mounted.editor.change((c) => c.setMark("emphasis")),
      toggleCode: () => mounted.editor.change((c) => c.setMark("code")),
      toggleStrike: () => mounted.editor.change((c) => c.setMark("strike")),
    };

    window.TasferEditorCallbacks = editorMethods;

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
        // Hand the host a persistable snapshot: `onContentChange` is wired to the
        // debounced FS save, which crosses the platform's structured-clone
        // boundary, so the transient render cache must be stripped first (see
        // `saveSnapshot`).
        onContentChangeRef.current?.(cleanSnapshotForSave(doc.getRawBlocks()));
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

      // An existing link under the caret/selection drives the contextual link
      // settings button in the mobile bar / iOS accessory (it opens the link
      // settings drawer). The image settings button is driven by the block type
      // ("image") directly, so it needs no separate flag here.
      const linkActive = mounted.editor.query
        .marks()
        .some((m) => m.name === "link");

      // Mobile toolbar — entirely from the snapshot/query. `activeMarks` is the
      // selection-aware (intersection across the span + pending caret toggles)
      // mark set, so it replaces the old per-char format scan.
      const activeBlock = mounted.editor.query.block();
      const treeMath = activeTreeMath(mounted.editor);
      const rawBlockType = activeBlock?.type ?? "paragraph";
      const blockType = toolbarBlockTypeFromQueryBlock(activeBlock);
      const selectionRange = snapshot.selection.range;
      const caretOffset =
        treeMath?.sourceOffset ??
        (selectionRange &&
        typeof selectionRange === "object" &&
        "offset" in selectionRange
          ? (selectionRange.offset ?? 0)
          : null);
      const inlineMathChip =
        caretOffset !== null && activeBlock != null
          ? inlineMathChipAt(
              mounted.editor.query.marks,
              activeBlock.id,
              caretOffset,
            )
          : undefined;
      const insideInlineMath = inlineMathChip !== undefined;
      const canOpenMathCommands =
        (snapshot.selection.empty || treeMath !== null) &&
        (rawBlockType === "math" || insideInlineMath);

      // Contextual math row. Present whenever the caret rests in math — a block
      // equation or an inline chip (including its start edge, the only caret
      // stop a single-char chip has) — so it supersedes the touch `\` drawer in
      // both. On the tree path the in-progress `\command` is read from the
      // raw-text field at the caret (the projected source is not a faithful
      // echo of what was typed — a pending lone `\` projects as `\backslash`);
      // a flat chip's LaTeX lives literally in the block text. `query` is the
      // in-progress `\command`, or null while browsing.
      let math: MobileToolbarMathContext | null = null;
      if (
        (snapshot.selection.empty || treeMath !== null) &&
        (rawBlockType === "math" || insideInlineMath) &&
        caretOffset !== null
      ) {
        const mathText =
          treeMath?.source ?? mounted.editor.query.block()?.text ?? "";
        const active = treeMath
          ? treeMathCommandRun(treeMath)
          : activeBlockMathCommand(mathText, caretOffset);
        // Edge detection runs on the math *source* the caret sits in: a block
        // equation is the whole block text; an inline chip is its own LaTeX at a
        // chip-local offset. A step with no further caret stop in that direction
        // would leave the formula, so we disable the matching caret control
        // rather than let it silently exit the math.
        const edgeLatex = inlineMathChip ? inlineMathChip.text : mathText;
        const edgeOffset = inlineMathChip
          ? caretOffset - inlineMathChip.from
          : caretOffset;
        // The grid the caret rests in (if any). `matrixContextForCaret` covers
        // every selection shape the desktop context menu resolves — a caret in
        // a cell, a whole-construct selection, a sweep across the parentheses —
        // so the grid controls stay available while the matrix is selected.
        math = {
          query: active ? active.query : null,
          canCaretLeft: !mathSourceAtEdge(edgeLatex, edgeOffset, "left"),
          canCaretRight: !mathSourceAtEdge(edgeLatex, edgeOffset, "right"),
          matrix: matrixContextForCaret(mounted.editor),
        };
      }

      // Structural context for the list/code contextual rows. The fields are
      // read off the current block; they default to inert values off-context so
      // the layout builder simply falls back to the formatting row.
      const contextAttrs = (activeBlock?.attrs ?? {}) as Readonly<
        Record<string, unknown>
      >;
      const listIndent =
        typeof contextAttrs.indent === "number" ? contextAttrs.indent : 0;
      const todoChecked =
        rawBlockType === "todo_list" && Boolean(contextAttrs.checked);

      // A non-empty text selection in a textual block can be turned into a link;
      // this enables the drawer's link control even when no link exists yet.
      const canCreateLink =
        !snapshot.selection.empty &&
        activeBlock != null &&
        activeBlock.type !== "image";

      setMobileToolbar({
        canUndo: snapshot.canUndo,
        canRedo: snapshot.canRedo,
        isBold: snapshot.activeMarks.has("strong"),
        isItalic: snapshot.activeMarks.has("emphasis"),
        isCode: snapshot.activeMarks.has("code"),
        isMath: snapshot.activeMarks.has("math"),
        canOpenMathCommands,
        isStrikethrough: snapshot.activeMarks.has("strike"),
        blockType,
        listIndent,
        todoChecked,
        math,
        linkActive,
        canCreateLink,
      });
    });

    // Auto-focus the editor when requested
    if (autoFocus) {
      mounted.editor.focus();

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
    // do not flash at the top of an already-scrolled document on first paint,
    // and seed the drawer drag guard so a restored mid-document scroll doesn't
    // start out closable.
    const initialScrollY = mounted.editor.view.getScrollY();
    onScrollRef.current?.(initialScrollY);
    syncDrawerDragGuard(initialScrollY);

    return () => {
      offContent();
      offUi();
      disposeActions();
      offSelectionChange();
      offChangeAwareness();
      disconnectAwareness();
      menuIconThemeObserver.disconnect();

      // The editor (useEditor) is destroyed in the commit phase; the doc + its
      // sync/persistence are owned and torn down by useCollaborativeDoc a level
      // up; the cursor is saved by the layout-effect above (while the editor is
      // still alive). Here we only undo this effect's own wiring.
      delete window.TasferEditorCallbacks;
      if (mountedRef.current === mounted) {
        mountedRef.current = null;
      }
    };
    // Runs once when the editor becomes available. The surface is remounted per
    // page (keyed wrapper), so pageId/readonly/snapshot are constant here, and
    // the awareness channel is stable — all captured once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  // Re-publish our awareness when localUser becomes available, so connected
  // peers overwrite any stale entry they stored before our identity finished
  // loading (color: ""). The ongoing broadcast is driven by the editor's
  // "selectionchange" + "change" subscriptions wired in the mount effect above.
  const localUser = collab.localUser;
  const broadcastAwareness = collab.awareness.broadcast;
  useEffect(() => {
    if (mountedRef.current && localUser.peerId) {
      broadcastAwareness(
        selectionToCursorPresence(
          mountedRef.current.editor.state.selection.range,
          localUser,
        ),
      );
    }
  }, [localUser, broadcastAwareness]);

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

    mountedRef.current?.editor.focus();
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

  const getContextMenuItems = (
    hasSelectionOverride?: boolean,
  ): ContextMenuItem[] => {
    const hasSelection =
      hasSelectionOverride ?? contextMenuState?.hasSelection ?? false;

    // When the cursor sits on an image block we can copy the image bytes
    // themselves. The async clipboard write API is unavailable in some WebViews
    // (and the native bridge clipboard is text-only), so only treat this as a
    // copyable image where the write can actually succeed.
    const block = mountedRef.current?.editor.query.block();
    const imageUrl =
      block?.type === "image" && block.attrs.url
        ? (block.attrs.url as string)
        : null;
    const imageAlt =
      block?.type === "image"
        ? (block.attrs.alt as string | undefined)
        : undefined;
    const canCopyImage =
      imageUrl !== null &&
      typeof ClipboardItem !== "undefined" &&
      typeof navigator.clipboard?.write === "function";

    const items: ContextMenuItem[] = [
      {
        id: "selectAll",
        label: t("contextMenu.selectAll", "Select All"),
        icon: <Type size={16} />,
        action: () => handleContextMenuAction("selectAll"),
      },
      // A single "Copy" entry: on an image block it copies the image and shows
      // the image icon; otherwise it copies the current text selection.
      canCopyImage
        ? {
            id: "copyImage",
            label: t("contextMenu.copyImage", "Copy image"),
            icon: <ImageIcon size={16} />,
            action: () => {
              void copyImageToClipboard(imageUrl!);
            },
          }
        : {
            id: "copy",
            label: t("contextMenu.copy", "Copy"),
            icon: <Copy size={16} />,
            action: () => handleContextMenuAction("copy"),
            disabled: !hasSelection,
          },
    ];

    // Hide edit-related items in readonly mode
    if (!readonly) {
      // On an image block, Cut copies the image bytes then removes the block;
      // otherwise it cuts the current text selection.
      items.push(
        canCopyImage
          ? {
              id: "cut",
              label: t("contextMenu.cut", "Cut"),
              icon: <Scissors size={16} />,
              action: () => {
                // Only remove the block once the image is safely on the
                // clipboard — a failed copy must not destroy the image.
                void copyImageToClipboard(imageUrl!).then(() => {
                  mountedRef.current?.editor.change((c) =>
                    c.deleteBlock({ block: block!.id }),
                  );
                });
              },
            }
          : {
              id: "cut",
              label: t("contextMenu.cut", "Cut"),
              icon: <Scissors size={16} />,
              action: () => handleContextMenuAction("cut"),
              disabled: !hasSelection,
            },
      );

      // Paste reads the system clipboard through `editor.paste`. On the web that
      // is `navigator.clipboard`, gated by the browser: Chromium/Safari
      // prompt-then-allow on this click gesture, Firefox restricts it for pages
      // (the action no-ops gracefully). Native shells instead read via the
      // clipboard bridge wired in the mount effect — `navigator.clipboard` can't
      // run from the native menu's async callback, which has no user activation.
      items.push({
        id: "paste",
        label: t("contextMenu.paste", "Paste"),
        icon: <Clipboard size={16} />,
        action: () => handleContextMenuAction("paste"),
      });
    }

    // Add Download item when cursor is on an image block with a url. (Copying
    // the image is folded into the "Copy" entry above.)
    if (imageUrl) {
      items.push({
        id: "downloadImage",
        label: t("contextMenu.downloadImage", "Download image"),
        icon: <Download size={16} />,
        action: () => {
          void downloadImage(imageUrl, imageAlt);
        },
      });
    }

    // "Edit matrix" when the caret sits in a grid construct. Unlike Format this
    // doesn't require a selection — a bare caret in a cell is the primary case —
    // and it opens the same row/column editor the mobile toolbar's matrix button
    // does (a dialog here on desktop, a drawer on touch).
    const matrixMenuCtx =
      !readonly && mountedRef.current
        ? matrixContextForCaret(mountedRef.current.editor)
        : null;
    if (matrixMenuCtx) {
      items.push({
        id: "matrix",
        label: t("editor.math.matrix.title", "Edit matrix"),
        icon: <Grid3x3 size={16} />,
        action: () => openMatrixEditor(),
      });
    }

    // Add Format submenu for desktop when text is selected (not in readonly
    // mode). Blocks that can't carry inline marks — math and code, per the block
    // registry's `hasFormats: false` — never offer formatting, matching the
    // mobile toolbar, which drops the mark buttons in those contexts.
    // The marks active across the selection (the canonical "all chars carry it"
    // reading, with explicit/caret-inherited formats folded in).
    const marks = mountedRef.current?.editor.state.activeMarks;
    const blockAllowsFormats = block ? canHaveFormats(block.type) : true;
    // A selection whose every character carries the math mark is an inline-math
    // run; formatting doesn't apply there either, mirroring the mobile toolbar.
    const selectionIsInlineMath = marks?.has("math") ?? false;
    if (
      hasSelection &&
      !isTouchDevice() &&
      !readonly &&
      blockAllowsFormats &&
      !selectionIsInlineMath
    ) {
      const isBold = marks?.has("strong") ?? false;
      const isItalic = marks?.has("emphasis") ?? false;
      const isCode = marks?.has("code") ?? false;
      const isStrikethrough = marks?.has("strike") ?? false;
      const isMath = marks?.has("math") ?? false;

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
            id: "format-math",
            label: t("contextMenu.math", "Math"),
            icon: <Sigma size={16} />,
            // A togglable mark: over a selection this wraps it as an inline
            // math chip (the chip's visible chars are its LaTeX), mirroring the
            // mobile toolbar's "toggle-math".
            action: () =>
              mountedRef.current?.editor.change((c) => c.setMark("math")),
            active: isMath,
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
              // the TasferLinkMark "link-edit" overlay.
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

  // The OPEN_CONTEXT_MENU handler is registered once at mount, so it can't close
  // over the per-render `getContextMenuItems` (that would read stale `readonly`,
  // `t`, etc.). Keep a ref pointing at the latest builder for the native path.
  const getContextMenuItemsRef = useRef(getContextMenuItems);
  getContextMenuItemsRef.current = getContextMenuItems;

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
      // `data-vaul-no-drag` is toggled on this element by scroll position (see
      // the SCROLL handler): absent at the top so a downward drag closes a host
      // drawer, present once scrolled so the swipe scrolls the canvas instead.
      className={cn(
        "relative w-full h-full overflow-hidden focus:outline-none",
        className,
      )}
      // Cap the canvas above the mobile toolbar and the Android IME inset. The
      // toolbar publishes its live full height (persistent bar + any open drawer
      // panel) as `--keyboard-toolbar-height` while mounted, 0px otherwise — so
      // this shrinks the canvas by the real toolbar height, growing when the
      // drawer opens. Keeping `viewport.height` accurate is what lets the engine
      // pin bottom chrome (out-of-view peer indicators, the caret) above the
      // toolbar instead of behind it. Both terms collapse to 0 when the keyboard
      // and toolbar are gone, leaving the plain `h-full` height.
      style={{
        height: `max(100px, calc(100% - ${keyboardHeight}px - var(--keyboard-toolbar-height, 0px)))`,
      }}
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
            disabled={isTouchDevice()}
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
          registry below (TasferLinkMark.overlays → "link-tooltip" /
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
              // Marks this layer as host-rendered editor chrome. The engine's
              // canvas `mouseleave` handler reads the event's relatedTarget and,
              // when the pointer is crossing onto an element inside this layer
              // (e.g. the image hover toolbar's buttons), keeps the backing hover
              // state alive instead of tearing the overlay down mid-traversal.
              data-editor-overlay=""
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
          registry above (TasferImageNode.overlays → "image-upload" /
          "image-hover"). The suspended-mode signal is the `modalPopoverOpen`
          mirror, derived from the engine's active menu. */}

      {/* Inline math is edited in place on the canvas — the chip itself renders
          large enough to read/edit (see MathMark's INLINE_MATH_SCALE), so there
          is no separate mirror popover. */}

      {/* Image hover buttons + native image drawer render via the
          node-overlay registry above (TasferImageNode.overlays → "image-hover"
          / "image-upload"). The native link drawer renders via the mark-overlay
          registry (TasferLinkMark → "link-edit"). */}

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

      {/* Matrix editor — grid preview + row/column steppers. Opened by the
          context-menu "Edit matrix" and the mobile toolbar's matrix button;
          renders as a modal dialog on desktop and a bottom drawer on touch. */}
      {matrixEditor && (
        <MatrixEditor
          open={true}
          rows={matrixEditor.rows}
          cols={matrixEditor.cols}
          onResize={handleMatrixResize}
          onClose={closeMatrixEditor}
        />
      )}

      {/* Rides the soft keyboard: shown while it is open, gone the instant it
          closes (incl. external dismissals), regardless of editor focus.
          Android uses the reported IME inset; iOS resizes the native WebView.
          On iOS this is replaced by the native inputAccessoryView toolbar, so the
          React bar renders on Android/web only. */}
      {mobileToolbarModel.visible && isTouchDevice() && !IS_IOS_NATIVE && (
        <MobileKeyboardToolbar
          model={mobileToolbarModel}
          onAction={handleMobileToolbarAction}
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
