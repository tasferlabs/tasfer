import React from "react";
import style from "./Layout.module.css";
import { clsx } from "clsx";
import { ChevronLeft, PanelLeft } from "lucide-react";
import { useTranslation } from "react-i18next";
import useMobileLayout from "../hooks/useMobileLayout";
import useKeyboardInset from "../hooks/useKeyboardInset";
import { Button } from "../../components/ui/button";
import { usePeerVersion } from "../contexts/PeerVersionContext";
import { usePageSettings } from "../contexts/PageSettingsContext";
import { useTopActionBarSlotRef } from "./TopActionBarSlot";
import { ShortcutTooltip } from "../components/ShortcutTooltip";
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
  // The sidebar warning is invisible while the sidebar is closed, so the button
  // that opens it carries a dot instead.
  const { notice } = usePeerVersion();
  // Shares the archived banner's wash when the open page is archived.
  const { isPageArchived } = usePageSettings();

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
        isPageArchived && style.appHeaderArchived,
        collapsed && style.appHeaderCollapsed,
      )}
      inert={collapsed ? (true as unknown as boolean) : undefined}
    >
      {(!open || isMobile) &&
        (() => {
          const button = (
            <Button
              variant="ghost"
              size="icon-sm"
              className={clsx("relative text-muted-foreground hover:text-foreground", style.appHeaderOpenSidebar, {
                [style.visible]: isMobile || !open,
              })}
              onClick={() => setOpen(true)}
            >
              {isMobile ? (
                <ChevronLeft className="h-5 w-5 rtl:-scale-x-100" />
              ) : (
                <PanelLeft className="h-4 w-4 rtl:-scale-x-100" />
              )}
              {notice !== null && (
                <span
                  aria-hidden
                  className="absolute end-0.5 top-0.5 size-2 rounded-full bg-destructive ring-2 ring-background"
                />
              )}
              <span className="sr-only">{t("sidebar.open", "Open sidebar")}</span>
              {notice !== null && (
                <span className="sr-only">
                  {t("sync.versionIncompatibleTitle", "Can't sync with a device")}
                </span>
              )}
            </Button>
          );
          // The shortcut hint is for a hardware keyboard; on mobile there is
          // nothing to hover with and the chord is not offered.
          return isMobile ? (
            button
          ) : (
            <ShortcutTooltip
              label={t("sidebar.open", "Open sidebar")}
              commandKey="."
            >
              {button}
            </ShortcutTooltip>
          );
        })()}

      <div ref={slotRef} className={clsx("flex items-center gap-3 flex-1 min-w-0", style.appHeaderSlot)} />
    </div>
  );
}
