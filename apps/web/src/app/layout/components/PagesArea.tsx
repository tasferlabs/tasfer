import { useDroppable, useDndContext } from "@dnd-kit/core";
import clsx from "clsx";
import style from "../Layout.module.css";
import PagesLinks, { type IParentsStack } from "./PagesLinks";

export function PagesArea({
  className,
  parentId = null,
  parentsStack = [],
  handleAdd = () => {},
  isCreating = false,
}: {
  className?: string;
  parentId?: string | null;
  parentsStack?: IParentsStack;
  handleAdd?: () => void;
  isCreating?: boolean;
}) {
  const { active } = useDndContext();

  // Check if this pages area should be disabled
  const isInvalidTarget = () => {
    if (!active) return false;

    const activeId = active.id as string;

    // Can't drop into itself
    if (activeId === parentId) return true;

    // Check if any parent in the stack is the dragged item (would create circular reference)
    if (parentsStack.some((parent) => parent.id === activeId)) return true;

    return false;
  };

  const disabled = isInvalidTarget();

  const { isOver, setNodeRef } = useDroppable({
    id: `pages-area-${parentId || "root"}`,
    disabled,
    data: {
      type: "pages-area",
      parentId,
      accepts: ["pageLink"],
      parentsStack,
    },
  });

  return (
    <div
      className={clsx(
        style.appSidebarPages,
        isOver && !disabled && style.appSidebarPagesDragging,
        className,
      )}
      ref={setNodeRef}
    >
      <PagesLinks
        parentId={parentId}
        parentsStack={parentsStack}
        handleAdd={handleAdd}
        isCreating={isCreating}
      />
    </div>
  );
}
