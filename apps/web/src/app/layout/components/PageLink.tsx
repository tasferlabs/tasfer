import { useDraggable } from "@dnd-kit/core";
import { useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  type IListPage,
  useCreatePage,
  useDeletePage,
  useUpdatePage,
  useGetPages,
} from "../../api/pages.api";
import { useConfirmation } from "../../components/ConfirmationDialog";
import { RenameDialog } from "../../components/RenameDialog";
import { TitlePreview } from "../../TitlePreview";
import Icons from "../../components/uiKit/Icons/Icons";
import VisuallyHidden from "../../components/uiKit/VisuallyHidden/VisuallyHidden";
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
import { Ellipsis, LoaderCircle } from "lucide-react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { DropZone } from "./DropZone";
import { PagesArea } from "./PagesArea";
import { type IParentsStack } from "./PagesLinks";
import style from "./PagesLinks.module.css";
import useResponsive from "@/app/hooks/useResponsive";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useIsExpanded, useTreeExpand } from "../../contexts/TreeExpandContext";

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

// Global flag to track recent drag - module level to avoid React timing issues
let recentDragEnd = false;
export function setRecentDragEnd() {
  recentDragEnd = true;
  setTimeout(() => {
    recentDragEnd = false;
  }, 100);
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
  const navigate = useNavigate();
  const { id: currentPageId } = useParams<{ id: string }>();
  const wasDraggingRef = useRef(false);
  const [showRenameDialog, setShowRenameDialog] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [contextPos, setContextPos] = useState<{ x: number; y: number } | null>(
    null,
  );
  const treeExpand = useTreeExpand();
  const isExpanded = useIsExpanded(data.id);
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

  const { mutate: deletePage, isPending: isDeleting } = useDeletePage<{
    previousPages: IListPage[] | undefined;
  }>({
    onMutate: async (variables) => {
      // Cancel any outgoing refetches
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

      // Optimistically remove the page
      queryClient.setQueryData<IListPage[]>(
        ["pages", { spaceId: spaceId ?? null, parentId: data.parentId }],
        (old) => {
          return old?.filter((page) => page.id !== variables.id);
        },
      );

      return { previousPages };
    },
    onError: (_err, _variables, context) => {
      // Rollback on error
      if (context?.previousPages) {
        queryClient.setQueryData<IListPage[]>(
          ["pages", { spaceId: spaceId ?? null, parentId: data.parentId }],
          context.previousPages,
        );
      }
    },
    onSettled: () => {
      // Refetch to ensure sync with server
      queryClient.invalidateQueries({
        queryKey: [
          "pages",
          { spaceId: spaceId ?? null, parentId: data.parentId },
        ],
      });
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
    const confirmed = await getConfirmation({
      title: t("page.deletePage", "Delete Page"),
      description: t(
        "page.confirmDeletePage",
        "Are you sure you want to delete this page?",
      ),
      cancelText: t("common.cancel", "Cancel"),
      confirmText: t("common.delete", "Delete"),
    });

    if (confirmed) {
      // If we're deleting the currently open page, navigate away first
      if (currentPageId === data.id) {
        // Find the first root page that is NOT the one being deleted
        const remainingPages = rootPages?.filter((page) => page.id !== data.id);
        if (remainingPages && remainingPages.length > 0) {
          // Navigate to the first available page
          navigate(`/page/${remainingPages[0].id}`);
        } else {
          // No pages left, navigate to /page which will show empty state
          navigate("/page");
        }
      }
      deletePage({ id: data.id });
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

  function handleColorChange(newColor: string | null) {
    updatePage({ id: data.id, color: newColor });
    // Optimistically update cache
    queryClient.setQueryData<IListPage[]>(
      ["pages", { spaceId: spaceId ?? null, parentId: data.parentId }],
      (old) =>
        old?.map((page) =>
          page.id === data.id ? { ...page, color: newColor } : page,
        ),
    );
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
        />

        <div
          ref={setNodeRef}
          className={clsx(style.link, {
            [style.isDragging]: isDragging,
            [style.active]: currentPageId === data.id,
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
          onContextMenu={(e) => {
            e.preventDefault();
            if (!isCoarse) {
              setContextPos({ x: e.clientX, y: e.clientY });
            }
          }}
        >
          <button
            onClick={() => setIsExpanded((old) => !old)}
            className={clsx(
              style.action,
              style.collapseAction,
              style.hasChildren,
            )}
          >
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
          </button>
          <span
            className="color-picker-blob"
            style={{
              backgroundColor: resolvedColor || "var(--page-color-default)",
              opacity: resolvedColor ? 1 : 0.3,
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
                setIsExpanded(true);
                navigate(`/page/${data.id}`);
              }}
            >
              <TitlePreview title={data.title} titleMd={data.titleMd} />
            </span>
          </div>
          <PageLinkMenu
            open={menuOpen}
            onOpenChange={setMenuOpen}
            isCoarse={isCoarse}
            color={data.color}
            onColorChange={handleColorChange}
            onRename={() => setShowRenameDialog(true)}
            onDelete={handleDelete}
            isDeleting={isDeleting}
            onAdd={handleAdd}
            isCreating={isCreating}
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
                  onDelete={handleDelete}
                  isDeleting={isDeleting}
                  onAdd={handleAdd}
                  isCreating={isCreating}
                  color={data.color}
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

      {isExpanded /*  && data.hasChildren || isCoarse */ ? (
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
      ) : null}

      <RenameDialog
        pageId={data.id}
        spaceId={spaceId}
        open={showRenameDialog}
        onOpenChange={setShowRenameDialog}
      />
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
  return (
    <div
      className="grid grid-cols-8 gap-2 p-1"
      onClick={(e) => e.stopPropagation()}
    >
      <button
        className={clsx(
          "w-full aspect-square rounded-lg border-2 cursor-pointer transition-transform hover:scale-110",
          !color ? "border-foreground" : "border-transparent",
        )}
        style={{ backgroundColor: "var(--page-color-default)" }}
        onClick={() => onColorChange(null)}
        aria-label="Default color"
      />
      {PRESET_COLORS.map((hex) => (
        <button
          key={hex}
          className={clsx(
            "w-full aspect-square rounded-lg border-2 cursor-pointer transition-transform hover:scale-110",
            color?.toUpperCase() === hex.toUpperCase()
              ? "border-foreground"
              : "border-transparent",
          )}
          style={{ backgroundColor: hex }}
          onClick={() => onColorChange(hex)}
          aria-label={`Select color ${hex}`}
        />
      ))}
    </div>
  );
}

function PageLinkMenuContent({
  onClose,
  onColorChange,
  onRename,
  onDelete,
  isDeleting,
  onAdd,
  isCreating,
  color,
  t,
}: {
  onClose: () => void;
  onColorChange: (color: string | null) => void;
  onRename: () => void;
  onDelete: () => void;
  isDeleting: boolean;
  onAdd: () => void;
  isCreating: boolean;
  color: string | null | undefined;
  t: TFunction;
}) {
  return (
    <>
      <div className="flex flex-col p-2 gap-1">
        <button
          className="flex items-center gap-3 px-3 py-2.5 rounded-md text-sm hover:bg-accent text-start"
          onClick={() => {
            onClose();
            onRename();
          }}
        >
          <Icons.Edit width={18} height={18} />
          {t("common.rename", "Rename")}
        </button>
        <button
          className="flex items-center gap-3 px-3 py-2.5 rounded-md text-sm hover:bg-accent text-start"
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
        </button>
        <button
          className="flex items-center gap-3 px-3 py-2.5 rounded-md text-sm hover:bg-accent text-destructive text-start"
          onClick={() => {
            onClose();
            onDelete();
          }}
          disabled={isDeleting}
        >
          {isDeleting ? (
            <LoaderCircle className="spin" size={18} />
          ) : (
            <Icons.Trash width={18} height={18} />
          )}
          {t("common.delete", "Delete")}
        </button>
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
  onDelete,
  isDeleting,
  onAdd,
  isCreating,
  t,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isCoarse: boolean;
  color: string | null | undefined;
  onColorChange: (color: string | null) => void;
  onRename: () => void;
  onDelete: () => void;
  isDeleting: boolean;
  onAdd: () => void;
  isCreating: boolean;
  t: TFunction;
}) {
  const triggerButton = (
    <button
      className={clsx(style.menuTrigger, open && style.menuTriggerOpen)}
      aria-label={t("page.options", "Page options")}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <Ellipsis size={18} />
    </button>
  );

  const contentProps = {
    onClose: () => onOpenChange(false),
    onColorChange,
    onRename,
    onDelete,
    isDeleting,
    onAdd,
    isCreating,
    color,
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
