import { useP2PPageEventsWithQueryClient } from "@/app/hooks/useP2PPageEvents";
import { triggerHaptic } from "@/platform/bridge";
import {
  DndContext,
  DragOverlay,
  MouseSensor,
  pointerWithin,
  rectIntersection,
  TouchSensor,
  useDndContext,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { useQueryClient } from "@tanstack/react-query";
import { clsx } from "clsx";
import { FileText, PanelLeftClose, Search } from "lucide-react";
import React, { useState } from "react";
import { NavLink, useNavigate, useParams } from "react-router-dom";
import { Button } from "../../components/ui/button";
import { ScrollArea } from "../../components/ui/scroll-area";
import {
  useCreatePage,
  useDeletePage,
  useMovePage,
  useReorderPage,
  type IListPage,
} from "../api/pages.api";
// import { useGetSharedByMe, useGetSharedWithMe } from "../api/shares.api";
import { useAssetUrl } from "../api/images.api";
import { getDisplayName } from "@cypherkit/provider-core/cursors";
import { useArchiveSpace } from "../api/spaces.api";
import { AvatarPreviewDialog } from "../components/AvatarPreviewDialog";
import { useConfirmation } from "../components/ConfirmationDialog";
import { useToast, type ToastHandle } from "../components/Toast";
import { movePageAcrossSpaces } from "@/lib/spaceMove";
import Icons from "../components/uiKit/Icons/Icons";
import { useAuth } from "../contexts/AuthContext";
import { useSpaces } from "../contexts/SpaceContext";
import { useOrderedSpaces, useSpacePrefs } from "../contexts/SpacePrefsContext";
import { setRecentDragEnd } from "./components/PageLink";
import { TitlePreview } from "../TitlePreview";
import { SpaceSection } from "./components/SpaceSection";
import { SidebarTailDrop } from "./components/SidebarTailDrop";
// import pageLinkStyle from "./components/PagesLinks.module.css";
import { detectAdapterDetailed } from "@/platform";
import { useTranslation } from "react-i18next";
import { useSidebarPanel } from "../contexts/SidebarPanelContext";
import useResponsive from "../hooks/useResponsive";
import style from "./Layout.module.css";

/**
 * Resolve overlapping page drop zones by pointer position. The `before`/`after`
 * insertion bands and the full-row `inside` (nest) zone deliberately overlap, so
 * we pick by priority: a sibling-insertion band wins over the nest zone, and any
 * specific zone wins over the broad pages-area container. This is what lets a
 * page be dropped after the last item — previously the full-height nest zone
 * always won the closest-center contest, so pages could only ever nest.
 */
const pageCollisionDetection: CollisionDetection = (args) => {
  const pointerHits = pointerWithin(args);
  const hits = pointerHits.length > 0 ? pointerHits : rectIntersection(args);

  const dataFor = (id: string | number) =>
    args.droppableContainers.find((c) => c.id === id)?.data.current as
      { type?: string; position?: string } | undefined;

  // Spaces and pages share one DndContext. When a space is being dragged, only
  // the space insertion zones are valid targets — ignore page drop zones.
  if (args.active.data.current?.type === "spaceLink") {
    return hits.filter((h) => dataFor(h.id)?.type === "space-drop-zone");
  }

  // The Bin nav link never overlaps a page drop zone, but resolve it first so
  // a drop on it can't lose to any broader container hit.
  const bin = hits.find((h) => dataFor(h.id)?.type === "bin-drop-zone");
  if (bin) return [bin];

  const insertion = hits.find((h) => {
    const d = dataFor(h.id);
    return d?.type === "drop-zone" && d.position !== "inside";
  });
  if (insertion) return [insertion];

  const nest = hits.find((h) => dataFor(h.id)?.type === "drop-zone");
  if (nest) return [nest];

  return hits;
};

/** The `data.current` of an in-progress drag — a page or a space header. */
type ActiveDrag =
  | (IListPage & { type?: "pageLink" })
  | { type: "spaceLink"; spaceId: string; name: string };

/** Sort by order, tiebroken by id to match the server's deterministic order. */
const byOrder = (a: IListPage, b: IListPage) =>
  a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Pick an order value strictly between two neighbours (null = open end). */
function midOrder(lower: number | null, upper: number | null): number {
  if (lower === null && upper === null) return 1;
  if (lower === null) return upper! - 1;
  if (upper === null) return lower + 1;
  return (lower + upper) / 2;
}

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
  const { toast } = useToast();
  const { panelRef, hasPanel, setSlotMounted } = useSidebarPanel();
  const [activeId, setActiveId] = useState<string | null>(null);
  // Holds the `data.current` of whatever is being dragged — a page (IListPage)
  // or a space ({ type: "spaceLink", ... }). Read `.type` to distinguish.
  const [activeDragData, setActiveDragData] = useState<ActiveDrag | null>(null);

  // Dialog states
  const [avatarPreviewOpen, setAvatarPreviewOpen] = useState(false);
  // const [sharedCollapsed, setSharedCollapsed] = useState(false);

  const { id: currentPageId } = useParams<{ id: string }>();
  const { user } = useAuth();
  const { spaces } = useSpaces();
  const spacePrefs = useSpacePrefs();
  const orderedSpaces = useOrderedSpaces(spaces);
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

  // Soft-delete for drag-to-Bin. The dragged page can come from any list, so
  // the optimistic update sweeps every cached pages query, like movePage.
  const { mutate: deletePage } = useDeletePage({
    onMutate: async (variables) => {
      await queryClient.cancelQueries({ queryKey: ["pages"] });
      const previousData = queryClient.getQueriesData<IListPage[]>({
        queryKey: ["pages"],
      });

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
      queryClient.invalidateQueries({ queryKey: ["pages-archived"] });
    },
  });

  // Cache invalidation (spaces + pages, including the Bin) is handled inside
  // useArchiveSpace so every caller stays consistent.
  const { mutate: requestArchiveSpace } = useArchiveSpace();

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
        "Archiving deletes nothing. It hides this space and stops syncing here — your copy and every member's stay put. Unarchive anytime.",
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
    setActiveDragData(event.active.data.current as ActiveDrag);
    triggerHaptic("medium");
  }

  function getSpaceName(spaceId: string): string {
    const space = spaces.find((s) => s.id === spaceId);
    return space?.name || t("common.untitled", "Untitled");
  }

  /** Read a (sorted) sibling list straight from the query cache. */
  function getSiblings(
    siblingSpaceId: string | undefined,
    parentId: string | null,
  ): IListPage[] {
    const data = queryClient.getQueryData<IListPage[]>([
      "pages",
      { spaceId: siblingSpaceId ?? null, parentId, includeTasks: false },
    ]);
    return data ? [...data].sort(byOrder) : [];
  }

  /**
   * Compute the target order for inserting before/after `targetPageId` within a
   * sibling list that does NOT contain the dragged page. Returns the new order
   * plus the ids that would bracket it (used for no-op detection).
   */
  function placeRelative(
    others: IListPage[],
    targetPageId: string,
    position: "before" | "after",
  ): { order: number; lowerId: string | null; upperId: string | null } | null {
    const ti = others.findIndex((p) => p.id === targetPageId);
    if (ti === -1) return null;
    const insertIdx = position === "after" ? ti + 1 : ti;
    const lower = others[insertIdx - 1] ?? null;
    const upper = others[insertIdx] ?? null;
    return {
      order: midOrder(lower?.order ?? null, upper?.order ?? null),
      lowerId: lower?.id ?? null,
      upperId: upper?.id ?? null,
    };
  }

  /**
   * A cross-space move recreates the dragged subtree in the target space and
   * removes the originals (src/lib/spaceMove). It bypasses react-query, so we
   * refresh the page lists by hand and follow a moved-open page to its new id.
   * Progress is surfaced only for a large subtree; small moves stay silent.
   */
  async function moveAcrossSpaces(
    activeData: IListPage,
    targetSpaceId: string,
    targetParentId: string | null,
    order?: number,
  ) {
    const LARGE_MOVE_THRESHOLD = 20;
    const label = (done: number, total: number) =>
      t("page.movingProgress", "Moving {{done}}/{{total}}…", { done, total });
    // Held in an object so the onProgress closure can lazily create it without
    // the control-flow analysis narrowing a captured `let` to `never`.
    const progress: { toast: ToastHandle | null } = { toast: null };
    try {
      const { idMap } = await movePageAcrossSpaces(
        activeData.id,
        targetSpaceId,
        {
          targetParentId,
          order,
          onProgress: ({ done, total }) => {
            if (total <= LARGE_MOVE_THRESHOLD) return;
            if (progress.toast) {
              progress.toast.update({ message: label(done, total) });
            } else {
              progress.toast = toast.loading(label(done, total));
            }
          },
        },
      );
      progress.toast?.update({
        variant: "success",
        message: t("page.moveDone", "Moved"),
      });
      // The orchestrator writes outside react-query — the source subtree is now
      // archived and the target gained new pages, so refresh both lists.
      queryClient.invalidateQueries({ queryKey: ["pages"] });
      queryClient.invalidateQueries({ queryKey: ["pages-archived"] });
      // If the open page was in the moved subtree its old id is gone — follow
      // it to the recreated page so the editor doesn't land on a dead route.
      if (currentPageId && idMap.has(currentPageId)) {
        navigate(`/page/${idMap.get(currentPageId)}`);
      }
    } catch (err) {
      console.error("[SidebarContent] cross-space move failed", err);
      const message = t("page.moveFailed", "Move failed");
      if (progress.toast) {
        progress.toast.update({ variant: "error", message });
      } else {
        toast.error(message);
      }
    }
  }

  async function handleDragEnd(event: DragEndEvent) {
    setActiveId(null);
    setActiveDragData(null);
    setRecentDragEnd();

    const { active, over } = event;

    if (!over) return;

    const activeData = active.data.current as IListPage & {
      type?: string;
      spaceId?: string;
      parentsStack?: any;
    };
    const overData = over.data.current as any;

    // Space reorder: dragging a space header onto a space insertion zone. The
    // order is a per-device preference, so this never touches the CRDT.
    if (activeData?.type === "spaceLink") {
      if (overData?.type === "space-drop-zone") {
        spacePrefs.reorder(
          orderedSpaces.map((s) => s.id),
          activeData.spaceId!,
          overData.beforeSpaceId ?? null,
        );
      }
      return;
    }

    // Drop on the Bin nav link: soft-delete the page (restorable from /bin).
    // Same confirmation and navigate-away behavior as the context-menu delete.
    if (overData?.type === "bin-drop-zone") {
      const confirmed = await getConfirmation({
        title: t("page.deletePage", "Delete Page"),
        description: t(
          "page.confirmDeletePage",
          "Are you sure you want to delete this page?",
        ),
        cancelText: t("common.cancel", "Cancel"),
        confirmText: t("common.delete", "Delete"),
      });
      if (!confirmed) return;

      if (currentPageId === activeData.id) {
        const remaining = getSiblings(activeData.spaceId, null).filter(
          (p) => p.id !== activeData.id,
        );
        if (remaining.length > 0) {
          navigate(`/page/${remaining[0].id}`);
        } else {
          navigate("/page");
        }
      }
      deletePage({ id: activeData.id });
      return;
    }

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

    // Scenarios 1 & 2: Drop on a "before"/"after" insertion zone.
    if (
      overData?.type === "drop-zone" &&
      (overData.position === "before" || overData.position === "after")
    ) {
      const targetParentId = overData.parentId as string | null;
      const sameParent =
        !isCrossSpace && activeData.parentId === targetParentId;

      if (sameParent) {
        const siblings = getSiblings(overData.spaceId, targetParentId);
        const others = siblings.filter((p) => p.id !== activeData.id);
        const placement = placeRelative(
          others,
          overData.targetPageId,
          overData.position,
        );
        if (!placement) return;

        // No-op: dropping back into the gap the page already occupies.
        const ai = siblings.findIndex((p) => p.id === activeData.id);
        const curPrev = siblings[ai - 1]?.id ?? null;
        const curNext = siblings[ai + 1]?.id ?? null;
        if (placement.lowerId === curPrev && placement.upperId === curNext) {
          return;
        }

        reorderPage({ id: activeData.id, order: placement.order });
      } else {
        // Cross-parent / cross-space: order is computed in the destination
        // list, which does not yet contain the dragged page.
        const siblings = getSiblings(overData.spaceId, targetParentId);
        const placement = placeRelative(
          siblings,
          overData.targetPageId,
          overData.position,
        );
        if (isCrossSpace) {
          await moveAcrossSpaces(
            activeData,
            targetSpaceId!,
            targetParentId,
            placement?.order,
          );
        } else {
          movePage({
            id: activeData.id,
            parentId: targetParentId,
            order: placement?.order,
          });
        }
      }
    }
    // Scenario 3: Drop on "inside" zone (nest under the hovered page).
    else if (overData?.type === "drop-zone" && overData.position === "inside") {
      const newParentId = overData.parentId as string | null;

      // Already a direct child, or nesting into itself: nothing to do.
      if (
        activeData.id === newParentId ||
        (!isCrossSpace && activeData.parentId === newParentId)
      ) {
        return;
      }

      // Order omitted → the engine appends to the new parent's children.
      if (isCrossSpace) {
        await moveAcrossSpaces(activeData, targetSpaceId!, newParentId);
      } else {
        movePage({
          id: activeData.id,
          parentId: newParentId,
        });
      }
    }
    // Scenario 4: Drop on the pages area (append to the end of that list).
    else if (overData?.type === "pages-area") {
      const targetParentId = overData.parentId as string | null;

      if (isDescendant(activeData.id, targetParentId)) {
        return;
      }

      const sameParent =
        !isCrossSpace && activeData.parentId === targetParentId;
      const siblings = getSiblings(overData.spaceId, targetParentId);
      const others = siblings.filter((p) => p.id !== activeData.id);
      const last = others[others.length - 1] ?? null;
      const order = last ? last.order + 1 : 1;

      if (sameParent) {
        // No-op: the page is already last in this list.
        if (siblings[siblings.length - 1]?.id === activeData.id) return;
        reorderPage({ id: activeData.id, order });
      } else if (isCrossSpace) {
        await moveAcrossSpaces(activeData, targetSpaceId!, targetParentId, order);
      } else {
        movePage({
          id: activeData.id,
          parentId: targetParentId,
          order,
        });
      }
    }
  }

  // Friendly display name for the local user — falls back to "Anonymous"
  // rather than an empty label when no name has been set.
  const displayName = getDisplayName(
    { name: user?.name },
    t("collaboration.anonymous", "Anonymous"),
  );
  // User initials for avatar
  const initials = displayName
    .split(" ")
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);

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
                  {displayName}
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
          {/* The DndContext wraps the nav links too, so the Bin link can act
              as a drop target for pages dragged out of the spaces tree. */}
          <DndContext
            sensors={sensors}
            collisionDetection={pageCollisionDetection}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
          >
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
              <NavLink
                className={({ isActive }) =>
                  clsx(style.appNavigationLink, isActive && style.active)
                }
                to={"/settings"}
              >
                <div className={style.appNavigationLinkIcon}>
                  <Icons.Gear width={24} height={24} />
                </div>
                {t("settings.title", "Settings")}
              </NavLink>
              <NavLink
                className={({ isActive }) =>
                  clsx(style.appNavigationLink, isActive && style.active)
                }
                to={"/calendar"}
              >
                <div className={style.appNavigationLinkIcon}>
                  <Icons.Calendar width={24} height={24} />
                </div>
                {t("calendar.title", "Calendar")}
              </NavLink>
              <BinNavLink />

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
              <ScrollArea className={style.appSidebarScrollArea}>
                {orderedSpaces.map((space) => (
                  <SpaceSection
                    key={space.id}
                    space={space}
                    isCreating={isCreating}
                    onSpaceSettings={onSpaceSettings}
                    onInviteMembers={onInviteMembers}
                    onArchive={archiveGroup}
                    onAddPage={(spaceId) => handleAdd(null, spaceId)}
                  />
                ))}
                {/* Fills the space below the last space and stays droppable:
                    append a page to the last space, or move a space to the end. */}
                {orderedSpaces.length > 0 && (
                  <SidebarTailDrop
                    lastSpaceId={orderedSpaces[orderedSpaces.length - 1].id}
                  />
                )}
              </ScrollArea>
              <DragOverlay>
                {activeId && activeDragData ? (
                  activeDragData.type === "spaceLink" ? (
                    <div className={style.dragOverlay}>
                      <Icons.Box width={20} height={20} />
                      <span>
                        {activeDragData.name ||
                          t("common.untitled", "Untitled")}
                      </span>
                    </div>
                  ) : (
                    <div className={style.dragOverlay}>
                      <FileText size={20} />
                      <span>
                        <TitlePreview
                          title={activeDragData.title}
                          titleMd={activeDragData.titleMd}
                        />
                      </span>
                    </div>
                  )
                ) : null}
              </DragOverlay>
            </div>
          </DndContext>

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
                  {displayName}
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
        name={displayName}
      />
    </>
  );
}

/**
 * The Bin nav link doubles as a drop target: dropping a page on it moves the
 * page to the Bin. Lives in its own component because `useDroppable` must run
 * under the sidebar's DndContext, which SidebarContent itself renders.
 */
function BinNavLink() {
  const { t } = useTranslation();
  const { active } = useDndContext();
  const isPageDrag = active?.data.current?.type === "pageLink";
  const { isOver, setNodeRef } = useDroppable({
    id: "bin-drop",
    disabled: !isPageDrag,
    data: { type: "bin-drop-zone" },
  });

  return (
    <NavLink
      ref={setNodeRef}
      className={({ isActive }) =>
        clsx(
          style.appNavigationLink,
          isActive && style.active,
          isOver && isPageDrag && style.binDropTarget,
        )
      }
      to={"/bin"}
    >
      <div className={style.appNavigationLinkIcon}>
        <Icons.Trash width={24} height={24} />
      </div>
      {t("bin.title", "Bin")}
    </NavLink>
  );
}
