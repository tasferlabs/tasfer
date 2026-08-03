import React from "react";
import style from "./Layout.module.css";
import { clsx } from "clsx";
import { ChevronLeft, PanelLeft } from "lucide-react";
import { useTranslation } from "react-i18next";
import useMobileLayout from "../hooks/useMobileLayout";
import useKeyboardInset from "../hooks/useKeyboardInset";
import { Button } from "../../components/ui/button";
import { useTopActionBarSlotRef } from "./TopActionBarSlot";
export function TopActionBar({
  open,
  setOpen,
}: {
  open: boolean;
  setOpen: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  const { t } = useTranslation();
  const { isMobile, isShort } = useMobileLayout();
  const keyboardInset = useKeyboardInset();
  const slotRef = useTopActionBarSlotRef();

  // On a landscape phone the keyboard already takes half the screen; the bar
  // would eat a third of what is left, so it steps aside while typing and comes
  // back the moment the keyboard closes. `inert` keeps the hidden controls out
  // of focus and assistive tech.
  const collapsed = isShort && keyboardInset > 0;

  return (
    <div
      className={clsx(
        style.appHeader,
        !open && style.appHeaderSidebarClosed,
        collapsed && style.appHeaderCollapsed,
      )}
      inert={collapsed ? (true as unknown as boolean) : undefined}
    >
      {(!open || isMobile) && (
        <Button
          variant="ghost"
          size="icon-sm"
          className={clsx("text-muted-foreground hover:text-foreground", style.appHeaderOpenSidebar, {
            [style.visible]: isMobile || !open,
          })}
          onClick={() => setOpen(true)}
        >
          {isMobile ? (
            <ChevronLeft className="h-5 w-5 rtl:-scale-x-100" />
          ) : (
            <PanelLeft className="h-4 w-4 rtl:-scale-x-100" />
          )}
          <span className="sr-only">{t("sidebar.open", "Open sidebar")}</span>
        </Button>
      )}

      <div ref={slotRef} className={clsx("flex items-center gap-3 flex-1 min-w-0", style.appHeaderSlot)} />
    </div>
  );
}
