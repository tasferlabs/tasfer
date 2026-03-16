import React from "react";
import style from "./Layout.module.css";
import { clsx } from "clsx";
import { PanelLeft } from "lucide-react";
import { useTranslation } from "react-i18next";
import useResponsive from "../hooks/useResponsive";
import { Button } from "../../components/ui/button";

export function TopActionBar({
  open,
  setOpen,
}: {
  open: boolean;
  setOpen: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  const { t } = useTranslation();
  const isMobile = useResponsive("(max-width: 768px)");

  return (
    <div className={style.appHeader}>
      {(!open || isMobile) && (
        <Button
          variant="ghost"
          size="icon-sm"
          className={clsx("text-muted-foreground hover:text-foreground", style.appHeaderOpenSidebar, {
            [style.visible]: isMobile || !open,
          })}
          onClick={() => setOpen(true)}
        >
          <PanelLeft className="h-4 w-4 rtl:-scale-x-100" />
          <span className="sr-only">{t("Open sidebar")}</span>
        </Button>
      )}

      <div id="top-action-bar-slot" className="flex items-center gap-3 flex-1 min-w-0" />
    </div>
  );
}
