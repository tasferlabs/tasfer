import VisuallyHidden from "../components/uiKit/VisuallyHidden/VisuallyHidden";
import React from "react";
import style from "./Layout.module.css";
import { clsx } from "clsx";
import { List } from "@phosphor-icons/react";

export function TopActionBar({
  open,
  setOpen,
}: {
  open: boolean;
  setOpen: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  // Mock data
  const pageTitle = "Untitled";

  return (
    <div className={style.appHeader}>
      {!open && (
        <button
          className={clsx(style.iconButton, style.appHeaderOpenSidebar)}
          onClick={() => setOpen(true)}
        >
          <List size={24} />
          <VisuallyHidden>Open sidebar</VisuallyHidden>
        </button>
      )}

      <div className={style.appHeaderTitles}>
        <span className={style.appHeaderTitle}>{pageTitle}</span>
      </div>
    </div>
  );
}
