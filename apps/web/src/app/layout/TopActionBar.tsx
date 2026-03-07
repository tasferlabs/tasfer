import VisuallyHidden from "../components/uiKit/VisuallyHidden/VisuallyHidden";
import React from "react";
import style from "./Layout.module.css";
import { clsx } from "clsx";
import { ListIcon } from "@phosphor-icons/react";
import useResponsive from "../hooks/useResponsive";

export function TopActionBar({
  open,
  setOpen,
}: {
  open: boolean;
  setOpen: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  const isMobile = useResponsive("(max-width: 768px)");

  return (
    <div className={style.appHeader}>
      {(!open || isMobile) && (
        <button
          className={clsx(style.iconButton, style.appHeaderOpenSidebar, {
            [style.visible]: isMobile || !open,
          })}
          onClick={() => setOpen(true)}
        >
          <ListIcon size={20} />
          <VisuallyHidden>Open sidebar</VisuallyHidden>
        </button>
      )}

      <div id="top-action-bar-slot" className="flex items-center gap-3 flex-1 min-w-0" />
    </div>
  );
}
