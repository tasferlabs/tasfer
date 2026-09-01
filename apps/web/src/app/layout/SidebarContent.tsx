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
import {
  Archive,
  ChevronDown,
  ChevronUp,
  FileText,
  PanelLeftClose,
  Plus,
  Search,
  User,
} from "lucide-react";
import React, { useState } from "react";
import { NavLink, useMatch, useNavigate, useParams } from "react-router-dom";
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
  useDeletePage,
  useMovePage,
  useReorderPage,
  type IListPage,
} from "../api/pages.api";
// import { useGetSharedByMe, useGetSharedWithMe } from "../api/shares.api";
import { useAssetUrl } from "../api/images.api";
import { useArchiveSpace } from "../api/spaces.api";
import { AvatarPreviewDialog } from "../components/AvatarPreviewDialog";
import { DesktopUpdateBanner } from "../components/DesktopUpdateBanner";
import { PeerVersionBanner } from "../components/PeerVersionBanner";
import { StorageProtectionBanner } from "../components/StorageProtectionBanner";
import { useConfirmation } from "../components/ConfirmationDialog";
import { useToast, type ToastHandle } from "../components/Toast";
import { movePageAcrossSpaces } from "@/lib/spaceMove";
import Icons from "../components/uiKit/Icons/Icons";
import { useActionCenter } from "../contexts/ActionCenterContext";
import { useAuth } from "../contexts/AuthContext";
import { useSpaces } from "../contexts/SpaceContext";
import { useOrderedSpaces, useSpacePrefs } from "../contexts/SpacePrefsContext";
import {
  selectionRoots,
  usePageSelection,
  type SelectedPage,
} from "../contexts/PageSelectionContext";
import { setRecentDragEnd } from "./components/PageLink";
import { TitlePreview } from "../TitlePreview";
import { SpaceSection } from "./components/SpaceSection";
import { SidebarTailDrop } from "./components/SidebarTailDrop";
import type { IParentsStack } from "./components/PagesLinks";
// import pageLinkStyle from "./components/PagesLinks.module.css";
import { detectAdapterDetailed } from "@/platform";
import { isApplePlatform } from "@tasfer/editor";
import { useTranslation } from "react-i18next";
import { useSidebarPanel } from "../contexts/SidebarPanelContext";
import useResponsive from "../hooks/useResponsive";
import style from "./Layout.module.css";
import EmptyStateIllustration from "../components/illustrations/empty-state";

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
      | { type?: string; position?: string }
      | undefined;

  // Spaces and pages share one DndContext. When a space is being dragged, only
  // the space insertion zones are valid targets — ignore page drop zones.
  if (args.active.data.current?.type === "spaceLink") {
    return hits.filter((h) => dataFor(h.id)?.type === "space-drop-zone");
  }

  // The Archive nav link never overlaps a page drop zone, but resolve it first so
  // a drop on it can't lose to any broader container hit.
  const archive = hits.find((h) => dataFor(h.id)?.type === "archive-drop-zone");
  if (archive) return [archive];

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

/**
 * Nav rows keep their CSS-module look and borrow the shared Button base for the
 * press ripple and focus ring. The base centers its content and bolds it, which
 * a nav row does not want — hence the two overrides.
 */
const navLinkClass = clsx(style.appNavigationLink, "justify-start font-normal");

/** Sort by order, tiebroken by id to match the server's deterministic order. */
const byOrder = (a: IListPage, b: IListPage) =>
  a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Pick `count` ascending order values strictly between two neighbours (null =
 * open end), so a whole batch lands in one gap without disturbing the pages
 * already there. With `count` 1 this is just the midpoint.
 */
function spreadOrders(
  lower: number | null,
  upper: number | null,
  count: number,
): number[] {
  if (lower === null && upper === null)
    return Array.from({ length: count }, (_, i) => i + 1);
  if (lower === null)
    return Array.from({ length: count }, (_, i) => upper! - (count - i));
  if (upper === null)
    return Array.from({ length: count }, (_, i) => lower + i + 1);
  const step = (upper - lower) / (count + 1);
  return Array.from({ length: count }, (_, i) => lower + step * (i + 1));
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
  const { setOpen: setActionCenterOpen } = useActionCenter();
  const [activeId, setActiveId] = useState<string | null>(null);
  // Holds the `data.current` of whatever is being dragged — a page (IListPage)
  // or a space ({ type: "spaceLink", ... }). Read `.type` to distinguish.
  const [activeDragData, setActiveDragData] = useState<ActiveDrag | null>(null);
  // How many pages the in-progress drag carries, frozen at drag start so the
  // overlay keeps its label even as the lists update underneath.
  const [dragCount, setDragCount] = useState(1);
  const selection = usePageSelection();

  // Escape drops a multi-page selection, the way it does in a file browser.
  React.useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") selection.clear();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selection]);

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

  const { mutate: movePage, mutateAsync: movePageAsync } = useMovePage({
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

  // Soft-delete for drag-to-Archive. The dragged page can come from any list, so
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

  // Cache invalidation (spaces + pages, including the Archive) is handled inside
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

  function openSearch() {
    // On mobile the sidebar covers the screen, so it has to step aside for the
    // palette the way navigating away from it does.
    if (isMobile) setOpen(false);
    setActionCenterOpen(true);
  }

  async function archiveGroup(groupId: string) {
    const confirmed = await getConfirmation({
      title: t("space.archiveSpace", "Archive space"),
      description: t(
        "space.confirmArchiveSpace",
        "Archiving deletes nothing. It hides this space on all your devices and stops syncing it — your copy and every member's stay put. Restore it anytime.",
      ),
      confirmText: t("common.archive", "Archive"),
      cancelText: t("common.cancel", "Cancel"),
    });

    if (confirmed) {
      requestArchiveSpace(groupId);
    }
  }

  function handleDragStart(event: DragStartEvent) {
    const id = event.active.id as string;
    const data = event.active.data.current as ActiveDrag;
    // Grabbing a row outside the selection abandons it: this is a new, single
    // page gesture. Grabbing one inside it carries the whole selection along.
    if (data?.type !== "spaceLink" && !selection.has(id)) selection.clear();
    setDragCount(selection.has(id) ? selection.getSelection().length : 1);
    setActiveId(id);
    setActiveDragData(data);
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
   * Locate the gap that inserting before/after `targetPageId` opens up, within
   * a sibling list that does NOT contain the dragged pages. Returns the pages
   * bracketing the gap — their ids for no-op detection, their orders to spread
   * the batch across.
   */
  function placeRelative(
    others: IListPage[],
    targetPageId: string,
    position: "before" | "after",
  ): {
    lowerId: string | null;
    upperId: string | null;
    lowerOrder: number | null;
    upperOrder: number | null;
  } | null {
    const ti = others.findIndex((p) => p.id === targetPageId);
    if (ti === -1) return null;
    const insertIdx = position === "after" ? ti + 1 : ti;
    const lower = others[insertIdx - 1] ?? null;
    const upper = others[insertIdx] ?? null;
    return {
      lowerId: lower?.id ?? null,
      upperId: upper?.id ?? null,
      lowerOrder: lower?.order ?? null,
      upperOrder: upper?.order ?? null,
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
      parentsStack?: IParentsStack;
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

    // What this drag carries. handleDragStart has already made sure a grab
    // outside the selection cleared it, so a selection containing the grabbed
    // row means the whole selection travels. Pages nested under another page
    // in the batch are dropped: moving the ancestor already takes them.
    const selected = selection.has(activeData.id)
      ? selection.getSelection()
      : [];
    const moving: SelectedPage[] =
      selected.length > 1
        ? selectionRoots(selected)
        : [
            {
              page: activeData,
              spaceId: activeData.spaceId,
              parentsStack: activeData.parentsStack ?? [],
            },
          ];
    if (moving.length === 0) return;
    const movingIds = new Set(moving.map((m) => m.page.id));
    const movingCount = moving.length;
    // What the dialogs say. The rows the person highlighted, not the pruned
    // set: a subpage swept along with its parent still disappears from view.
    const count = Math.max(selected.length, 1);

    // Drop on the Archive nav link: soft-delete the pages (restorable from
    // /archive). Same confirmation and navigate-away behavior as the
    // context-menu delete.
    if (overData?.type === "archive-drop-zone") {
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
      if (!confirmed) return;

      if (currentPageId && movingIds.has(currentPageId)) {
        const remaining = getSiblings(moving[0].spaceId, null).filter(
          (p) => !movingIds.has(p.id),
        );
        if (remaining.length > 0) {
          navigate(`/page/${remaining[0].id}`);
        } else {
          navigate("/page");
        }
      }
      for (const m of moving) deletePage({ id: m.page.id });
      selection.clear();
      return;
    }

    // Prevent dropping on the exact same dropzone
    if (active.id === over.id) {
      return;
    }

    // Whether the drop target is one of the pages on the move, or sits inside
    // one of them — either way the drop would fold a page into itself.
    const isInsideMovingSet = (targetId: string | null): boolean => {
      if (targetId && movingIds.has(targetId)) return true;

      // Check using parentsStack if available
      if (overData?.parentsStack) {
        return overData.parentsStack.some(
          (parent: any) => parent.id && movingIds.has(parent.id),
        );
      }

      return false;
    };

    // Prevent dropping a page into itself or its descendants
    if (overData?.type === "drop-zone" && overData.position === "inside") {
      if (isInsideMovingSet(overData.parentId)) {
        return;
      }
    }

    // For other drop zones, check if the parent is a descendant
    if (
      overData?.type === "drop-zone" &&
      (overData.position === "before" || overData.position === "after")
    ) {
      if (isInsideMovingSet(overData.targetPageId)) {
        return;
      }
      if (isInsideMovingSet(overData.parentId)) {
        return;
      }
    }

    // Detect cross-space move
    const sourceSpaceId = moving[0].spaceId;
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
        title: t("page.movePages", {
          count,
          defaultValue_one: "Move page",
          defaultValue_other: "Move pages",
        }),
        description: t("page.confirmMovePagesToSpace", {
          count,
          targetName,
          defaultValue_one:
            'Move this page to "{{targetName}}"? All sub-pages will also be moved.',
          defaultValue_other:
            'Move {{count, number}} pages to "{{targetName}}"? All sub-pages will also be moved.',
        }),
        confirmText: t("common.move", "Move"),
        cancelText: t("common.cancel", "Cancel"),
      });
      if (!confirmed) return;
    }

    /**
     * Hand the batch to its destination, in the order the rows are painted.
     * Cross-space moves run one at a time: each one recreates a subtree and
     * reports progress, and they must not interleave.
     */
    async function applyMove(
      targetParentId: string | null,
      orders: (number | undefined)[],
    ) {
      if (isCrossSpace) {
        for (const [i, m] of moving.entries()) {
          await moveAcrossSpaces(
            m.page,
            targetSpaceId!,
            targetParentId,
            orders[i],
          );
        }
        // The pages were recreated under new ids; the old selection is gone.
        selection.clear();
      } else {
        for (const [i, m] of moving.entries()) {
          movePage({
            id: m.page.id,
            parentId: targetParentId,
            order: orders[i],
          });
        }
      }
    }

    // Scenarios 1 & 2: Drop on a "before"/"after" insertion zone.
    if (
      overData?.type === "drop-zone" &&
      (overData.position === "before" || overData.position === "after")
    ) {
      const targetParentId = overData.parentId as string | null;
      // A plain reorder only when every page on the move already lives in the
      // destination list; a mixed batch takes the reparenting path for all.
      const sameParent =
        !isCrossSpace &&
        moving.every((m) => m.page.parentId === targetParentId);

      const siblings = getSiblings(overData.spaceId, targetParentId);
      const others = siblings.filter((p) => !movingIds.has(p.id));
      // Null only if the row the pointer is on is missing from the cached
      // destination list, which leaves nothing to insert relative to — fall
      // back to the end of the list, as omitting the order used to.
      const placement = placeRelative(
        others,
        overData.targetPageId,
        overData.position,
      );

      if (sameParent && placement) {
        // No-op: the batch already sits, in one unbroken run, in the very gap
        // it was dropped into.
        const runStart = siblings.findIndex((p) => movingIds.has(p.id));
        const isUnbrokenRun =
          runStart !== -1 &&
          moving.every((m, i) => siblings[runStart + i]?.id === m.page.id);
        if (
          isUnbrokenRun &&
          (siblings[runStart - 1]?.id ?? null) === placement.lowerId &&
          (siblings[runStart + movingCount]?.id ?? null) === placement.upperId
        ) {
          return;
        }
      }

      const orders = placement
        ? spreadOrders(placement.lowerOrder, placement.upperOrder, movingCount)
        : spreadOrders(
            others[others.length - 1]?.order ?? null,
            null,
            movingCount,
          );

      if (sameParent) {
        moving.forEach((m, i) =>
          reorderPage({ id: m.page.id, order: orders[i] }),
        );
      } else {
        await applyMove(targetParentId, orders);
      }
    }
    // Scenario 3: Drop on "inside" zone (nest under the hovered page).
    else if (overData?.type === "drop-zone" && overData.position === "inside") {
      const newParentId = overData.parentId as string | null;

      // Nesting into itself, or pages already sitting there: nothing to do.
      if (newParentId && movingIds.has(newParentId)) return;
      const landing = moving.filter(
        (m) => isCrossSpace || m.page.parentId !== newParentId,
      );
      if (landing.length === 0) return;

      // The destination may be collapsed, in which case its children were
      // never queried and no order can be computed here. Leave the order out
      // and let the engine append — awaited one by one, so a batch keeps its
      // running order instead of every move racing for the same slot.
      if (isCrossSpace) {
        for (const m of landing) {
          await moveAcrossSpaces(m.page, targetSpaceId!, newParentId);
        }
        selection.clear();
      } else {
        for (const m of landing) {
          await movePageAsync({ id: m.page.id, parentId: newParentId });
        }
      }
    }
    // Scenario 4: Drop on the pages area (append to the end of that list).
    else if (overData?.type === "pages-area") {
      const targetParentId = overData.parentId as string | null;

      if (isInsideMovingSet(targetParentId)) {
        return;
      }

      const sameParent =
        !isCrossSpace &&
        moving.every((m) => m.page.parentId === targetParentId);
      const siblings = getSiblings(overData.spaceId, targetParentId);
      const others = siblings.filter((p) => !movingIds.has(p.id));
      const last = others[others.length - 1] ?? null;
      const orders = spreadOrders(last?.order ?? null, null, movingCount);

      if (sameParent) {
        // No-op: the batch is already the tail of this list, in order.
        const tail = siblings.slice(siblings.length - movingCount);
        if (
          tail.length === movingCount &&
          tail.every((p, i) => p.id === moving[i].page.id)
        ) {
          return;
        }
        moving.forEach((m, i) =>
          reorderPage({ id: m.page.id, order: orders[i] }),
        );
      } else {
        await applyMove(targetParentId, orders);
      }
    }
  }

  const displayName = user?.name.trim() ?? "";
  const hasSidebarProfile = Boolean(displayName);
  const initials = displayName
    .split(" ")
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);

  const avatarUrl = useAssetUrl(user?.avatar);
  const adapter = detectAdapterDetailed();
  const isElectron = adapter.startsWith("electron");
  // On the macOS app the sidebar header is the traffic-light strip, so an
  // account row there sits right next to the window buttons. The footer row
  // carries the identity instead — and, being the only one, the menu with it.
  const isMacApp = adapter === "electron-macos";
  const shouldShowTheProfileAtTop = hasSidebarProfile && !isMacApp;
  const hasAccountMenuInFooter = isMacApp && hasSidebarProfile;
  const shouldOverlaySidebarClose =
    !hasSidebarProfile && !isMobile && !isElectron;
  // The bare /page route is the editor's "no page" empty state (and, without a
  // space, the screen that stands in for it) — the one place where closing the
  // drawer uncovers nothing to come back to.
  const hasOpenPage = !useMatch("/page");

  // Whichever row carries the account menu shows the same items.
  const accountMenuItems = (
    <>
      {avatarUrl && (
        <>
          <DropdownMenuItem onSelect={() => setAvatarPreviewOpen(true)}>
            {t("profile.viewAvatar", "View avatar")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
        </>
      )}
      <DropdownMenuItem onSelect={() => navigate("/settings")}>
        {t("settings.title", "Settings")}
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => navigate("/archive")}>
        {t("archive.open", "Open Archive")}
      </DropdownMenuItem>
    </>
  );

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
          {isMobile ? (
            /* Mobile collapses the nav list into one toolbar row: the avatar
               opens a menu holding Settings and Archive, while Search, Calendar
               and Add space stay visible, so spaces start near the top. */
            <div
              className={clsx(
                style.appSidebarHeader,
                style.appSidebarHeaderMobile,
              )}
            >
              {/* The macOS app moves this menu to the footer row, leaving the
                  traffic lights alone in the strip they share with the header. */}
              {!hasAccountMenuInFooter && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="unstyled"
                      size="unstyled"
                      className={clsx(
                        style.mobileAccountTrigger,
                        "justify-start",
                      )}
                    >
                      <div className="w-8 h-8 rounded-full bg-primary/10 text-primary flex items-center justify-center text-xs font-medium shrink-0 overflow-hidden">
                        {avatarUrl ? (
                          <img
                            src={avatarUrl}
                            alt=""
                            className="w-full h-full object-cover"
                          />
                        ) : (
                          initials || <User size={16} className="size-4" />
                        )}
                      </div>
                      {displayName && (
                        <span className="text-sm font-medium text-foreground truncate">
                          {displayName}
                        </span>
                      )}
                      <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                      <span className="sr-only">
                        {t("sidebar.accountMenu", "Account menu")}
                      </span>
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    {accountMenuItems}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
              <span className="flex-1" />
              <Button
                type="button"
                variant="unstyled"
                size="unstyled"
                className={style.mobileHeaderButton}
                onClick={openSearch}
              >
                <Search className="size-[22px]" />
                <span className="sr-only">{t("sidebar.search", "Search")}</span>
              </Button>
              <MobileHeaderNavLink to="/calendar">
                <Icons.Calendar className="size-6" />
                <span className="sr-only">
                  {t("calendar.title", "Calendar")}
                </span>
              </MobileHeaderNavLink>
              <Button
                type="button"
                variant="unstyled"
                size="unstyled"
                className={style.mobileHeaderButton}
                onClick={() => onAddSpace()}
              >
                <Plus className="size-[22px]" />
                <span className="sr-only">
                  {t("space.addSpace", "Add space")}
                </span>
              </Button>
              {/* The drawer covers the whole screen, so there is no page left
                  showing to tap on the way out. Anyone not swiping needs this —
                  but only while there is a page behind it: with none open, the
                  button leads to an empty state and nothing else. */}
              {hasOpenPage && (
                <Button
                  type="button"
                  variant="unstyled"
                  size="unstyled"
                  className={style.mobileHeaderButton}
                  onClick={() => setOpen(false)}
                >
                  <PanelLeftClose className="size-[22px] rtl:-scale-x-100" />
                  <span className="sr-only">
                    {t("sidebar.close", "Close sidebar")}
                  </span>
                </Button>
              )}
            </div>
          ) : shouldShowTheProfileAtTop ? (
            <div className={clsx(style.appSidebarHeader, "gap-3")}>
              <Button
                variant="unstyled"
                size="unstyled"
                className={clsx(
                  style.appSidebarProfile,
                  "justify-start gap-2 rounded-md px-1.5 py-1 hover:bg-accent/50",
                )}
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
              </Button>
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
          ) : !isMobile && !shouldOverlaySidebarClose ? (
            <div className={style.appSidebarHeader}>
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
            </div>
          ) : null}
          {shouldOverlaySidebarClose && (
            <Button
              variant="ghost"
              size="icon-sm"
              className={clsx(
                style.appSidebarCloseOverlay,
                "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => setOpen(false)}
            >
              <PanelLeftClose className="h-4 w-4 rtl:-scale-x-100" />
              <span className="sr-only">
                {t("sidebar.close", "Close sidebar")}
              </span>
            </Button>
          )}
          {/* The DndContext wraps the nav links too, so the Archive link can act
              as a drop target for pages dragged out of the spaces tree. */}
          <DndContext
            sensors={sensors}
            collisionDetection={pageCollisionDetection}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
          >
            {/* Mobile folds these into the header toolbar above. */}
            {!isMobile && (
              <div
                className={clsx(
                  style.appNavigationLinks,
                  shouldOverlaySidebarClose &&
                    style.appNavigationLinksWithClose,
                )}
              >
                <Button
                  type="button"
                  variant="unstyled"
                  size="unstyled"
                  className={navLinkClass}
                  onClick={openSearch}
                >
                  <div className={style.appNavigationLinkIcon}>
                    <Search size={20} />
                  </div>
                  {t("sidebar.search", "Search")}
                  {isFine && (
                    <kbd className={clsx(style.appNavigationLinkShortcut)}>
                      {isApplePlatform() ? "\u2318K" : "Ctrl+K"}
                    </kbd>
                  )}
                </Button>
                <SidebarNavLink to="/settings">
                  <div className={style.appNavigationLinkIcon}>
                    <Icons.Gear width={24} height={24} />
                  </div>
                  {t("settings.title", "Settings")}
                </SidebarNavLink>
                <SidebarNavLink to="/calendar">
                  <div className={style.appNavigationLinkIcon}>
                    <Icons.Calendar width={24} height={24} />
                  </div>
                  {t("calendar.title", "Calendar")}
                </SidebarNavLink>
                <ArchiveNavLink />

                <Button
                  variant="unstyled"
                  size="unstyled"
                  className={navLinkClass}
                  onClick={() => {
                    onAddSpace();
                  }}
                >
                  <div className={style.appNavigationLinkIcon}>
                    <Icons.AddGroup />
                  </div>
                  {t("space.addSpace", "Add space")}
                </Button>
              </div>
            )}

            <div className={style.appSidebarMain}>
              <ScrollArea
                className={style.appSidebarScrollArea}
                // Scope for arrow-key navigation between page rows.
                data-page-tree=""
                // Anywhere in the tree that is not a page row is a way out of
                // a selection, the same as clicking the desktop.
                onPointerDownCapture={(e) => {
                  if (!(e.target as HTMLElement).closest("[data-page-row]")) {
                    selection.clear();
                  }
                }}
              >
                {orderedSpaces.length === 0 ? (
                  /* Every space archived. Nothing here is droppable and no tree
                     can be drawn. On desktop a line of text is all this column
                     owes — the content area beside it already shows the
                     illustration and the way back, so repeating them here would
                     only double the same offer. On mobile that content area is
                     hidden behind the sidebar, so this column carries it. */
                  isMobile ? (
                    <div className={style.appSidebarNoSpaces}>
                      <EmptyStateIllustration className={style.appSidebarNoSpacesIllustration} />
                      <Button
                        className={style.appSidebarNoSpacesButton}
                        onClick={() => onAddSpace()}
                      >
                        <Plus className="size-4" />
                        {t("space.createSpace", "Create space")}
                      </Button>
                    </div>
                  ) : (
                    <p className={style.appSidebarNoSpacesText}>
                      {t("space.noSpacesYet", "No spaces yet")}
                    </p>
                  )
                ) : (
                  <>
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
                        append a page to the last space, or move a space to the
                        end. */}
                    <SidebarTailDrop
                      lastSpaceId={orderedSpaces[orderedSpaces.length - 1].id}
                    />
                  </>
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
                  ) : dragCount > 1 ? (
                    /* A batch has no one title to show, so it is counted. */
                    <div className={style.dragOverlay}>
                      <FileText size={20} />
                      <span>
                        {t("page.pagesCount", {
                          count: dragCount,
                          defaultValue_one: "{{count, number}} page",
                          defaultValue_other: "{{count, number}} pages",
                        })}
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

          <div>
            <PeerVersionBanner />

            <DesktopUpdateBanner />

            <StorageProtectionBanner />
          </div>

          {hasAccountMenuInFooter && (
            <div className={style.appSidebarFooter}>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="unstyled"
                    size="unstyled"
                    className="w-full min-w-0 cursor-pointer justify-start gap-2 rounded-md px-1.5 py-1 hover:bg-accent/50"
                  >
                    <div className="w-8 h-8 rounded-full bg-primary/10 text-primary flex items-center justify-center text-xs font-medium shrink-0 overflow-hidden">
                      {avatarUrl ? (
                        <img
                          src={avatarUrl}
                          alt=""
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        initials || <User size={16} className="size-4" />
                      )}
                    </div>
                    <span className="text-sm font-medium text-foreground truncate">
                      {displayName}
                    </span>
                    <ChevronUp className="h-4 w-4 text-muted-foreground shrink-0 ms-auto" />
                    <span className="sr-only">
                      {t("sidebar.accountMenu", "Account menu")}
                    </span>
                  </Button>
                </DropdownMenuTrigger>
                {/* The row is the last thing in the sidebar, so the menu opens
                    upward over the spaces tree. */}
                <DropdownMenuContent side="top" align="start">
                  {accountMenuItems}
                </DropdownMenuContent>
              </DropdownMenu>
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
 * A nav row that navigates. `asChild` cannot merge NavLink's render-prop
 * className, so the active state is resolved with `useMatch` instead — `end:
 * false` keeps NavLink's default behaviour of staying active on child routes.
 */
function SidebarNavLink({
  to,
  className,
  ref,
  children,
}: {
  to: string;
  className?: string;
  ref?: React.Ref<HTMLAnchorElement>;
  children: React.ReactNode;
}) {
  const isActive = !!useMatch({ path: to, end: false });

  return (
    <Button
      asChild
      variant="unstyled"
      size="unstyled"
      className={clsx(navLinkClass, isActive && style.active, className)}
    >
      <NavLink to={to} ref={ref}>
        {children}
      </NavLink>
    </Button>
  );
}

/** The mobile header's toolbar equivalent of {@link SidebarNavLink}. */
function MobileHeaderNavLink({
  to,
  children,
}: {
  to: string;
  children: React.ReactNode;
}) {
  const isActive = !!useMatch({ path: to, end: false });

  return (
    <Button
      asChild
      variant="unstyled"
      size="unstyled"
      className={clsx(
        style.mobileHeaderButton,
        isActive && style.mobileHeaderButtonActive,
      )}
    >
      <NavLink to={to}>{children}</NavLink>
    </Button>
  );
}

/**
 * The Archive nav link doubles as a drop target: dropping a page on it archives
 * the page. Lives in its own component because `useDroppable` must run
 * under the sidebar's DndContext, which SidebarContent itself renders.
 */
function ArchiveNavLink() {
  const { t } = useTranslation();
  const { active } = useDndContext();
  const isPageDrag = active?.data.current?.type === "pageLink";
  const { isOver, setNodeRef } = useDroppable({
    id: "archive-drop",
    disabled: !isPageDrag,
    data: { type: "archive-drop-zone" },
  });

  return (
    <SidebarNavLink
      to="/archive"
      ref={setNodeRef}
      className={clsx(isOver && isPageDrag && style.archiveDropTarget)}
    >
      <div className={style.appNavigationLinkIcon}>
        <Archive width={24} height={24} />
      </div>
      {t("archive.open", "Open Archive")}
    </SidebarNavLink>
  );
}
