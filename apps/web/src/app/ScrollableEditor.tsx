import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn, shallowEqual } from "../lib/utils";
import {
  mountEditor,
  type MountedEditor,
} from "../editor/mount";
import type { EditorState, SlashCommand } from "../editor/types";
import { SlashCommandMenu } from "../editor/SlashCommandMenu";
import { ContextMenu, type ContextMenuItem } from "../editor/ContextMenu";
import { LinkTooltip } from "../editor/LinkTooltip";
import { LinkEditPopover } from "../editor/LinkEditPopover";
import { getSelectionRange } from "../editor/commands";
import { Clipboard, Copy, Scissors, Type } from "lucide-react";
import { hasNativeBridge } from "../editor/clipboard";
import { serializeToMarkdown } from "../deserializer/serializer";

interface ScrollableEditorProps {
  content: string;
  className?: string;
  onContentChange?: (content: string) => void;
  autoFocus?: boolean;
}

export const ScrollableEditor: React.FC<ScrollableEditorProps> = ({
  content,
  className = "",
  onContentChange,
  autoFocus = false,
}) => {
  const wrapperRef = useRef<HTMLDivElement>(null);
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

  const [linkTooltipState, setLinkTooltipState] = useState<{
    x: number;
    y: number;
    url: string;
    text: string;
  } | null>(null);

  const [linkEditState, setLinkEditState] = useState<{
    x: number;
    y: number;
    url: string;
    text: string;
    blockIndex: number;
    segmentIndex: number;
    savedCursor: EditorState["document"]["cursor"];
    savedSelection: EditorState["document"]["selection"];
  } | null>(null);

  const lastSlashMenuStateRef = useRef<typeof slashMenuState>(null);
  const lastContextMenuStateRef = useRef<typeof contextMenuState>(null);
  const lastLinkTooltipStateRef = useRef<typeof linkTooltipState>(null);
  const linkEditActionPerformedRef = useRef(false);
  const lastSerializedBlocksRef = useRef<EditorState["document"]["page"]["blocks"] | null>(null);
  const editorInitializedRef = useRef(false);

  // Imperatively mount/unmount editor (no React state needed)
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;

    // Clean up any previous mount (e.g., content changes, strict mode re-mount)
    if (mountedRef.current) {
      mountedRef.current.destroy();
      mountedRef.current = null;
    }

    // Reset serialization tracking and initialization flag when content changes
    lastSerializedBlocksRef.current = null;
    editorInitializedRef.current = false;

    const mounted = mountEditor(el, content);
    mountedRef.current = mounted;

    // Expose editor methods to window for native bridges
    const editorMethods = {
      undo: () => mounted.editor.undo(),
      redo: () => mounted.editor.redo(),
      setBlockType: (type: string) => mounted.editor.setBlockType(type as any),
      focus: () => {
        mounted.editor.setFocus(true);
        mounted.editor.setInitialCursor();
      },
    };

    if (window.IOSBridge) {
      Object.assign(window.IOSBridge, editorMethods);
    }

    if (window.AndroidBridge) {
      Object.assign(window.AndroidBridge, editorMethods);
    }

    // Subscribe to editor state changes for slash command and context menu
    const handleStateChange = (state: EditorState) => {
      // Notify parent of content changes if callback is provided
      // Only serialize when blocks actually change (not on cursor blink, UI changes, etc.)
      if (onContentChange && state.document.page?.blocks) {
        const currentBlocks = state.document.page.blocks;
        
        // On first state change, just store the initial blocks without triggering onContentChange
        // This prevents the editor from overwriting backend content with empty state on mount
        if (!editorInitializedRef.current) {
          lastSerializedBlocksRef.current = currentBlocks;
          editorInitializedRef.current = true;
          return;
        }
        
        // Check if blocks reference has changed (indicates actual content modification)
        if (currentBlocks !== lastSerializedBlocksRef.current) {
          lastSerializedBlocksRef.current = currentBlocks;
          const markdown = serializeToMarkdown(currentBlocks);
          onContentChange(markdown);
        }
      }

      // Calculate new slash command state
      let newSlashState: typeof slashMenuState = null;
      if (state.ui.slashCommand && state.document.cursor) {
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
              selectedIndex: state.ui.slashCommand.selectedIndex,
              filter: state.ui.slashCommand.filter,
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
      if (state.ui.contextMenu) {
        const containerRect = wrapperRef.current?.getBoundingClientRect();
        if (containerRect) {
          const hasSelection = !!getSelectionRange(state);
          newContextMenuState = {
            x: containerRect.left + state.ui.contextMenu.x,
            y: containerRect.top + state.ui.contextMenu.y,
            hasSelection,
          };
        }
      }

      // Only update if changed
      if (!shallowEqual(newContextMenuState, lastContextMenuStateRef.current)) {
        lastContextMenuStateRef.current = newContextMenuState;
        setContextMenuState(newContextMenuState);
      }

      // Calculate new link tooltip state
      let newLinkTooltipState: typeof linkTooltipState = null;
      if (state.ui.linkHover) {
        newLinkTooltipState = {
          x: state.ui.linkHover.x,
          y: state.ui.linkHover.y,
          url: state.ui.linkHover.url,
          text: state.ui.linkHover.text,
        };
      }

      // Only update if changed
      if (!shallowEqual(newLinkTooltipState, lastLinkTooltipStateRef.current)) {
        lastLinkTooltipStateRef.current = newLinkTooltipState;
        setLinkTooltipState(newLinkTooltipState);
      }

      // Send undo/redo state to native bridge
      if (window.IOSBridge) {
        window.IOSBridge.postMessage({
          action: "undo-redo-state",
          canUndo: state.undoManager.undoStack.length > 0,
          canRedo: state.undoManager.redoStack.length > 0,
        });
      }

      if (window.AndroidBridge) {
        window.AndroidBridge.updateUndoRedoState?.(
          state.undoManager.undoStack.length > 0,
          state.undoManager.redoStack.length > 0
        );
      }
    };

    const unsubscribe = mounted.editor.subscribe(handleStateChange);

    // Auto-focus the editor when requested
    if (autoFocus) {
      // Use a small timeout to ensure the editor is fully initialized
      setTimeout(() => {
        mounted.editor.setFocus(true);
        // Also set initial cursor position to make editor immediately usable
        mounted.editor.setInitialCursor();
      }, 0);
    }

    return () => {
      unsubscribe();
      mounted.destroy();
      // Cleanup bridge
      if (window.IOSBridge) {
        window.IOSBridge.undo = undefined;
        window.IOSBridge.redo = undefined;
        window.IOSBridge.setBlockType = undefined;
        window.IOSBridge.focus = undefined;
      }
      if (window.AndroidBridge) {
        delete window.AndroidBridge.undo;
        delete window.AndroidBridge.redo;
        delete window.AndroidBridge.setBlockType;
        delete window.AndroidBridge.focus;
      }
      if (mountedRef.current === mounted) {
        mountedRef.current = null;
      }
    };
  }, [content, onContentChange, autoFocus]);

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
      case "selectAll":
        editor.selectAll();
        break;
    }
  };

  const getContextMenuItems = (): ContextMenuItem[] => {
    const hasSelection = contextMenuState?.hasSelection ?? false;
    const canPaste = hasNativeBridge();

    const items: ContextMenuItem[] = [
      {
        id: "selectAll",
        label: "Select All",
        icon: <Type size={16} />,
        action: () => handleContextMenuAction("selectAll"),
      },
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

  // Set editor to readonly mode when link edit popover is open
  useEffect(() => {
    if (!mountedRef.current?.editor) return;

    if (linkEditState) {
      // Set editor to readonly mode when popover opens
      mountedRef.current.editor.setMode("locked");
    } else {
      // Restore to edit mode when popover closes
      const currentState = mountedRef.current.editor.getState();
      if (currentState?.ui.mode === "locked") {
        mountedRef.current.editor.setMode("edit");
      }
    }
  }, [linkEditState]);

  const handleLinkEdit = () => {
    if (!linkTooltipState || !mountedRef.current) return;

    const state = mountedRef.current.editor.getState();
    if (!state) return;
    
    if (state.ui.linkHover) {
      const containerRect = wrapperRef.current?.getBoundingClientRect();
      if (containerRect) {
        // Save current cursor and selection before clearing
        const savedCursor = state.document.cursor;
        const savedSelection = state.document.selection;

        // Clear selection and cursor when opening link editor
        mountedRef.current.editor.clearSelection();

        // Reset the action flag when opening
        linkEditActionPerformedRef.current = false;

        // Get link data to find segment index
        const linkData = state.ui.linkHover;

        setLinkEditState({
          x: linkData.x,
          y: linkData.y,
          url: linkData.url,
          text: linkData.text,
          blockIndex: linkData.position.blockIndex,
          segmentIndex: linkData.segmentIndex,
          savedCursor,
          savedSelection,
        });
        setLinkTooltipState(null);
      }
    }
  };

  const handleLinkUpdate = (newUrl: string, newText: string) => {
    if (!linkEditState || !mountedRef.current) return;

    const editor = mountedRef.current.editor;
    editor.updateLink(
      linkEditState.blockIndex,
      linkEditState.segmentIndex,
      newUrl,
      newText
    );
    // Mark that an action was performed (don't restore selection on close)
    linkEditActionPerformedRef.current = true;
  };

  const handleLinkClear = () => {
    if (!linkEditState || !mountedRef.current) return;

    const editor = mountedRef.current.editor;
    editor.clearLink(linkEditState.blockIndex, linkEditState.segmentIndex);
    // Mark that an action was performed (don't restore selection on close)
    linkEditActionPerformedRef.current = true;
  };

  const handleLinkEditClose = () => {
    if (!linkEditState || !mountedRef.current) return;

    // Only restore the saved cursor and selection if no action was performed (i.e., user canceled)
    if (!linkEditActionPerformedRef.current) {
      mountedRef.current.editor.restoreCursorAndSelection(
        linkEditState.savedCursor,
        linkEditState.savedSelection
      );
    }

    setLinkEditState(null);
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

      {/* Link tooltip portal */}
      {linkTooltipState &&
        !linkEditState &&
        mountedRef.current?.portalContainer &&
        createPortal(
          <div
            style={{
              pointerEvents: "none",
              position: "fixed",
              inset: 0,
              zIndex: 50,
            }}
          >
            <LinkTooltip
              url={linkTooltipState.url}
              linkText={linkTooltipState.text}
              x={linkTooltipState.x}
              y={linkTooltipState.y}
              onOpen={() => {
                window.open(
                  linkTooltipState.url,
                  "_blank",
                  "noopener,noreferrer"
                );
              }}
              onEdit={handleLinkEdit}
            />
          </div>,
          mountedRef.current.portalContainer
        )}

      {/* Link edit popover */}
      {linkEditState &&
        mountedRef.current?.portalContainer &&
        createPortal(
          <LinkEditPopover
            x={linkEditState.x}
            y={linkEditState.y}
            url={linkEditState.url}
            linkText={linkEditState.text}
            onUpdate={handleLinkUpdate}
            onClear={handleLinkClear}
            onClose={handleLinkEditClose}
            collisionBoundary={mountedRef.current?.portalContainer}
            container={mountedRef.current?.portalContainer}
          />,
          mountedRef.current.portalContainer
        )}
    </div>
  );
};
