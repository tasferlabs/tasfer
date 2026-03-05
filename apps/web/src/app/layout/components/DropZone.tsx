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
  spaceId?: string;
}

export function DropZone({ id, parentId, targetPageId, position, order, parentsStack = [], spaceId }: DropZoneProps) {
  const { active } = useDndContext();
  
  // Check if this drop zone should be disabled
  const isInvalidTarget = () => {
    if (!active) return false;
    
    const activeId = active.id as string;
    const activeData = active.data.current as any;
    
    // Can't drop on "inside" zone of itself (nesting into self)
    if (position === "inside" && activeId === targetPageId) return true;
    
    // For "inside" position, check if the parent would be the dragged item or its descendant
    if (position === "inside" && activeId === parentId) return true;
    
    // Check if any parent in the stack is the dragged item (would create circular reference)
    if (parentsStack.some((parent) => parent.id === activeId)) return true;
    
    // Prevent dropping on adjacent sibling dropzones that would cause unwanted swaps
    // Only applies when in the same parent
    if (activeData && activeData.parentId === parentId && order !== undefined) {
      const activeOrder = activeData.order;
      
      // Block both "before" and "after" zones at the immediately next position
      // Example: PageA (order: 0) should not drop on:
      //   - PageA's "after" zone (order: 1) - would swap with PageB
      //   - PageB's "before" zone (order: 1) - would swap with PageB
      // This allows dropping on PageA's "before" zone (order: 0) to cancel the drag
      if (order === activeOrder + 1) {
        return true;
      }
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
        disabled && style.dropZoneDisabled
      )}
    />
  );
}

