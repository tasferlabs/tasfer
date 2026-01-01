import VisuallyHidden from "../components/uiKit/VisuallyHidden/VisuallyHidden";
import React from "react";
import style from "./Layout.module.css";
import { clsx } from "clsx";
import { ListIcon } from "@phosphor-icons/react";
import useResponsive from "../hooks/useResponsive";
import { SavingIndicator } from "../components/SavingIndicator";
import { useSaving } from "../contexts/SavingContext";

export function TopActionBar({
  open,
  setOpen,
}: {
  open: boolean;
  setOpen: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  // Mock data
  const pageTitle = "Untitled";
  const isMobile = useResponsive("(max-width: 768px)");
  const { isSaving } = useSaving();
  
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

      <div className={style.appHeaderTitles}>
        <span className={style.appHeaderTitle}>{pageTitle}</span>
      </div>

      <div className="ml-auto">
        <SavingIndicator isSaving={isSaving} />
      </div>
    </div>
  );
}
