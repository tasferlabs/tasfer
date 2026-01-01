import { useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { useDrop } from "react-dnd";
import { type IListPage, useMovePage } from "../../api/pages.api";
import PagesLinks from "./PagesLinks";
import style from "../Layout.module.css";

export function PagesArea({ className, parentId = null }: { className?: string; parentId?: string | null }) {
  const queryClient = useQueryClient();

  const { mutate: movePage } = useMovePage({
    onSuccess: (_, variables) => {
      // Invalidate both the old and new parent queries
      queryClient.invalidateQueries({ queryKey: ["pages", { parentId: variables.parentId }] });
    },
  });

  const [{ isOver }, drop] = useDrop(
    {
      accept: "pageLink",
      drop: (item: IListPage, monitor) => {
        if (item.id === null) return;
        if (monitor.didDrop()) return;
        if (item.parentId === null && item.parentId === parentId) return;

        movePage({
          id: item.id,
          parentId: parentId,
        });
      },
      collect: (monitor) => ({
        isOver: monitor.isOver({ shallow: true }),
      }),
    },
    [parentId]
  );

  return (
    <div className={clsx(style.appSidebarPages, isOver && style.appSidebarPagesDragging, className)} ref={drop}>
      <PagesLinks parentId={parentId} />
    </div>
  );
}

