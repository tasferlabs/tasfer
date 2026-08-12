import { useDroppable, useDndContext } from "@dnd-kit/core";
import clsx from "clsx";
import { useEffect, useRef } from "react";
import { triggerHaptic } from "@/platform/bridge";
import { useIsExpanded, useTreeExpand } from "../../contexts/TreeExpandContext";
import { SUBTREE_MOTION_MS } from "./subtreeMotion";
import style from "./PagesLinks.module.css";

export type DropPosition = "before" | "after" | "inside";

/** How long a drag has to rest on a collapsed page before its children open. */
const SPRING_LOAD_DELAY = 500;

interface DropZoneProps {
  id: string;
  parentId: string | null;
  targetPageId: string;
  position: DropPosition;
  parentsStack?: { id: string | null; order: number }[];
  spaceId?: string;
  /** Only a nest zone over a page that has children can spring open. */
  hasChildren?: boolean;
}

export function DropZone({
  id,
  parentId,
  targetPageId,
  position,
  parentsStack = [],
  spaceId,
  hasChildren = false,
}: DropZoneProps) {
  const { active, measureDroppableContainers } = useDndContext();

  // A zone is invalid only when accepting the drop would be structurally
  // impossible (dropping a page into itself or one of its own descendants).
  // Position/no-op resolution lives in handleDragEnd, which has the full
  // sibling list and can compute a stable target order.
  const isInvalidTarget = () => {
    if (!active) return false;

    const activeId = active.id as string;

    // Can't nest a page inside itself.
    if (position === "inside" && activeId === targetPageId) return true;
    if (position === "inside" && activeId === parentId) return true;

    // Can't drop a page into any of its own descendants (circular reference).
    if (parentsStack.some((parent) => parent.id === activeId)) return true;

    return false;
  };

  const disabled = isInvalidTarget();

  const { isOver, setNodeRef } = useDroppable({
    id,
    disabled,
    data: {
      type: "drop-zone",
      position,
      parentId,
      targetPageId,
      parentsStack,
      spaceId,
    },
  });

  const treeExpand = useTreeExpand();
  const isExpanded = useIsExpanded(targetPageId);
  const sprungOpen = useRef(false);

  // Spring-loaded nesting: hold a drag still over a collapsed page and it opens,
  // so a target further down the tree is reachable in one gesture instead of
  // drop, expand, pick the page back up. Leaving the zone cancels the wait.
  useEffect(() => {
    if (!isOver || disabled || position !== "inside") return;
    if (!hasChildren || isExpanded) return;

    const timer = setTimeout(() => {
      sprungOpen.current = true;
      treeExpand.expand(targetPageId);
      triggerHaptic("light");
    }, SPRING_LOAD_DELAY);

    return () => clearTimeout(timer);
  }, [
    isOver,
    disabled,
    position,
    hasChildren,
    isExpanded,
    targetPageId,
    treeExpand,
  ]);

  // dnd-kit measures drop targets once per drag, so every row below the subtree
  // we just opened keeps a stale rect. Ask for a re-measure once it finishes
  // growing, otherwise the rest of this drag lands one row off.
  useEffect(() => {
    if (!isExpanded || !sprungOpen.current) return;
    sprungOpen.current = false;

    const timer = setTimeout(
      () => measureDroppableContainers([]),
      SUBTREE_MOTION_MS + 32,
    );

    return () => clearTimeout(timer);
  }, [isExpanded, measureDroppableContainers]);

  return (
    <div
      ref={setNodeRef}
      className={clsx(
        style.dropZone,
        position === "before" && style.dropZoneBefore,
        position === "after" && style.dropZoneAfter,
        position === "inside" && style.dropZoneInside,
        isOver && !disabled && style.dropZoneActive,
        disabled && style.dropZoneDisabled,
      )}
    />
  );
}
