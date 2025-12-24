import React, { useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import style from "./Layout.module.css";
import { SidebarContent } from "./SidebarContent";
import useLocalStorage from "../hooks/useLocalStorage";
import useResponsive from "../hooks/useResponsive";

export function ResizableSidebar({
  setOpen,
  open,
}: {
  setOpen: React.Dispatch<React.SetStateAction<boolean>>;
  open: boolean;
}) {
  const isFine = useResponsive("(pointer: fine)");
  const sidebarRef = useRef<HTMLDivElement>(null);
  const [isResizing, setIsResizing] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useLocalStorage("sidebar-width", 268);
  
  const startResizing = React.useCallback(() => {
    setIsResizing(true);
  }, []);

  const stopResizing = React.useCallback(() => {
    setIsResizing(false);
  }, []);

  const resize = React.useCallback(
    (mouseMoveEvent: MouseEvent) => {
      if (isResizing && sidebarRef.current) {
         setSidebarWidth(mouseMoveEvent.clientX - sidebarRef.current?.getBoundingClientRect().left);
      }
    },
    [isResizing, setSidebarWidth]
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
          initial={{ x: -sidebarWidthDefaulted, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: -sidebarWidthDefaulted, opacity: 0 }}
          transition={{ type: "spring", bounce: 0, duration: 0.2 }}
        >
          <div className={style.appSidebarContent}>
            <SidebarContent
              setOpen={setOpen}
            />
          </div>
          {isFine && <div className={style.appSidebarResizer} onMouseDown={startResizing} />}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
