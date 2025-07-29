import LoadingScreen from "@/components/ui/loading-screen";
import React, { useLayoutEffect, useRef } from "react";
import { ScrollArea } from "../components/ui/scroll-area";
import { cn } from "../lib/utils";
import { useEditor } from "./useEditor";

interface ScrollableEditorProps {
  path: string;
  className?: string;
}

export const ScrollableEditor: React.FC<ScrollableEditorProps> = ({
  path,
  className = "",
}) => {
  const { canvasRef, updateViewport, documentHeight, isInitialized, viewport } =
    useEditor(path);

  // Ref to the wrapper div to observe its size
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Keep the viewport dimensions in sync with the wrapper size
  useLayoutEffect(() => {
    if (!wrapperRef.current) return;

    function syncSize() {
      const rect = wrapperRef.current!.getBoundingClientRect();
      updateViewport({
        width: rect.width,
        height: rect.height,
      });
    }

    // Initial sync
    syncSize();

    const resizeObserver = new ResizeObserver(() => syncSize());
    resizeObserver.observe(wrapperRef.current);

    return () => resizeObserver.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [updateViewport]);
  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const { scrollTop, clientWidth, clientHeight } = e.currentTarget;

    updateViewport({
      scrollY: scrollTop,
      width: clientWidth,
      height: clientHeight,
    });
  };

  return (
    <div ref={wrapperRef} className={cn("relative w-full h-full", className)}>
      {/* Loading overlay */}
      {!isInitialized && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/60 backdrop-blur-sm">
          <LoadingScreen />
        </div>
      )}

      {/* Scrollable canvas area */}
      <ScrollArea onScroll={handleScroll} className="h-full">
        <div style={{ height: documentHeight }} className="relative">
          <canvas
            ref={canvasRef}
            style={{
              height: viewport.height,
              width: viewport.width,
            }}
            className="sticky top-0 left-0 cursor-text w-full"
            width={Math.max(viewport.width, 1)}
            height={Math.max(viewport.height, 1)}
          />
        </div>
      </ScrollArea>
    </div>
  );
};
