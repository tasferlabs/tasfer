import React from "react";
import useLocalStorage from "../hooks/useLocalStorage";
import useResponsive from "../hooks/useResponsive";
import style from "./Layout.module.css";
import { ResizableSidebar } from "./ResizableSidebar";
import { TopActionBar } from "./TopActionBar";

export default function Layout({ children }: { children: React.ReactNode }) {
  const [resizableOpen, setResizableOpen] = useLocalStorage("resizable-sidebar-open", true);
  const isMobile = useResponsive("(max-width: 768px)");

  return (
    <div className={style.appContainer}>
       {!isMobile && (
          <ResizableSidebar 
            open={!!resizableOpen} 
            setOpen={setResizableOpen} 
          />
       )}
       
       <div className={style.appFrame}>
          <TopActionBar 
            open={!!resizableOpen} 
            setOpen={setResizableOpen} 
          />
          {/* We remove ScrollArea here because ScrollableEditor handles its own scrolling */}
          <div className="flex-1 min-h-0 w-full">
            {children}
          </div>
       </div>
    </div>
  );
}
