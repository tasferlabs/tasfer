import { useDndContext, useDroppable } from "@dnd-kit/core";
import clsx from "clsx";
import style from "../Layout.module.css";

/**
 * Insertion target between space headers, used when reordering spaces. Mirrors
 * the page `DropZone`, but for the flat space list: a drop means "place the
 * dragged space immediately before `beforeSpaceId`" (or at the end when null).
 * Only renders an active indicator while a space is being dragged.
 */
export function SpaceDropZone({
  beforeSpaceId,
}: {
  /** Space this zone sits above, or null for the trailing end-of-list zone. */
  beforeSpaceId: string | null;
}) {
  const { active } = useDndContext();
  const isSpaceDrag = active?.data.current?.type === "spaceLink";

  const { isOver, setNodeRef } = useDroppable({
    id: `space-drop-zone-${beforeSpaceId ?? "end"}`,
    disabled: !isSpaceDrag,
    data: {
      type: "space-drop-zone",
      beforeSpaceId,
    },
  });

  if (!isSpaceDrag) return null;

  return (
    <div
      ref={setNodeRef}
      className={clsx(
        style.spaceDropZone,
        isOver && style.spaceDropZoneActive,
      )}
    />
  );
}
