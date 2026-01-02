import { useDroppable, useDndContext } from "@dnd-kit/core";
import clsx from "clsx";
import style from "./PagesLinks.module.css";

export type DropPosition = "before" | "after" | "inside";

interface DropZoneProps {
  id: string;
  parentId: string | null;
  targetPageId: string;
  position: DropPosition;
  order?: number;
  parentsStack?: { id: string | null; order: number }[];
}

export function DropZone({ id, parentId, targetPageId, position, order, parentsStack = [] }: DropZoneProps) {
  const { active } = useDndContext();
  
  // Check if this drop zone should be disabled
  const isInvalidTarget = () => {
    if (!active) return false;
    
    const activeId = active.id as string;
    
    // Can't drop on itself
    if (activeId === targetPageId) return true;
    
    // For "inside" position, check if the parent would be the dragged item or its descendant
    if (position === "inside" && activeId === parentId) return true;
    
    // Check if any parent in the stack is the dragged item (would create circular reference)
    if (parentsStack.some((parent) => parent.id === activeId)) return true;
    
    // For "inside" position, also check if we're trying to nest into self
    if (position === "inside" && parentId && parentsStack.some((parent) => parent.id === activeId)) {
      return true;
    }
    
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
      order,
      parentsStack,
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
        disabled && style.dropZoneDisabled
      )}
    />
  );
}

