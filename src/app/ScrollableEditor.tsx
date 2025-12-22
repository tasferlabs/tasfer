import LoadingScreen from "@/components/ui/loading-screen";
import React, { useLayoutEffect, useRef } from "react";
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
  const { canvasRef, updateViewport, isInitialized, viewport } =
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
        scrollY: 0,
      });
    }

    // Initial sync
    syncSize();

    const resizeObserver = new ResizeObserver(() => syncSize());
    resizeObserver.observe(wrapperRef.current);

    return () => resizeObserver.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [updateViewport]);

  // Get device pixel ratio for high-DPI displays (iOS retina, etc.)
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;

  return (
    <div
      ref={wrapperRef}
      className={cn("relative w-full h-full overflow-hidden", className)}
    >
      {/* Loading overlay */}
      {!isInitialized && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/60 backdrop-blur-sm">
          <LoadingScreen />
        </div>
      )}

      {/* Canvas - now handles its own scrolling */}
      <canvas
        ref={canvasRef}
        style={{
          height: viewport?.height,
          width: viewport?.width,
        }}
        className="w-full h-full"
        width={Math.max((viewport?.width || 0) * dpr, 1)}
        height={Math.max((viewport?.height || 0) * dpr, 1)}
      />
    </div>
  );
};
