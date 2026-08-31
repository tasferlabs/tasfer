import { useDraggable } from "@dnd-kit/core";
import { useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  type IListPage,
  useCreatePage,
  useDeletePage,
  useUpdatePage,
  useGetPages,
} from "../../api/pages.api";
import { useConfirmation } from "../../components/ConfirmationDialog";
import { useImportDialog } from "../../components/ImportDialogProvider";
import { MovePageDialog } from "../../components/MovePageDialog";
import { RenameDialog } from "../../components/RenameDialog";
import { TitlePreview } from "../../TitlePreview";
import Icons from "../../components/uiKit/Icons/Icons";
import VisuallyHidden from "../../components/uiKit/VisuallyHidden/VisuallyHidden";
import { Button } from "../../../components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "../../../components/ui/dropdown-menu";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "../../../components/ui/drawer";
import {
  Archive,
  Download,
  Ellipsis,
  FolderInput,
  LoaderCircle,
} from "lucide-react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { DropZone } from "./DropZone";
import { PagesArea } from "./PagesArea";
import { SUBTREE_EASE, SUBTREE_MOTION_MS } from "./subtreeMotion";
import { type IParentsStack } from "./PagesLinks";
import style from "./PagesLinks.module.css";
import useResponsive from "@/app/hooks/useResponsive";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useIsExpanded, useTreeExpand } from "../../contexts/TreeExpandContext";
import {
  selectionRoots,
  useIsPageSelected,
  usePageSelection,
  usePageSelectionRow,
  type SelectedPage,
} from "../../contexts/PageSelectionContext";
import { isApplePlatform } from "@tasfer/editor";

const PRESET_COLORS = [
  "#EF4444",
  "#F97316",
  "#F59E0B",
  "#EAB308",
  "#84CC16",
  "#22C55E",
  "#14B8A6",
  "#06B6D4",
  "#3B82F6",
  "#6366F1",
  "#8B5CF6",
  "#A855F7",
  "#D946EF",
  "#EC4899",
  "#F43F5E",
];

/** One colour swatch in the page colour grid. */
const swatchClass =
  "w-full aspect-square rounded-lg border-2 transition-transform hover:scale-110";

/** Rows of the page context menu. The size override keeps the 18px icons. */
const menuItemClass =
  "w-full justify-start gap-3 rounded-md px-3 py-2.5 text-start text-sm font-normal hover:bg-accent [&_svg:not([class*='size-'])]:size-[18px]";

// Global flag to track recent drag - module level to avoid React timing issues
let recentDragEnd = false;
export function setRecentDragEnd() {
  recentDragEnd = true;
  setTimeout(() => {
    recentDragEnd = false;
  }, 100);
}

/**
 * Whether a click is asking to change the selection rather than open the page.
 * macOS reserves Ctrl-click for the context menu, so the additive modifier is
 * Cmd there and Ctrl everywhere else; Shift extends a range on both.
 */
function isMultiSelectClick(e: {
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
}) {
  if (e.shiftKey) return true;
  return isApplePlatform() ? e.metaKey : e.ctrlKey;
}

export function PageLink({
  data,
  spaceId,
  parentsStack = [],
  color,
}: {
  data: IListPage;
  spaceId?: string;
  parentsStack?: IParentsStack;
  color?: string | null;
}) {
  const { t } = useTranslation();
  const isCoarse = useResponsive("(pointer: coarse)");
  const queryClient = useQueryClient();

  const { getConfirmation } = useConfirmation();
  const { openImport } = useImportDialog();
  const navigate = useNavigate();
  const { id: currentPageId } = useParams<{ id: string }>();
  const wasDraggingRef = useRef(false);
  const [showRenameDialog, setShowRenameDialog] = useState(false);
  const [showMoveDialog, setShowMoveDialog] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [contextPos, setContextPos] = useState<{ x: number; y: number } | null>(
    null,
  );
  const treeExpand = useTreeExpand();
  const isExpanded = useIsExpanded(data.id);
  const selection = usePageSelection();
  const isSelected = useIsPageSelected(data.id);
  usePageSelectionRow({ page: data, spaceId, parentsStack });
  // The selection this row's menu acts on, frozen when the menu opens. A menu
  // is a still moment, so freezing keeps every label and every action in it
  // agreeing on one list. Fewer than two rows means the plain single-page menu.
  const [menuBatch, setMenuBatch] = useState<SelectedPage[]>([]);
  const batchCount = menuBatch.length;
  const isBatch = batchCount > 1;

  /**
   * The pages the menu's actions run on. Descendants of another selected page
   * are dropped: archiving or moving the ancestor already takes them.
   */
  const menuTargets: SelectedPage[] = isBatch
    ? selectionRoots(menuBatch)
    : [{ page: data, spaceId, parentsStack }];

  /** Snapshot what is selected as the menu opens. */
  const captureMenuBatch = useCallback(() => {
    const selected = selection.has(data.id) ? selection.getSelection() : [];
    setMenuBatch(selected.length > 1 ? selected : []);
  }, [selection, data.id]);
  const reduceMotion = useReducedMotion();
  const setIsExpanded = useCallback(
    (value: boolean | ((old: boolean) => boolean)) => {
      const newValue = typeof value === "function" ? value(isExpanded) : value;
      if (newValue) treeExpand.expand(data.id);
      else treeExpand.collapse(data.id);
    },
    [treeExpand, data.id, isExpanded],
  );

  // Get root pages to determine navigation after deletion
  const { data: rootPages } = useGetPages(spaceId ?? null, null);

  const { mutate: updatePage } = useUpdatePage<{
    previousPages: IListPage[] | undefined;
  }>({
    onMutate: async (variables) => {
      // Cancel any outgoing refetches to avoid overwriting our optimistic update
      await queryClient.cancelQueries({
        queryKey: [
          "pages",
          { spaceId: spaceId ?? null, parentId: data.parentId },
        ],
      });

      // Snapshot the previous value
      const previousPages = queryClient.getQueryData<IListPage[]>([
        "pages",
        { parentId: data.parentId },
      ]);

      // Optimistically update to the new value
      queryClient.setQueryData<IListPage[]>(
        ["pages", { spaceId: spaceId ?? null, parentId: data.parentId }],
        (old) => {
          return old?.map((page) => {
            if (page.id === variables.id) {
              return { ...page, title: variables.title || page.title };
            }
            return page;
          });
        },
      );

      // Return a context object with the snapshotted value
      return { previousPages };
    },
    onError: (_err, _variables, context) => {
      // If the mutation fails, use the context returned from onMutate to roll back
      if (context?.previousPages) {
        queryClient.setQueryData<IListPage[]>(
          ["pages", { spaceId: spaceId ?? null, parentId: data.parentId }],
          context.previousPages,
        );
      }
    },
    onSettled: () => {
      // Always refetch after error or success to ensure we're in sync with the server
      queryClient.invalidateQueries({
        queryKey: [
          "pages",
          { spaceId: spaceId ?? null, parentId: data.parentId },
        ],
      });
      // Also invalidate all individual page queries to update breadcrumbs
      // This ensures that if any child page is currently open, its breadcrumb will update
      queryClient.invalidateQueries({
        queryKey: ["page"],
      });
    },
  });

  // A menu action can now run over a whole selection, whose pages sit under
  // different parents, so the optimistic update sweeps every cached page list
  // rather than this row's own.
  const { mutate: deletePage, isPending: isDeleting } = useDeletePage<{
    previousData: [readonly unknown[], IListPage[] | undefined][];
  }>({
    onMutate: async (variables) => {
      await queryClient.cancelQueries({ queryKey: ["pages"] });
      const previousData = queryClient.getQueriesData<IListPage[]>({
        queryKey: ["pages"],
      });

      queryClient.setQueriesData<IListPage[]>({ queryKey: ["pages"] }, (old) =>
        old ? old.filter((page) => page.id !== variables.id) : old,
      );

      return { previousData };
    },
    onError: (_err, _variables, context) => {
      if (context?.previousData) {
        for (const [key, cached] of context.previousData) {
          queryClient.setQueryData(key, cached);
        }
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["pages"] });
      queryClient.invalidateQueries({ queryKey: ["pages-archived"] });
    },
  });

  const { mutate: createPage, isPending: isCreating } = useCreatePage({
    onSuccess: (newPage) => {
      queryClient.invalidateQueries({
        queryKey: ["pages", { spaceId: spaceId ?? null, parentId: data.id }],
      });
      queryClient.setQueryData<IListPage[]>(
        ["pages", { spaceId: spaceId ?? null, parentId: data.parentId }],
        (old) => {
          return old?.map((page) => {
            if (page.id === data.id) {
              return { ...page, hasChildren: true };
            }
            return page;
          });
        },
      );
      setIsExpanded(true);
      // Navigate to the newly created page
      navigate(`/page/${newPage.id}`);
    },
  });

  // Use draggable for maximum flexibility
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: data.id,
    disabled: menuOpen || !!contextPos,
    data: {
      type: "pageLink",
      ...data,
      spaceId,
      parentsStack,
    },
  });

  // Track isDragging in a ref so we can check it at pointerup time
  useEffect(() => {
    if (isDragging) {
      wasDraggingRef.current = true;
    }
  }, [isDragging]);

  async function handleDelete() {
    const targets = menuTargets;
    // The dialog counts the highlighted rows, not the pruned targets: a
    // subpage archived along with its parent still disappears from view.
    const count = batchCount || 1;
    const confirmed = await getConfirmation({
      title: t("page.archivePages", {
        count,
        defaultValue_one: "Archive page",
        defaultValue_other: "Archive pages",
      }),
      description: t("page.confirmArchivePages", {
        count,
        defaultValue_one:
          "Archiving deletes nothing. This page and its subpages move to the Archive, where you can restore them anytime.",
        defaultValue_other:
          "Archiving deletes nothing. These {{count, number}} pages and their subpages move to the Archive, where you can restore them anytime.",
      }),
      cancelText: t("common.cancel", "Cancel"),
      confirmText: t("common.archive", "Archive"),
    });

    if (confirmed) {
      const ids = new Set(targets.map((x) => x.page.id));
      // If we're deleting the currently open page, navigate away first
      if (currentPageId && ids.has(currentPageId)) {
        // Find the first root page that is NOT on its way to the archive
        const remainingPages = rootPages?.filter((page) => !ids.has(page.id));
        if (remainingPages && remainingPages.length > 0) {
          // Navigate to the first available page
          navigate(`/page/${remainingPages[0].id}`);
        } else {
          // No pages left, navigate to /page which will show empty state
          navigate("/page");
        }
      }
      for (const x of targets) deletePage({ id: x.page.id });
      selection.clear();
    }
  }

  function handleAdd() {
    if (!spaceId) return;
    createPage({
      title: "",
      parentId: data.id,
      spaceId,
    });
  }

  function handleImport() {
    if (!spaceId) return;
    // Expand now so the imported children are visible once they arrive.
    setIsExpanded(true);
    openImport(spaceId, {
      id: data.id,
      title: data.title,
      titleMd: data.titleMd,
    });
  }

  function handleColorChange(newColor: string | null) {
    for (const x of menuTargets) updatePage({ id: x.page.id, color: newColor });
    // Optimistically update cache
    queryClient.setQueryData<IListPage[]>(
      ["pages", { spaceId: spaceId ?? null, parentId: data.parentId }],
      (old) =>
        old?.map((page) =>
          page.id === data.id ? { ...page, color: newColor } : page,
        ),
    );
    // A batch reaches pages in lists this row's own mutation never invalidates.
    if (isBatch) queryClient.invalidateQueries({ queryKey: ["pages"] });
    // Invalidate calendar queries
    queryClient.invalidateQueries({ queryKey: ["calendar-pages"] });
  }

  const resolvedColor = data.color ?? color ?? null;

  return (
    <div className={style.pageWrapper}>
      {/* Row wrapper: drop zones are absolutely positioned against THIS box so
          they measure the row only, never the expanded children below it. */}
      <div className={style.pageRow}>
        {/* Drop zone BEFORE this item - insert above */}
        <DropZone
          id={`before-${data.id}`}
          parentId={data.parentId}
          targetPageId={data.id}
          position="before"
          parentsStack={parentsStack}
          spaceId={spaceId}
        />

        {/* Drop zone INSIDE this item - for nesting */}
        <DropZone
          id={`inside-${data.id}`}
          parentId={data.id}
          targetPageId={data.id}
          position="inside"
          parentsStack={[...parentsStack, { id: data.id, order: data.order }]}
          spaceId={spaceId}
          hasChildren={data.hasChildren}
        />

        <div
          ref={setNodeRef}
          data-page-row=""
          className={clsx(style.link, {
            [style.isDragging]: isDragging,
            [style.active]: currentPageId === data.id,
            [style.selected]: isSelected,
          })}
          style={{ opacity: isDragging ? 0.4 : 1 }}
          {...attributes}
          {...listeners}
          onPointerDown={(e) => {
            // Stop propagation to prevent Vaul drawer from capturing the drag
            e.stopPropagation();
            // Call the original listener from dnd-kit
            listeners?.onPointerDown?.(e);
          }}
          onDragStart={(e) => e.preventDefault()}
          // Captured, so a modified click picks the row instead of reaching the
          // chevron or the title underneath and navigating away.
          onClickCapture={(e) => {
            if (!isMultiSelectClick(e)) return;
            e.preventDefault();
            e.stopPropagation();
            if (e.shiftKey) selection.extendTo(data.id);
            else selection.toggle(data.id);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            // Right-clicking outside the selection starts over on this row;
            // inside it, the menu takes aim at the whole selection.
            if (!selection.has(data.id)) selection.selectOnly(data.id);
            captureMenuBatch();
            if (!isCoarse) {
              setContextPos({ x: e.clientX, y: e.clientY });
            }
          }}
        >
          <Button
            variant="unstyled"
            size="unstyled"
            onClick={() => setIsExpanded((old) => !old)}
            aria-expanded={isExpanded}
            className={clsx(
              style.action,
              style.collapseAction,
              style.hasChildren,
            )}
            style={
              {
                "--page-blob-color":
                  resolvedColor || "var(--page-color-default)",
              } as CSSProperties
            }
          >
            <span
              className={clsx(
                style.collapseBlob,
                !resolvedColor && style.collapseBlobDefault,
              )}
            />
            <Icons.ChevronRight
              width={20}
              height={20}
              className={clsx(
                style.collapseIcon,
                isExpanded && style.collapseIconExpanded,
              )}
            />
            <VisuallyHidden>
              {t("page.openSubPages", "Open sub pages")}
            </VisuallyHidden>
          </Button>
          <span
            className={clsx(
              style.touchBlob,
              !resolvedColor && style.collapseBlobDefault,
            )}
            style={{
              backgroundColor: resolvedColor || "var(--page-color-default)",
            }}
          />
          <div className={style.linkTitle}>
            <span
              role="link"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  setIsExpanded(true);
                  navigate(`/page/${data.id}`);
                }
              }}
              onClick={() => {
                if (wasDraggingRef.current || recentDragEnd) {
                  wasDraggingRef.current = false;
                  return;
                }
                selection.selectOnly(data.id);
                setIsExpanded(true);
                navigate(`/page/${data.id}`);
              }}
            >
              <TitlePreview title={data.title} titleMd={data.titleMd} />
            </span>
          </div>
          <PageLinkMenu
            open={menuOpen}
            onOpenChange={(open) => {
              if (open) {
                if (!selection.has(data.id)) selection.selectOnly(data.id);
                captureMenuBatch();
              }
              setMenuOpen(open);
            }}
            isCoarse={isCoarse}
            color={data.color}
            onColorChange={handleColorChange}
            onRename={() => setShowRenameDialog(true)}
            onMove={spaceId ? () => setShowMoveDialog(true) : undefined}
            onDelete={handleDelete}
            isDeleting={isDeleting}
            onAdd={handleAdd}
            onImport={handleImport}
            isCreating={isCreating}
            batchCount={batchCount}
            t={t}
          />
        </div>

        {/* Right-click / long-press context menu positioned at cursor */}
        {contextPos && (
          <PopoverPrimitive.Root
            open={true}
            onOpenChange={(open) => {
              if (!open) setContextPos(null);
            }}
          >
            <PopoverPrimitive.Anchor
              style={{
                position: "fixed",
                left: contextPos.x,
                top: contextPos.y,
                width: 1,
                height: 1,
              }}
            />
            <PopoverPrimitive.Portal>
              <PopoverPrimitive.Content
                className="bg-popover rounded-xl shadow-lg border border-border min-w-64 z-50 select-none animate-in fade-in zoom-in-95 duration-100"
                side="bottom"
                align="start"
                sideOffset={2}
                collisionPadding={10}
                onOpenAutoFocus={(e) => e.preventDefault()}
                onCloseAutoFocus={(e) => e.preventDefault()}
                onPointerDownOutside={() => setContextPos(null)}
                onEscapeKeyDown={() => setContextPos(null)}
                onClick={(e) => e.stopPropagation()}
              >
                <PageLinkMenuContent
                  onClose={() => setContextPos(null)}
                  onColorChange={handleColorChange}
                  onRename={() => setShowRenameDialog(true)}
                  onMove={spaceId ? () => setShowMoveDialog(true) : undefined}
                  onDelete={handleDelete}
                  isDeleting={isDeleting}
                  onAdd={handleAdd}
                  onImport={handleImport}
                  isCreating={isCreating}
                  color={data.color}
                  batchCount={batchCount}
                  t={t}
                />
              </PopoverPrimitive.Content>
            </PopoverPrimitive.Portal>
          </PopoverPrimitive.Root>
        )}

        {/* Drop zone AFTER this item - insert below */}
        <DropZone
          id={`after-${data.id}`}
          parentId={data.parentId}
          targetPageId={data.id}
          position="after"
          parentsStack={parentsStack}
          spaceId={spaceId}
        />
      </div>

      {/* The subtree grows and shrinks so it reads as one motion with the
          chevron beside it. `initial={false}` keeps expansion state restored on
          mount from animating, and the subtree still unmounts when collapsed —
          its children each run their own page queries. */}
      <AnimatePresence initial={false}>
        {isExpanded /*  && data.hasChildren || isCoarse */ ? (
          <motion.div
            key="subtree"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={
              reduceMotion
                ? { duration: 0 }
                : {
                    height: {
                      duration: SUBTREE_MOTION_MS / 1000,
                      ease: SUBTREE_EASE,
                    },
                    opacity: { duration: 0.12 },
                  }
            }
            style={{ overflow: "hidden" }}
          >
            <div className={style.accordion}>
              <PagesArea
                parentId={data.id}
                spaceId={spaceId}
                parentsStack={parentsStack}
                handleAdd={handleAdd}
                isCreating={isCreating}
                color={resolvedColor}
              />
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <RenameDialog
        pageId={data.id}
        spaceId={spaceId}
        open={showRenameDialog}
        onOpenChange={setShowRenameDialog}
      />
      {spaceId && (
        <MovePageDialog
          pages={menuTargets.map((x) => ({
            id: x.page.id,
            parentId: x.page.parentId,
          }))}
          sourceSpaceId={spaceId}
          open={showMoveDialog}
          onOpenChange={setShowMoveDialog}
        />
      )}
    </div>
  );
}

function ColorGrid({
  color,
  onColorChange,
}: {
  color: string | null | undefined;
  onColorChange: (color: string | null) => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="grid w-full max-w-sm grid-cols-8 gap-2 p-1"
      onClick={(e) => e.stopPropagation()}
    >
      <Button
        variant="unstyled"
        size="unstyled"
        className={clsx(
          swatchClass,
          !color ? "border-foreground" : "border-transparent",
        )}
        style={{ backgroundColor: "var(--page-color-default)" }}
        onClick={() => onColorChange(null)}
        aria-label={t("editor.defaultColor", "Default color")}
      />
      {PRESET_COLORS.map((hex) => (
        <Button
          key={hex}
          variant="unstyled"
          size="unstyled"
          className={clsx(
            swatchClass,
            color?.toUpperCase() === hex.toUpperCase()
              ? "border-foreground"
              : "border-transparent",
          )}
          style={{ backgroundColor: hex }}
          onClick={() => onColorChange(hex)}
          aria-label={t("editor.selectColor", "Select color {{color}}", {
            color: hex,
          })}
        />
      ))}
    </div>
  );
}

function PageLinkMenuContent({
  onClose,
  onColorChange,
  onRename,
  onMove,
  onDelete,
  isDeleting,
  onAdd,
  onImport,
  isCreating,
  color,
  batchCount,
  t,
}: {
  onClose: () => void;
  onColorChange: (color: string | null) => void;
  onRename: () => void;
  onMove?: () => void;
  onDelete: () => void;
  isDeleting: boolean;
  onAdd: () => void;
  onImport: () => void;
  isCreating: boolean;
  color: string | null | undefined;
  /** Rows the menu was opened on; 0 or 1 means the plain single-page menu. */
  batchCount: number;
  t: TFunction;
}) {
  // Rename, Add subpage and Import each need one page to aim at — a title to
  // edit, a parent to nest under, a destination to import into — so they step
  // aside for a selection rather than silently picking one row out of it.
  const isBatch = batchCount > 1;
  const count = batchCount || 1;

  return (
    <>
      <div className="flex flex-col p-2 gap-1">
        {isBatch && (
          <div className="px-3 pb-1 pt-1 text-xs text-muted-foreground">
            {t("page.pagesCount", {
              count,
              defaultValue_one: "{{count, number}} page",
              defaultValue_other: "{{count, number}} pages",
            })}
          </div>
        )}
        {!isBatch && (
          <Button
            variant="unstyled"
            size="unstyled"
            className={menuItemClass}
            onClick={() => {
              onClose();
              onRename();
            }}
          >
            <Icons.Edit width={18} height={18} />
            {t("common.rename", "Rename")}
          </Button>
        )}
        {onMove && (
          <Button
            variant="unstyled"
            size="unstyled"
            className={menuItemClass}
            onClick={() => {
              onClose();
              onMove();
            }}
          >
            <FolderInput size={18} />
            {t("page.movePages", {
              count,
              defaultValue_one: "Move page",
              defaultValue_other: "Move pages",
            })}
          </Button>
        )}
        {!isBatch && (
          <>
            <Button
              variant="unstyled"
              size="unstyled"
              className={menuItemClass}
              onClick={() => {
                onClose();
                onAdd();
              }}
              disabled={isCreating}
            >
              {isCreating ? (
                <LoaderCircle className="spin" size={18} />
              ) : (
                <Icons.Plus width={18} height={18} />
              )}
              {t("page.addSubpage", "Add subpage")}
            </Button>
            <Button
              variant="unstyled"
              size="unstyled"
              className={menuItemClass}
              onClick={() => {
                onClose();
                onImport();
              }}
            >
              <Download size={18} />
              {t("import.title", "Import")}
            </Button>
          </>
        )}
        <Button
          variant="unstyled"
          size="unstyled"
          className={menuItemClass}
          onClick={() => {
            onClose();
            onDelete();
          }}
          disabled={isDeleting}
        >
          {isDeleting ? (
            <LoaderCircle className="spin" size={18} />
          ) : (
            <Archive size={18} />
          )}
          {isBatch
            ? t("page.archivePages", {
                count,
                defaultValue_one: "Archive page",
                defaultValue_other: "Archive pages",
              })
            : t("common.archive", "Archive")}
        </Button>
      </div>
      <div className="px-4 pb-4 pt-1">
        <div className="text-xs text-muted-foreground mb-2">
          {t("common.color", "Color")}
        </div>
        <ColorGrid
          color={color}
          onColorChange={(c) => {
            onColorChange(c);
            onClose();
          }}
        />
      </div>
    </>
  );
}

function PageLinkMenu({
  open,
  onOpenChange,
  isCoarse,
  color,
  onColorChange,
  onRename,
  onMove,
  onDelete,
  isDeleting,
  onAdd,
  onImport,
  isCreating,
  batchCount,
  t,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isCoarse: boolean;
  color: string | null | undefined;
  onColorChange: (color: string | null) => void;
  onRename: () => void;
  onMove?: () => void;
  onDelete: () => void;
  isDeleting: boolean;
  onAdd: () => void;
  onImport: () => void;
  isCreating: boolean;
  batchCount: number;
  t: TFunction;
}) {
  const triggerButton = (
    <Button
      variant="unstyled"
      size="unstyled"
      className={clsx(style.menuTrigger, open && style.menuTriggerOpen)}
      aria-label={t("page.options", "Page options")}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <Ellipsis className="size-[18px]" />
    </Button>
  );

  const contentProps = {
    onClose: () => onOpenChange(false),
    onColorChange,
    onRename,
    onMove,
    onDelete,
    isDeleting,
    onAdd,
    onImport,
    isCreating,
    color,
    batchCount,
    t,
  };

  if (isCoarse) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerTrigger asChild>{triggerButton}</DrawerTrigger>
        <DrawerContent>
          <DrawerHeader className="sr-only">
            <DrawerTitle>{t("page.options", "Page options")}</DrawerTitle>
          </DrawerHeader>
          <PageLinkMenuContent {...contentProps} />
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>{triggerButton}</DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-64 p-0"
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <PageLinkMenuContent {...contentProps} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
