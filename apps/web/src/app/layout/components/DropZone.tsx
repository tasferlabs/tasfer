import { useDroppable, useDndContext } from "@dnd-kit/core";
import clsx from "clsx";
import style from "./PagesLinks.module.css";

export type DropPosition = "before" | "after" | "inside";

interface DropZoneProps {
  id: string;
  parentId: string | null;
  targetPageId: string;
  position: DropPosition;
  parentsStack?: { id: string | null; order: number }[];
  spaceId?: string;
}

export function DropZone({
  id,
  parentId,
  targetPageId,
  position,
  parentsStack = [],
  spaceId,
}: DropZoneProps) {
  const { active } = useDndContext();

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
