import React from "react";
import { Outlet } from "react-router-dom";
import useLocalStorage from "../hooks/useLocalStorage";
import useResponsive from "../hooks/useResponsive";
import style from "./Layout.module.css";
import { ResizableSidebar } from "./ResizableSidebar";
import { FloatingSidebar } from "./FloatingSidebar";
import { TopActionBar } from "./TopActionBar";

export default function Layout() {
  const [resizableOpen, setResizableOpen] = useLocalStorage(
    "resizable-sidebar-open",
    true
  );
  const [floatingOpen, setFloatingOpen] = React.useState(false);
  const isMobile = useResponsive("(max-width: 768px)");

  return (
    <div className={style.appContainer}>
      {isMobile ? (
        <FloatingSidebar open={floatingOpen} setOpen={setFloatingOpen} />
      ) : (
        <ResizableSidebar open={!!resizableOpen} setOpen={setResizableOpen} />
      )}

      <div className={style.appFrame}>
        <TopActionBar
          open={isMobile ? floatingOpen : !!resizableOpen}
          setOpen={isMobile ? setFloatingOpen : setResizableOpen}
        />
        {/* We remove ScrollArea here because ScrollableEditor handles its own scrolling */}
        <div className="flex-1 min-h-0 w-full">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
