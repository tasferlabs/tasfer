import { useDraggable } from "@dnd-kit/core";
import { CircleNotch, X } from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  type IListPage,
  useCreatePage,
  useDeletePage,
  useUpdatePage,
  useGetPages,
} from "../../api/pages.api";
import { useConfirmation } from "../../components/ConfirmationDialog";
import Icons from "../../components/uiKit/Icons/Icons";
import VisuallyHidden from "../../components/uiKit/VisuallyHidden/VisuallyHidden";
import { ColorPicker } from "../../components/ColorPicker";
import { DropZone } from "./DropZone";
import { PagesArea } from "./PagesArea";
import { type IParentsStack } from "./PagesLinks";
import style from "./PagesLinks.module.css";
import useResponsive from "@/app/hooks/useResponsive";
import { useTranslation } from "react-i18next";

// Global flag to track recent drag - module level to avoid React timing issues
let recentDragEnd = false;
export function setRecentDragEnd() {
  recentDragEnd = true;
  setTimeout(() => {
    recentDragEnd = false;
  }, 100);
}

// Mock hooks
const useOutsideClick = ({ element, action, condition }: any) => {
  useEffect(() => {
    if (!condition) return;

    const handleClick = (e: MouseEvent) => {
      if (element.current && !element.current.contains(e.target)) {
        action(e);
      }
    };

    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [condition, element, action]);
};

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
  const inputRef = useRef<HTMLInputElement>(null);
  const wasDraggingRef = useRef(false);
  const [editingPageId, setEditingPageId] = useState<string | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [localTitle, setLocalTitle] = useState(data.title);

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

  useOutsideClick({
    element: inputRef,
    action: (ev: Event) => {
      ev.stopImmediatePropagation();
      handleStopEditing();
    },
    condition: editingPageId === data.id,
  });

  function handleOnChange(title: string): void {
    setLocalTitle(title);
  }

  function handleStopEditing(): void {
    if (localTitle !== data.title) {
      // Optimistically update the cache BEFORE exiting edit mode
      queryClient.setQueryData<IListPage[]>(
        ["pages", { spaceId: spaceId ?? null, parentId: data.parentId }],
        (old) => {
          return old?.map((page) => {
            if (page.id === data.id) {
              return { ...page, title: localTitle, autoTitle: false };
            }
            return page;
          });
        },
      );
      // Set autoTitle=false since user is manually setting the title
      updatePage({ id: data.id, title: localTitle, autoTitle: false });
    }
    setEditingPageId(null);
  }

  function handleStartEditing() {
    setEditingPageId(data.id);
  }

  async function handleDelete() {
    const confirmed = await getConfirmation({
      title: "Delete Page",
      description: t("Are you sure you want to delete this page?"),
      cancelText: "Cancel",
      confirmText: "Delete",
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
  const isEditing = editingPageId === data.id;

  useEffect(() => {
    function handleWindowFocus() {
      if (isEditing) {
        handleStopEditing();
      }
    }
    window.addEventListener("focusout", handleWindowFocus);
    return () => {
      window.removeEventListener("focusout", handleWindowFocus);
    };
  }, [isEditing]);

  useEffect(() => {
    setLocalTitle(data.title);
  }, [data.title]);

  return (
    <div className={style.pageWrapper}>
      {/* Drop zone BEFORE this item - for reordering */}
      <DropZone
        id={`before-${data.id}`}
        parentId={data.parentId}
        targetPageId={data.id}
        position="before"
        order={data.order}
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
      >
        <button
          onClick={() => setIsExpanded((old) => !old)}
          className={clsx(style.action, style.collapseAction, {
            [style.hasChildren]: data.hasChildren,
          })}
        >
          {!isExpanded ? (
            <Icons.ChevronRight width={20} height={20} />
          ) : (
            <Icons.ChevronRight
              width={20}
              height={20}
              style={{ transform: "rotate(90deg)" }}
            />
          )}
          <VisuallyHidden>{t("Open sub pages")}</VisuallyHidden>
        </button>
        <ColorPicker color={data.color} onChange={handleColorChange} />
        <div className={style.linkTitle}>
          {isEditing ? (
            <input
              value={localTitle}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") handleStopEditing();
                if (e.key === "Escape") handleStopEditing();
              }}
              onChange={(e) => handleOnChange(e.target.value)}
              onBlur={() => handleStopEditing()}
              placeholder={t("Untitled")}
              ref={inputRef}
            />
          ) : (
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
              {data.title || t("Untitled")}
            </span>
          )}
        </div>
        <div className={style.actions}>
          <button
            onClick={() => {
              if (isEditing) handleStopEditing();
              else handleStartEditing();
            }}
            className={style.action}
          >
            {isEditing ? (
              <X size={20} />
            ) : (
              <Icons.Edit width={20} height={20} />
            )}
            <VisuallyHidden>{t("Edit page")}</VisuallyHidden>
          </button>
          <button
            onClick={() => handleDelete()}
            className={style.action}
            disabled={isDeleting}
          >
            {isDeleting ? (
              <CircleNotch className="spin" size={12} />
            ) : (
              <Icons.Trash width={20} height={20} />
            )}
            <VisuallyHidden>{t("Delete page")}</VisuallyHidden>
          </button>
          <button
            onClick={() => handleAdd()}
            className={style.action}
            disabled={isCreating}
          >
            {isCreating ? (
              <CircleNotch className="spin" size={12} />
            ) : (
              <Icons.Plus width={20} height={20} />
            )}
            <VisuallyHidden>{t("Add page")}</VisuallyHidden>
          </button>
        </div>
      </div>

      {/* Drop zone AFTER this item - for reordering */}
      <DropZone
        id={`after-${data.id}`}
        parentId={data.parentId}
        targetPageId={data.id}
        position="after"
        order={data.order + 1}
        parentsStack={parentsStack}
        spaceId={spaceId}
      />

      {isExpanded && (data.hasChildren || isCoarse) ? (
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
    </div>
  );
}
