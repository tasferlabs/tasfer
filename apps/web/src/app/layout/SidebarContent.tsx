import { useP2PPageEventsWithQueryClient } from "@/app/hooks/useP2PPageEvents";
import { triggerHapticFeedback } from "@/editor/events/touchEvents";
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
import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { Ellipsis, FileText, PanelLeftClose, Plus, Search } from "lucide-react";
import React, { useState } from "react";
import { Link as RouterLink, useNavigate } from "react-router-dom";
import { Button } from "../../components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import { ScrollArea } from "../../components/ui/scroll-area";
import {
  useCreatePage,
  useMovePage,
  useReorderPage,
  type IListPage,
} from "../api/pages.api";
// import { useGetSharedByMe, useGetSharedWithMe } from "../api/shares.api";
import { useAssetUrl } from "../api/images.api";
import { useArchiveSpace } from "../api/spaces.api";
import { AvatarPreviewDialog } from "../components/AvatarPreviewDialog";
import { useConfirmation } from "../components/ConfirmationDialog";
import Icons from "../components/uiKit/Icons/Icons";
import { useAuth } from "../contexts/AuthContext";
import { useSpaces } from "../contexts/SpaceContext";
import { setRecentDragEnd } from "./components/PageLink";
import { PagesArea } from "./components/PagesArea";
// import pageLinkStyle from "./components/PagesLinks.module.css";
import { detectAdapterDetailed } from "@/platform";
import { useTranslation } from "react-i18next";
import { useSidebarPanel } from "../contexts/SidebarPanelContext";
import useResponsive from "../hooks/useResponsive";
import style from "./Layout.module.css";

export function SidebarContent({
  setOpen,
  onAddSpace,
  onSpaceSettings,
  onInviteMembers,
  isMobile,
}: {
  setOpen: React.Dispatch<React.SetStateAction<boolean>>;
  onAddSpace: () => void;
  onSpaceSettings: (spaceId: string) => void;
  onInviteMembers: (spaceId: string) => void;
  isMobile?: boolean;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const isFine = useResponsive("(pointer: fine)");
  const { getConfirmation } = useConfirmation();
  const { panelRef, hasPanel, setSlotMounted } = useSidebarPanel();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeDragData, setActiveDragData] = useState<IListPage | null>(null);

  // Dialog states
  const [avatarPreviewOpen, setAvatarPreviewOpen] = useState(false);
  // const [sharedCollapsed, setSharedCollapsed] = useState(false);

  // const { id: currentPageId } = useParams<{ id: string }>();
  const { user } = useAuth();
  const { spaces } = useSpaces();
  // const { data: sharedWithMe } = useGetSharedWithMe();
  // const { data: sharedByMe } = useGetSharedByMe();

  // Subscribe to real-time page and space events from other users
  useP2PPageEventsWithQueryClient();

  const { mutate: createPage, isPending: isCreating } = useCreatePage({
    onSuccess: (newPage, variables) => {
      queryClient.invalidateQueries({
        queryKey: [
          "pages",
          { spaceId: variables.spaceId, parentId: variables.parentId },
        ],
      });
      // Navigate to the newly created page
      navigate(`/page/${newPage.id}`);
    },
  });

  const { mutate: movePage } = useMovePage({
    onMutate: async (variables) => {
      await queryClient.cancelQueries({ queryKey: ["pages"] });
      const previousData = queryClient.getQueriesData<IListPage[]>({
        queryKey: ["pages"],
      });

      // Remove the page from whichever list it currently lives in
      queryClient.setQueriesData<IListPage[]>({ queryKey: ["pages"] }, (old) =>
        old ? old.filter((p) => p.id !== variables.id) : old,
      );

      return { previousData };
    },
    onError: (_err, _variables, context) => {
      if (context?.previousData) {
        for (const [key, data] of context.previousData) {
          queryClient.setQueryData(key, data);
        }
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["pages"] });
    },
  });

  const { mutate: reorderPage } = useReorderPage({
    onMutate: async (variables) => {
      await queryClient.cancelQueries({ queryKey: ["pages"] });
      const previousData = queryClient.getQueriesData<IListPage[]>({
        queryKey: ["pages"],
      });

      // Update the order in-place and re-sort the list
      queryClient.setQueriesData<IListPage[]>(
        { queryKey: ["pages"] },
        (old) => {
          if (!old) return old;
          const idx = old.findIndex((p) => p.id === variables.id);
          if (idx === -1) return old;
          const updated = [...old];
          updated[idx] = { ...updated[idx], order: variables.order };
          updated.sort((a, b) => a.order - b.order);
          return updated;
        },
      );

      return { previousData };
    },
    onError: (_err, _variables, context) => {
      if (context?.previousData) {
        for (const [key, data] of context.previousData) {
          queryClient.setQueryData(key, data);
        }
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["pages"] });
    },
  });

  const { mutate: requestArchiveSpace } = useArchiveSpace({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["spaces"] });
      queryClient.invalidateQueries({ queryKey: ["pages"] });
    },
  });

  // Configure sensors with better mobile support and prevent accidental drags during scrolling
  const sensors = useSensors(
    useSensor(MouseSensor, {
      activationConstraint: {
        distance: 15,
      },
    }),
    useSensor(TouchSensor, {
      activationConstraint: {
        delay: 300,
        tolerance: 5,
      },
    }),
  );

  function handleAdd(parentId: string | null, spaceId: string) {
    createPage({
      title: "",
      parentId,
      spaceId,
    });
  }

  async function archiveGroup(groupId: string) {
    const confirmed = await getConfirmation({
      title: t("space.archiveSpace", "Archive space"),
      description: t(
        "space.confirmArchiveSpace",
        "Are you sure you want to archive this space? You will stop syncing and receiving updates.",
      ),
      confirmText: t("common.archive", "Archive"),
      cancelText: t("common.cancel", "Cancel"),
    });

    if (confirmed) {
      requestArchiveSpace(groupId);
    }
  }

  function handleDragStart(event: DragStartEvent) {
    setActiveId(event.active.id as string);
    setActiveDragData(event.active.data.current as IListPage);
    triggerHapticFeedback("medium");
  }

  function getSpaceName(spaceId: string): string {
    const space = spaces.find((s) => s.id === spaceId);
    return space?.name || t("common.untitled", "Untitled");
  }

  async function handleDragEnd(event: DragEndEvent) {
    setActiveId(null);
    setActiveDragData(null);
    setRecentDragEnd();

    const { active, over } = event;

    if (!over) return;

    const activeData = active.data.current as IListPage & {
      spaceId?: string;
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
        return;
      }
    }

    // For other drop zones, check if the parent is a descendant
    if (
      overData?.type === "drop-zone" &&
      (overData.position === "before" || overData.position === "after")
    ) {
      if (isDescendant(activeData.id, overData.targetPageId)) {
        return;
      }
      if (isDescendant(activeData.id, overData.parentId)) {
        return;
      }
    }

    // Detect cross-space move
    const sourceSpaceId = activeData.spaceId;
    const targetSpaceId = overData?.spaceId;
    const isCrossSpace = !!(
      sourceSpaceId &&
      targetSpaceId &&
      sourceSpaceId !== targetSpaceId
    );

    // If moving between spaces, ask for confirmation
    if (isCrossSpace) {
      const targetName = getSpaceName(targetSpaceId);
      const confirmed = await getConfirmation({
        title: t("page.movePage", "Move page"),
        description: t(
          'Move this page to "{{targetName}}"? All sub-pages will also be moved.',
          { targetName },
        ),
        confirmText: t("common.move", "Move"),
        cancelText: t("common.cancel", "Cancel"),
      });
      if (!confirmed) return;
    }

    // Build the spaceId param only when cross-space
    const spaceIdParam = isCrossSpace ? targetSpaceId : undefined;

    // Scenario 1: Drop on "before" zone
    if (overData?.type === "drop-zone" && overData.position === "before") {
      const targetParentId = overData.parentId;
      const targetOrder = overData.order;

      if (isCrossSpace || activeData.parentId !== targetParentId) {
        movePage({
          id: activeData.id,
          parentId: targetParentId,
          order: targetOrder,
          spaceId: spaceIdParam,
        });
      } else {
        if (targetOrder !== activeData.order) {
          reorderPage({
            id: activeData.id,
            order: targetOrder,
          });
        }
      }
    }
    // Scenario 2: Drop on "after" zone
    else if (overData?.type === "drop-zone" && overData.position === "after") {
      const targetParentId = overData.parentId;
      const targetOrder = overData.order;

      if (isCrossSpace || activeData.parentId !== targetParentId) {
        movePage({
          id: activeData.id,
          parentId: targetParentId,
          order: targetOrder,
          spaceId: spaceIdParam,
        });
      } else {
        if (targetOrder !== activeData.order) {
          reorderPage({
            id: activeData.id,
            order: targetOrder,
          });
        }
      }
    }
    // Scenario 3: Drop on "inside" zone
    else if (overData?.type === "drop-zone" && overData.position === "inside") {
      const newParentId = overData.parentId;

      if (activeData.id !== newParentId) {
        movePage({
          id: activeData.id,
          parentId: newParentId,
          spaceId: spaceIdParam,
        });
      }
    }
    // Scenario 4: Drop on pages area
    else if (overData?.type === "pages-area") {
      const targetParentId = overData.parentId;

      if (isDescendant(activeData.id, targetParentId)) {
        return;
      }

      if (isCrossSpace || activeData.parentId !== targetParentId) {
        movePage({
          id: activeData.id,
          parentId: targetParentId,
          spaceId: spaceIdParam,
        });
      }
    }
  }

  // User initials for avatar
  const initials = user?.name
    ? user.name
        .split(" ")
        .map((w) => w[0])
        .join("")
        .toUpperCase()
        .slice(0, 2)
    : "?";

  const avatarUrl = useAssetUrl(user?.avatar);
  const shouldShowTheProfileAtTop =
    detectAdapterDetailed() !== "electron-macos";
  return (
    <>
      {/* Portal target for page panels (e.g. calendar event preview) — replaces entire sidebar */}
      <div
        ref={(el) => {
          panelRef.current = el;
          setSlotMounted(!!el);
        }}
        className={clsx(style.sidebarPanelSlot, "bg-popover")}
        style={{ display: hasPanel ? "flex" : "none" }}
      />

      {!hasPanel && (
        <>
          {shouldShowTheProfileAtTop ? (
            <div className={clsx(style.appSidebarHeader, "gap-3")}>
              <button
                className="flex items-center gap-2 min-w-0 px-1.5 py-1 w-full rounded-md hover:bg-accent/50 transition-colors"
                onClick={() => avatarUrl && setAvatarPreviewOpen(true)}
                style={{ cursor: avatarUrl ? "pointer" : "default" }}
              >
                <div className="w-8 h-8 rounded-full bg-primary/10 text-primary flex items-center justify-center text-xs font-medium shrink-0 overflow-hidden">
                  {avatarUrl ? (
                    <img
                      src={avatarUrl}
                      alt=""
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    initials
                  )}
                </div>
                <span className="text-sm font-medium text-foreground truncate">
                  {user?.name}
                </span>
              </button>
              {!isMobile && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground hover:text-foreground ms-auto"
                  onClick={() => setOpen(false)}
                >
                  <PanelLeftClose className="h-4 w-4 rtl:-scale-x-100" />
                  <span className="sr-only">
                    {t("sidebar.close", "Close sidebar")}
                  </span>
                </Button>
              )}
            </div>
          ) : (
            <div className={style.appSidebarHeader}>
              {!isMobile && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() => setOpen(false)}
                >
                  <PanelLeftClose className="h-4 w-4 rtl:-scale-x-100" />
                  <span className="sr-only">
                    {t("sidebar.close", "Close sidebar")}
                  </span>
                </Button>
              )}
            </div>
          )}
          <div className={style.appNavigationLinks}>
            <button
              className={style.appNavigationLink}
              onClick={() => {
                document.dispatchEvent(
                  new KeyboardEvent("keydown", {
                    key: "k",
                    metaKey: true,
                    bubbles: true,
                  }),
                );
              }}
            >
              <div className={style.appNavigationLinkIcon}>
                <Search size={20} />
              </div>
              {t("sidebar.search", "Search")}
              {isFine && (
                <kbd className={clsx(style.appNavigationLinkShortcut)}>
                  {/Mac|iPhone|iPad/.test(navigator.platform)
                    ? "\u2318K"
                    : "Ctrl+K"}
                </kbd>
              )}
            </button>
            <RouterLink className={style.appNavigationLink} to={"/settings"}>
              <div className={style.appNavigationLinkIcon}>
                <Icons.Gear width={24} height={24} />
              </div>
              {t("settings.title", "Settings")}
            </RouterLink>
            <RouterLink className={style.appNavigationLink} to={"/calendar"}>
              <div className={style.appNavigationLinkIcon}>
                <Icons.Calendar width={24} height={24} />
              </div>
              {t("calendar.title", "Calendar")}
            </RouterLink>

            <button
              className={style.appNavigationLink}
              onClick={() => {
                onAddSpace();
              }}
            >
              <div className={style.appNavigationLinkIcon}>
                <Icons.AddGroup />
              </div>
              {t("space.addSpace", "Add space")}
            </button>
          </div>

          <div className={style.appSidebarMain}>
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
            >
              <ScrollArea className={style.appSidebarScrollArea}>
                {spaces.map((space) => (
                  <React.Fragment key={space.id}>
                    <div className={style.appSidebarSection}>
                      <div className={style.appSidebarSectionTitle}>
                        <div className={style.appSidebarSectionIcon}>
                          <Icons.Shared />
                        </div>
                        {space.name || t("common.untitled", "Untitled")}
                      </div>
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          className={style.appSidebarSectionButton}
                        >
                          <Ellipsis size={20} />
                          <span className="sr-only">
                            {t("space.settings", "Space settings")}
                          </span>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent>
                          <DropdownMenuItem
                            onSelect={() => {
                              onSpaceSettings(space.id);
                            }}
                          >
                            {t("space.settings", "Space settings")}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() => {
                              onInviteMembers(space.id);
                            }}
                          >
                            {t("share.inviteMembers", "Invite members")}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onClick={() => archiveGroup(space.id)}
                          >
                            {t("space.archiveSpace", "Archive space")}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                      <button
                        className={style.appSidebarSectionButton}
                        onClick={() => handleAdd(null, space.id)}
                        disabled={isCreating}
                      >
                        <Plus size={20} />
                        <span className="sr-only">
                          {t("page.addPage", "Add page")}
                        </span>
                      </button>
                    </div>
                    <PagesArea parentId={null} spaceId={space.id} />
                  </React.Fragment>
                ))}
              </ScrollArea>
              <DragOverlay>
                {activeId && activeDragData ? (
                  <div className={style.dragOverlay}>
                    <FileText size={20} />
                    <span>
                      {activeDragData.title || t("common.untitled", "Untitled")}
                    </span>
                  </div>
                ) : null}
              </DragOverlay>
            </DndContext>
          </div>

          {!shouldShowTheProfileAtTop && (
            <div className={style.appSidebarFooter}>
              <button
                className="flex items-center gap-2 min-w-0 px-1.5 py-1 w-full rounded-md hover:bg-accent/50 transition-colors"
                onClick={() => avatarUrl && setAvatarPreviewOpen(true)}
                style={{ cursor: avatarUrl ? "pointer" : "default" }}
              >
                <div className="w-8 h-8 rounded-full bg-primary/10 text-primary flex items-center justify-center text-xs font-medium shrink-0 overflow-hidden">
                  {avatarUrl ? (
                    <img
                      src={avatarUrl}
                      alt=""
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    initials
                  )}
                </div>
                <span className="text-sm font-medium text-foreground truncate">
                  {user?.name}
                </span>
              </button>
            </div>
          )}
        </>
      )}

      <AvatarPreviewDialog
        open={avatarPreviewOpen}
        onOpenChange={setAvatarPreviewOpen}
        imageUrl={avatarUrl}
        name={user?.name}
      />
    </>
  );
}
