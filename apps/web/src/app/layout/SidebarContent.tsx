import { usePageEventsWithQueryClient } from "@/websocket/hooks/usePageEvents";
import {
  closestCenter,
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  CaretDoubleLeftIcon,
  FileTextIcon,
  PlusIcon,
} from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import React, { useState } from "react";
import { Link as RouterLink, useNavigate } from "react-router-dom";
import { ScrollArea } from "../../components/ui/scroll-area";
import {
  useCreatePage,
  useMovePage,
  useReorderPage,
  type IListPage,
} from "../api/pages.api";
import Icons from "../components/uiKit/Icons/Icons";
import VisuallyHidden from "../components/uiKit/VisuallyHidden/VisuallyHidden";
import { PagesArea } from "./components/PagesArea";
import style from "./Layout.module.css";

// Mock t function
const t = (s: string | TemplateStringsArray) => s.toString();

export function SidebarContent({
  setOpen,
}: {
  setOpen: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeDragData, setActiveDragData] = useState<IListPage | null>(null);

  // Subscribe to real-time page events from other users
  usePageEventsWithQueryClient();

  const { mutate: createPage, isPending: isCreating } = useCreatePage({
    onSuccess: (newPage, variables) => {
      queryClient.invalidateQueries({
        queryKey: ["pages", { parentId: variables.parentId }],
      });
      // Navigate to the newly created page
      navigate(`/page/${newPage.id}`);
    },
  });

  const { mutate: movePage } = useMovePage({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pages"] });
    },
  });

  const { mutate: reorderPage } = useReorderPage({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pages"] });
    },
  });

  // Configure sensors with better mobile support and prevent accidental drags during scrolling
  const sensors = useSensors(
    useSensor(MouseSensor, {
      activationConstraint: {
        distance: 15, // 15px movement required before dragging starts (increased to prevent scroll conflicts)
      },
    }),
    useSensor(TouchSensor, {
      activationConstraint: {
        delay: 800, // 800ms delay for touch devices
        tolerance: 8, // 8px of movement allowed during delay
      },
    }),
  );

  function handleAdd(parentId: string | null) {
    createPage({
      title: "",
      parentId,
    });
  }

  function handleDragStart(event: DragStartEvent) {
    setActiveId(event.active.id as string);
    setActiveDragData(event.active.data.current as IListPage);
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveId(null);
    setActiveDragData(null);

    const { active, over } = event;

    if (!over) return;

    const activeData = active.data.current as IListPage & {
      parentsStack?: any;
    };
    const overData = over.data.current as any;

    // Prevent dropping on the exact same dropzone
    if (active.id === over.id) {
      return;
    }

    // Helper function to check if targetId is a descendant of pageId
    const isDescendant = (pageId: string, targetId: string | null): boolean => {
      if (!targetId) return false;
      if (pageId === targetId) return true;

      // Check using parentsStack if available
      if (overData?.parentsStack) {
        return overData.parentsStack.some(
          (parent: any) => parent.id === pageId,
        );
      }

      return false;
    };

    // Prevent dropping a page into itself or its descendants
    if (overData?.type === "drop-zone" && overData.position === "inside") {
      if (isDescendant(activeData.id, overData.parentId)) {
        console.warn("Cannot move a page into itself or its descendants");
        return;
      }
    }

    // For other drop zones, check if the parent is a descendant
    if (
      overData?.type === "drop-zone" &&
      (overData.position === "before" || overData.position === "after")
    ) {
      if (isDescendant(activeData.id, overData.targetPageId)) {
        console.warn("Cannot move a page to become a sibling of itself");
        return;
      }
      // Also check the parent
      if (isDescendant(activeData.id, overData.parentId)) {
        console.warn("Cannot move a page into its descendants");
        return;
      }
    }

    // Scenario 1: Drop on "before" zone - reorder to position before target
    if (overData?.type === "drop-zone" && overData.position === "before") {
      const targetParentId = overData.parentId;
      const targetOrder = overData.order;

      // If moving to different parent
      if (activeData.parentId !== targetParentId) {
        movePage({
          id: activeData.id,
          parentId: targetParentId,
          order: targetOrder,
        });
      }
      // If reordering within same parent
      else {
        // Skip no-op reorders where order doesn't change
        if (targetOrder !== activeData.order) {
          reorderPage({
            id: activeData.id,
            order: targetOrder,
          });
        }
      }
    }
    // Scenario 2: Drop on "after" zone - reorder to position after target
    else if (overData?.type === "drop-zone" && overData.position === "after") {
      const targetParentId = overData.parentId;
      const targetOrder = overData.order;

      // If moving to different parent
      if (activeData.parentId !== targetParentId) {
        movePage({
          id: activeData.id,
          parentId: targetParentId,
          order: targetOrder,
        });
      }
      // If reordering within same parent
      else {
        // Skip no-op reorders where order doesn't change
        if (targetOrder !== activeData.order) {
          reorderPage({
            id: activeData.id,
            order: targetOrder,
          });
        }
      }
    }
    // Scenario 3: Drop on "inside" zone - make dragged item a child of target
    else if (overData?.type === "drop-zone" && overData.position === "inside") {
      const newParentId = overData.parentId;

      // Prevent making a page its own child or circular nesting
      if (activeData.id !== newParentId) {
        movePage({
          id: activeData.id,
          parentId: newParentId,
        });
      }
    }
    // Scenario 4: Drop on pages area (empty area or root)
    else if (overData?.type === "pages-area") {
      const targetParentId = overData.parentId;

      // Prevent dropping into itself or its descendants
      if (isDescendant(activeData.id, targetParentId)) {
        return;
      }

      if (activeData.parentId !== targetParentId) {
        movePage({
          id: activeData.id,
          parentId: targetParentId,
        });
      }
    }
  }

  const filteredGroups: { id: string; name: string }[] = [];

  return (
    <>
      <div className={style.appSidebarHeader}>
        {/* UserDropdown placeholder */}
        <div className="w-8 h-8 rounded-full bg-muted" />

        <button
          onClick={() => setOpen(false)}
          className={clsx(style.iconButton, style.appSidebarClose)}
        >
          <CaretDoubleLeftIcon size={24} />
          <VisuallyHidden>{t`Close sidebar`}</VisuallyHidden>
        </button>
      </div>
      <div className={style.appNavigationLinks}>
        <RouterLink className={style.appNavigationLink} to={"/settings"}>
          <div className={style.appNavigationLinkIcon}>
            <Icons.Gear width={24} height={24} />
          </div>
          {t`Settings`}
        </RouterLink>
        {/* <button className={style.appNavigationLink}>
          <div className={style.appNavigationLinkIcon}>
            <Icons.Tray width={24} height={24} />
          </div>
          {t`Inbox`}
          {inboxCount > 0 && (
            <span className={style.appNavigationLinkBadge}>{inboxCount}</span>
          )}
        </button>
        <button className={style.appNavigationLink}>
          <div className={style.appNavigationLinkIcon}>
            <Icons.AddGroup />
          </div>
          {t`Add group`}
        </button> */}
      </div>

      <div className={style.appSidebarMain}>
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          <ScrollArea className={style.appSidebarScrollArea}>
            {filteredGroups.map((group) => (
              <React.Fragment key={group.id}>
                <div className={style.appSidebarSection}>
                  <div className={style.appSidebarSectionTitle}>
                    <div className={style.appSidebarSectionIcon}>
                      <Icons.Shared />
                    </div>
                    {group.name}
                  </div>
                  <button
                    className={style.appSidebarSectionButton}
                    onClick={() => handleAdd(null)}
                    disabled={isCreating}
                  >
                    <PlusIcon size={20} />
                    <span className="sr-only">{t`Add page`}</span>
                  </button>
                </div>
                <PagesArea parentId={null} />
              </React.Fragment>
            ))}

            <div className={style.appSidebarSection}>
              <div className={style.appSidebarSectionTitle}>
                <div className={style.appSidebarSectionIcon}>
                  <Icons.Lock width={20} height={20} />
                </div>
                {t`Private`}
              </div>
              <button
                className={style.appSidebarSectionButton}
                onClick={() => handleAdd(null)}
                disabled={isCreating}
              >
                <PlusIcon size={20} />
                <span className="sr-only">{t`Add page`}</span>
              </button>
            </div>

            <PagesArea
              className={style.appSidebarSectionPagesArea}
              parentId={null}
            />
          </ScrollArea>
          <DragOverlay>
            {activeId && activeDragData ? (
              <div className={style.dragOverlay}>
                <FileTextIcon size={20} />
                <span>{activeDragData.title || "Untitled"}</span>
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      </div>
    </>
  );
}
