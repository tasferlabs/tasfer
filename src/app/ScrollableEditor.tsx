import LoadingScreen from "@/components/ui/loading-screen";
import React, { useEffect, useRef } from "react";
import { cn } from "../lib/utils";
import { mountEditor, type MountedEditor } from "../editor/mount";

interface ScrollableEditorProps {
  path: string;
  className?: string;
}

export const ScrollableEditor: React.FC<ScrollableEditorProps> = ({
  path,
  className = "",
}) => {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef<MountedEditor | null>(null);

  // Imperatively mount/unmount editor (no React state needed)
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;

    // Clean up any previous mount (e.g., path changes, strict mode re-mount)
    if (mountedRef.current) {
      mountedRef.current.destroy();
      mountedRef.current = null;
    }

    // Show overlay until ready
    if (overlayRef.current) {
      overlayRef.current.style.display = "";
      overlayRef.current.removeAttribute("aria-hidden");
    }

    const mounted = mountEditor(el, { path });
    mountedRef.current = mounted;

    mounted.ready.finally(() => {
      // Hide overlay when loaded + started (or if load fails)
      if (overlayRef.current) {
        overlayRef.current.style.display = "none";
        overlayRef.current.setAttribute("aria-hidden", "true");
      }
    });

    return () => {
      mounted.destroy();
      if (mountedRef.current === mounted) {
        mountedRef.current = null;
      }
    };
  }, [path]);

  return (
    <div
      ref={wrapperRef}
      className={cn("relative w-full h-full overflow-hidden", className)}
      role="textbox"
      aria-label="Text editor"
      aria-multiline="true"
      tabIndex={-1}
    >
      {/* Loading overlay */}
      <div
        ref={overlayRef}
        className="absolute inset-0 z-10 flex items-center justify-center bg-background/60 backdrop-blur-sm"
      >
        <LoadingScreen />
      </div>
    </div>
  );
};
