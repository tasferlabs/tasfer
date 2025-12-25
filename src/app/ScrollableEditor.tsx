import LoadingScreen from "@/components/ui/loading-screen";
import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "../lib/utils";
import { mountEditor, type MountedEditor } from "../editor/mount";
import type { EditorState, SlashCommand } from "../editor/types";
import { SlashCommandMenu } from "../editor/SlashCommandMenu";

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
  const [slashMenuState, setSlashMenuState] = useState<{
    visible: boolean;
    x: number;
    y: number;
    selectedIndex: number;
    filter: string;
  } | null>(null);

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

    // Subscribe to editor state changes for slash command
    const handleStateChange = (state: EditorState) => {
      if (state.slashCommand && state.cursor) {
        const cursorScreenPos = mounted.editor.getCursorScreenPosition();

        if (cursorScreenPos) {
          const containerRect = wrapperRef.current?.getBoundingClientRect();
          if (containerRect) {
            // Convert canvas-relative coordinates to viewport-absolute coordinates
            const x = containerRect.left + cursorScreenPos.x;
            const y = containerRect.top + cursorScreenPos.y + cursorScreenPos.height;

            setSlashMenuState({
              visible: true,
              x,
              y,
              selectedIndex: state.slashCommand.selectedIndex,
              filter: state.slashCommand.filter,
            });
          }
        }
      } else {
        setSlashMenuState(null);
      }
    };

    const unsubscribe = mounted.editor.subscribe(handleStateChange);

    mounted.ready.finally(() => {
      // Hide overlay when loaded + started (or if load fails)
      if (overlayRef.current) {
        overlayRef.current.style.display = "none";
        overlayRef.current.setAttribute("aria-hidden", "true");
      }
    });

    return () => {
      unsubscribe();
      mounted.destroy();
      if (mountedRef.current === mounted) {
        mountedRef.current = null;
      }
    };
  }, [path]);

  const handleSlashCommandSelect = (command: SlashCommand) => {
    if (mountedRef.current) {
      mountedRef.current.editor.executeSlashCommand(command);
    }
  };

  const handleSlashCommandClose = () => {
    if (mountedRef.current) {
      // Trigger Escape to close
      setSlashMenuState(null);
    }
  };

  return (
    <div
      ref={wrapperRef}
      className={cn(
        "relative w-full h-full overflow-hidden focus:outline-none",
        className
      )}
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

      {/* Slash command menu portal */}
      {slashMenuState &&
        mountedRef.current?.portalContainer &&
        createPortal(
          <div style={{ pointerEvents: "auto" }}>
            <SlashCommandMenu
              x={slashMenuState.x}
              y={slashMenuState.y}
              selectedIndex={slashMenuState.selectedIndex}
              filter={slashMenuState.filter}
              onSelect={handleSlashCommandSelect}
              onClose={handleSlashCommandClose}
            />
          </div>,
          mountedRef.current.portalContainer
        )}
    </div>
  );
};
