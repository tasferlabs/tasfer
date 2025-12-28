import LoadingScreen from "@/components/ui/loading-screen";
import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn, shallowEqual } from "../lib/utils";
import { mountEditor, type MountedEditor } from "../editor/mount";
import type { EditorState, SlashCommand } from "../editor/types";
import { SlashCommandMenu } from "../editor/SlashCommandMenu";
import { ContextMenu, type ContextMenuItem } from "../editor/ContextMenu";
import { getSelectionRange } from "../editor/commands";
import { Clipboard, Copy, Scissors } from "lucide-react";
import { hasNativeBridge } from "../editor/clipboard";

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

  const [contextMenuState, setContextMenuState] = useState<{
    x: number;
    y: number;
    hasSelection: boolean;
  } | null>(null);

  const lastSlashMenuStateRef = useRef<typeof slashMenuState>(null);
  const lastContextMenuStateRef = useRef<typeof contextMenuState>(null);

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

    // Subscribe to editor state changes for slash command and context menu
    const handleStateChange = (state: EditorState) => {
      // Calculate new slash command state
      let newSlashState: typeof slashMenuState = null;
      if (state.slashCommand && state.cursor) {
        const cursorScreenPos = mounted.editor.getCursorScreenPosition();

        if (cursorScreenPos) {
          const containerRect = wrapperRef.current?.getBoundingClientRect();
          if (containerRect) {
            const x = containerRect.left + cursorScreenPos.x;
            const y =
              containerRect.top + cursorScreenPos.y + cursorScreenPos.height;

            newSlashState = {
              visible: true,
              x,
              y,
              selectedIndex: state.slashCommand.selectedIndex,
              filter: state.slashCommand.filter,
            };
          }
        }
      }

      // Only update if changed
      if (!shallowEqual(newSlashState, lastSlashMenuStateRef.current)) {
        lastSlashMenuStateRef.current = newSlashState;
        setSlashMenuState(newSlashState);
      }

      // Calculate new context menu state
      let newContextMenuState: typeof contextMenuState = null;
      if (state.contextMenu) {
        const containerRect = wrapperRef.current?.getBoundingClientRect();
        if (containerRect) {
          const hasSelection = !!getSelectionRange(state);
          newContextMenuState = {
            x: containerRect.left + state.contextMenu.x,
            y: containerRect.top + state.contextMenu.y,
            hasSelection,
          };
        }
      }

      // Only update if changed
      if (
        !shallowEqual(newContextMenuState, lastContextMenuStateRef.current)
      ) {
        lastContextMenuStateRef.current = newContextMenuState;
        setContextMenuState(newContextMenuState);
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
      setSlashMenuState(null);
      lastSlashMenuStateRef.current = null;
    }
  };

  const handleContextMenuAction = async (action: string) => {
    if (!mountedRef.current) return;

    const editor = mountedRef.current.editor;
    switch (action) {
      case "copy":
        await editor.copy();
        break;
      case "cut":
        await editor.cut();
        break;
      case "paste":
        await editor.paste();
        break;
    }
    setContextMenuState(null);
    lastContextMenuStateRef.current = null;
  };

  const getContextMenuItems = (): ContextMenuItem[] => {
    const hasSelection = contextMenuState?.hasSelection ?? false;
    const canPaste = hasNativeBridge();

    const items: ContextMenuItem[] = [
      {
        id: "copy",
        label: "Copy",
        icon: <Copy size={16} />,
        action: () => handleContextMenuAction("copy"),
        disabled: !hasSelection,
      },
      {
        id: "cut",
        label: "Cut",
        icon: <Scissors size={16} />,
        action: () => handleContextMenuAction("cut"),
        disabled: !hasSelection,
      },
    ];

    if (canPaste) {
      items.push({
        id: "paste",
        label: "Paste",
        icon: <Clipboard size={16} />,
        action: () => handleContextMenuAction("paste"),
      });
    }

    return items;
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

      {/* Context menu portal */}
      {contextMenuState && (
        <ContextMenu
          x={contextMenuState.x}
          y={contextMenuState.y}
          items={getContextMenuItems()}
          onClose={() => {
            setContextMenuState(null);
            lastContextMenuStateRef.current = null;
          }}
          collisionBoundary={mountedRef.current?.portalContainer}
          container={mountedRef.current?.portalContainer}
        />
      )}
    </div>
  );
};
