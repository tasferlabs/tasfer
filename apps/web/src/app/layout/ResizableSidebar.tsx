import React, { useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useTranslation } from "react-i18next";
import style from "./Layout.module.css";
import { SidebarContent } from "./SidebarContent";
import useLocalStorage from "../hooks/useLocalStorage";
import useResponsive from "../hooks/useResponsive";
import { useSidebarPanel } from "../contexts/SidebarPanelContext";
import clsx from "clsx";

export function ResizableSidebar({
  setOpen,
  open,
  onAddSpace,
  onSpaceSettings,
  onInviteMembers,
}: {
  setOpen: React.Dispatch<React.SetStateAction<boolean>>;
  open: boolean;
  onAddSpace: () => void;
  onSpaceSettings: (spaceId: string) => void;
  onInviteMembers: (spaceId: string) => void;
}) {
  const { hasPanel } = useSidebarPanel();
  const { i18n } = useTranslation();
  const isRtl = i18n.dir() === "rtl";

  const isFine = useResponsive("(pointer: fine)");
  const sidebarRef = useRef<HTMLDivElement>(null);
  const [isResizing, setIsResizing] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useLocalStorage("sidebar-width", 268);
  const shouldAnimate = useRef(false);

  React.useEffect(() => {
    shouldAnimate.current = true;
  }, []);

  const startResizing = React.useCallback(() => {
    setIsResizing(true);
  }, []);

  const stopResizing = React.useCallback(() => {
    setIsResizing(false);
  }, []);

  const resize = React.useCallback(
    (mouseMoveEvent: MouseEvent) => {
      if (isResizing && sidebarRef.current) {
        const rect = sidebarRef.current.getBoundingClientRect();
        const newWidth = isRtl
          ? rect.right - mouseMoveEvent.clientX
          : mouseMoveEvent.clientX - rect.left;
        setSidebarWidth(newWidth);
      }
    },
    [isResizing, isRtl, setSidebarWidth],
  );

  React.useEffect(() => {
    window.addEventListener("mousemove", resize);
    window.addEventListener("mouseup", stopResizing);
    return () => {
      window.removeEventListener("mousemove", resize);
      window.removeEventListener("mouseup", stopResizing);
    };
  }, [resize, stopResizing]);

  const sidebarWidthDefaulted = !isFine ? 300 : (sidebarWidth as number);

  return (
    <AnimatePresence mode="wait">
      {open && (
        <motion.div
          ref={sidebarRef}
          className={style.appSidebar}
          style={{ width: sidebarWidthDefaulted }}
          initial={
            shouldAnimate.current
              ? { x: isRtl ? sidebarWidthDefaulted : -sidebarWidthDefaulted, opacity: 0 }
              : false
          }
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: isRtl ? sidebarWidthDefaulted : -sidebarWidthDefaulted, opacity: 0 }}
          transition={{ type: "spring", bounce: 0, duration: 0.2 }}
        >
          <div className={style.appSidebarContent}>
            <SidebarContent setOpen={setOpen} onAddSpace={onAddSpace} onSpaceSettings={onSpaceSettings} onInviteMembers={onInviteMembers} />
          </div>
          {isFine && (
            <div
              className={clsx(style.appSidebarResizer, hasPanel && "border-s-popover! border-e-popover!")}
              onMouseDown={startResizing}
            />
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
