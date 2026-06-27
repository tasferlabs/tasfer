import { useDndContext, useDroppable } from "@dnd-kit/core";
import clsx from "clsx";
import style from "../Layout.module.css";

/**
 * The growing region below the last space. It fills whatever vertical space is
 * left so the bottom of the sidebar is never a dead zone, and it adapts to what
 * is being dragged:
 *  - dragging a page  → a `pages-area` target that appends to the last space's
 *    root (the same "drop at the end" path as dropping onto a space's list).
 *  - dragging a space → a `space-drop-zone` end target (move to the end).
 */
export function SidebarTailDrop({ lastSpaceId }: { lastSpaceId?: string }) {
  const { active } = useDndContext();
  const isSpaceDrag = active?.data.current?.type === "spaceLink";

  const { isOver, setNodeRef } = useDroppable({
    id: "sidebar-tail",
    data: isSpaceDrag
      ? { type: "space-drop-zone", beforeSpaceId: null }
      : {
          type: "pages-area",
          parentId: null,
          spaceId: lastSpaceId,
          accepts: ["pageLink"],
          parentsStack: [],
        },
  });

  return (
    <div
      ref={setNodeRef}
      className={clsx(style.appSidebarTail, isOver && style.appSidebarTailActive)}
    />
  );
}
