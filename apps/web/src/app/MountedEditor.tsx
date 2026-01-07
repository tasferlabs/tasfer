import { Button } from "@/components/ui/button";
import {
  Clipboard,
  Copy,
  Image as ImageIcon,
  Scissors,
  Type,
} from "lucide-react";
import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { serializeToMarkdown } from "../deserializer/serializer";
import { ContextMenu, type ContextMenuItem } from "../editor/ContextMenu";
import { ImageUploadPopover } from "../editor/ImageUploadPopover";
import { LinkDrawer } from "../editor/LinkDrawer";
import { LinkEditPopover } from "../editor/LinkEditPopover";
import { LinkTooltip } from "../editor/LinkTooltip";
import { SlashCommandMenu } from "../editor/SlashCommandMenu";
import { hasNativeBridge } from "../editor/clipboard";
import { getSelectionRange } from "../editor/commands";
import { getBlockTextContent } from "../editor/state";
import {
  mountEditor,
  type MountedEditor as MountedEditorInstance,
} from "../editor/mount";
import { clearFailedImageCache } from "../editor/renderer";
import { getLinkAtPosition } from "../editor/selection";
import type { EditorState, SlashCommand } from "../editor/types";
import { cn, shallowEqual } from "../lib/utils";
import { uploadImage } from "./api/images.api";

interface MountedEditorProps {
  content: string;
  className?: string;
  onContentChange?: (content: string) => void;
  autoFocus?: boolean;
}

export const MountedEditor: React.FC<MountedEditorProps> = ({
  content,
  className = "",
  onContentChange,
  autoFocus = false,
}) => {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef<MountedEditorInstance | null>(null);
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
    hoveredItemId?: string | null;
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

  const [imageUploadState, setImageUploadState] = useState<{
    x: number;
    y: number;
    blockIndex: number;
    uploadStatus: "idle" | "uploading" | "complete" | "error";
  } | null>(null);

  const [imageHoverState, setImageHoverState] = useState<{
    x: number;
    y: number;
    width: number;
    height: number;
    blockIndex: number;
    hoveredHandle: "left" | "right" | "bottom" | null;
  } | null>(null);

  const lastImageHoverStateRef = useRef<typeof imageHoverState>(null);
  const persistedImageHoverRef = useRef<typeof imageHoverState>(null);

  const lastSlashMenuStateRef = useRef<typeof slashMenuState>(null);
  const lastContextMenuStateRef = useRef<typeof contextMenuState>(null);
  const lastLinkTooltipStateRef = useRef<typeof linkTooltipState>(null);
  const linkEditActionPerformedRef = useRef(false);
  const lastSerializedBlocksRef = useRef<
    EditorState["document"]["page"]["blocks"] | null
  >(null);
  const editorInitializedRef = useRef(false);

  // Track current toolbar icon type
  const currentIconTypeRef = useRef<"link" | "image" | "format">("format");

  // Native drawer states (triggered by format button on mobile)
  const [nativeLinkDrawerState, setNativeLinkDrawerState] = useState<{
    x: number;
    y: number;
    url?: string;
    linkText?: string;
    selectedText?: string;
    blockIndex?: number;
    segmentIndex?: number;
    startTextIndex?: number;
    endTextIndex?: number;
  } | null>(null);

  const [nativeImageDrawerState, setNativeImageDrawerState] = useState<{
    x: number;
    y: number;
    blockIndex: number;
  } | null>(null);

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

    // Handle format button clicks from native
    // Returns true if handled, false if native should open block menu
    const handleFormatButtonClick = (): boolean => {
      const state = mounted.editor.getState();
      if (!state) return false;

      const containerRect = wrapperRef.current?.getBoundingClientRect();
      if (!containerRect) return false;

      const iconType = currentIconTypeRef.current;

      if (iconType === "image") {
        // Open image drawer for selected image
        if (state.document.selection && !state.document.selection.isCollapsed) {
          const { anchor } = state.document.selection;
          const block = state.document.page.blocks[anchor.blockIndex];
          if (block && block.type === "image") {
            setNativeImageDrawerState({
              x: containerRect.left + containerRect.width / 2,
              y: containerRect.top + 100,
              blockIndex: anchor.blockIndex,
            });
            return true;
          }
        }
        return false;
      } else if (iconType === "link") {
        // Open link drawer for selected text or existing link
        if (state.document.cursor) {
          const linkData = getLinkAtPosition(state.document.cursor.position, state);
          
          if (linkData) {
            // Editing existing link
            setNativeLinkDrawerState({
              x: containerRect.left + containerRect.width / 2,
              y: containerRect.top + 100,
              url: linkData.url,
              linkText: linkData.text,
              blockIndex: state.document.cursor.position.blockIndex,
              segmentIndex: linkData.segmentIndex,
            });
            return true;
          } else if (state.document.selection && !state.document.selection.isCollapsed) {
            // Creating new link from selection
            const range = getSelectionRange(state);
            if (range) {
              const { start, end } = range;
              const block = state.document.page.blocks[start.blockIndex];
              if (block && block.type !== "image") {
                const text = getBlockTextContent(block);
                const selectedText = text.substring(start.textIndex, end.textIndex);
                
                setNativeLinkDrawerState({
                  x: containerRect.left + containerRect.width / 2,
                  y: containerRect.top + 100,
                  selectedText,
                  blockIndex: start.blockIndex,
                  startTextIndex: start.textIndex,
                  endTextIndex: end.textIndex,
                });
                return true;
              }
            }
          }
        }
        return false;
      }
      
      // For "format" icon type, let native handle it (open block menu)
      return false;
    };

    // Expose editor methods to window for native bridges
    const editorMethods = {
      undo: () => mounted.editor.undo(),
      redo: () => mounted.editor.redo(),
      setBlockType: (type: string) => mounted.editor.setBlockType(type as any),
      focus: () => {
        mounted.editor.setFocus(true);
        mounted.editor.setInitialCursor();
      },
      onFormatButtonClick: handleFormatButtonClick,
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
          // console.log("currentBlocks", currentBlocks);
          const markdown = serializeToMarkdown(currentBlocks);
          onContentChange(markdown);
        }
      }

      // Calculate new slash command state
      let newSlashState: typeof slashMenuState = null;
      if (
        state.ui.activeMenu.type === "slashCommand" &&
        state.document.cursor
      ) {
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
              selectedIndex: state.ui.activeMenu.selectedIndex,
              filter: state.ui.activeMenu.filter,
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
      if (state.ui.activeMenu.type === "contextMenu") {
        const containerRect = wrapperRef.current?.getBoundingClientRect();
        if (containerRect) {
          const hasSelection = !!getSelectionRange(state);
          newContextMenuState = {
            x: containerRect.left + state.ui.activeMenu.x,
            y: containerRect.top + state.ui.activeMenu.y,
            hasSelection,
            hoveredItemId: state.ui.activeMenu.hoveredItemId,
          };
          
          // Handle drag-and-release selection
          if (state.ui.activeMenu.selectedItemId) {
            const selectedItemId = state.ui.activeMenu.selectedItemId;
            // Execute the action asynchronously to avoid state mutation during render
            setTimeout(() => {
              handleContextMenuAction(selectedItemId);
            }, 0);
            // Close the menu immediately
            newContextMenuState = null;
          }
        }
      }

      // Only update if changed
      if (!shallowEqual(newContextMenuState, lastContextMenuStateRef.current)) {
        lastContextMenuStateRef.current = newContextMenuState;
        setContextMenuState(newContextMenuState);
      }

      // Calculate new link tooltip state
      let newLinkTooltipState: typeof linkTooltipState = null;
      if (state.ui.activeMenu.type === "linkHover") {
        newLinkTooltipState = {
          x: state.ui.activeMenu.x,
          y: state.ui.activeMenu.y,
          url: state.ui.activeMenu.url,
          text: state.ui.activeMenu.text,
        };
      }

      // Only update if changed
      if (!shallowEqual(newLinkTooltipState, lastLinkTooltipStateRef.current)) {
        lastLinkTooltipStateRef.current = newLinkTooltipState;
        setLinkTooltipState(newLinkTooltipState);
      }

      // Calculate new image upload state
      if (state.ui.activeMenu.type === "imageUpload") {
        const containerRect = wrapperRef.current?.getBoundingClientRect();
        if (containerRect) {
          setImageUploadState({
            x: containerRect.left + state.ui.activeMenu.x,
            y: containerRect.top + state.ui.activeMenu.y,
            blockIndex: state.ui.activeMenu.blockIndex,
            uploadStatus: state.ui.activeMenu.uploadStatus || "idle",
          });
        }
      } else if (imageUploadState) {
        setImageUploadState(null);
      }

      // Calculate new image hover state
      let newImageHoverState: typeof imageHoverState = null;
      // Don't show hover button when dragging an image
      if (state.ui.imageHover && !state.ui.imageDrag) {
        newImageHoverState = {
          x: state.ui.imageHover.x,
          y: state.ui.imageHover.y,
          width: state.ui.imageHover.width,
          height: state.ui.imageHover.height,
          blockIndex: state.ui.imageHover.blockIndex,
          hoveredHandle: state.ui.imageHover.hoveredHandle,
        };
        // Persist this state for when the menu transitions
        persistedImageHoverRef.current = newImageHoverState;
      }

      // Clear hover state when dragging
      if (state.ui.imageDrag) {
        newImageHoverState = null;
      }

      // Only update if changed
      if (!shallowEqual(newImageHoverState, lastImageHoverStateRef.current)) {
        lastImageHoverStateRef.current = newImageHoverState;
        setImageHoverState(newImageHoverState);
      }

      // Clear persisted state when image upload closes
      if (state.ui.activeMenu.type !== "imageUpload") {
        persistedImageHoverRef.current = null;
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

      // Update toolbar icon based on selection state
      const determineToolbarIcon = (): "link" | "image" | "format" => {
        // Check if an image block is selected
        if (state.document.selection && !state.document.selection.isCollapsed) {
          const { anchor, focus } = state.document.selection;
          // If selection is on a single block
          if (anchor.blockIndex === focus.blockIndex) {
            const block = state.document.page.blocks[anchor.blockIndex];
            if (block && block.type === "image") {
              return "image";
            }
          }
        }

        // Check if cursor is in a link or text is selected
        if (state.document.cursor) {
          const linkData = getLinkAtPosition(state.document.cursor.position, state);
          if (linkData) {
            return "link";
          }
        }

        // Check if there's a text selection (show link icon to allow creating links)
        if (state.document.selection && !state.document.selection.isCollapsed) {
          const range = getSelectionRange(state);
          if (range) {
            const { start } = range;
            // If selection is in a text block, show link icon
            const block = state.document.page.blocks[start.blockIndex];
            if (block && block.type !== "image") {
              return "link";
            }
          }
        }

        return "format";
      };

      const iconType = determineToolbarIcon();

      // Update the ref so format button handler knows current icon
      currentIconTypeRef.current = iconType;

      if (window.IOSBridge) {
        window.IOSBridge.postMessage({
          action: "toolbar-icon",
          iconType,
        });
      }

      if (window.AndroidBridge) {
        window.AndroidBridge.updateToolbarIcon?.(iconType);
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
      mountedRef.current.editor.closeActiveMenu();
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

  // Set editor to locked mode when link edit or image upload popover is open
  useEffect(() => {
    if (!mountedRef.current?.editor) return;

    const currentState = mountedRef.current.editor.getState();
    if (!currentState) return;

    if (linkEditState || imageUploadState) {
      // Set editor to locked mode when popover opens (only if not already locked)
      if (currentState.ui.mode !== "locked") {
        mountedRef.current.editor.setMode("locked");
      }
    } else {
      // Restore to edit mode when popover closes (only if currently locked)
      if (currentState.ui.mode === "locked") {
        mountedRef.current.editor.setMode("edit");
      }
    }
  }, [linkEditState, imageUploadState]);

  const handleLinkEdit = () => {
    if (!linkTooltipState || !mountedRef.current) return;

    const state = mountedRef.current.editor.getState();
    if (!state) return;

    if (state.ui.activeMenu.type === "linkHover") {
      const containerRect = wrapperRef.current?.getBoundingClientRect();
      if (containerRect) {
        // Save current cursor and selection before clearing
        const savedCursor = state.document.cursor;
        const savedSelection = state.document.selection;

        // Clear selection and cursor when opening link editor
        mountedRef.current.editor.clearSelection();

        // Reset the action flag when opening
        linkEditActionPerformedRef.current = false;

        // Get link data from activeMenu
        const linkData = state.ui.activeMenu;

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
    mountedRef.current.editor.closeActiveMenu();
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
            if (!mountedRef.current) return;
            mountedRef.current.editor.closeActiveMenu();
            setContextMenuState(null);
            lastContextMenuStateRef.current = null;
          }}
          collisionBoundary={mountedRef.current?.portalContainer}
          container={mountedRef.current?.portalContainer}
          hoveredItemId={contextMenuState.hoveredItemId}
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

      {/* Image upload popover */}
      {imageUploadState &&
        mountedRef.current?.portalContainer &&
        createPortal(
          <ImageUploadPopover
            x={imageUploadState.x}
            y={imageUploadState.y}
            uploadStatus={imageUploadState.uploadStatus}
            onUpload={async (file) => {
              if (!mountedRef.current) return;
              const editor = mountedRef.current.editor;
              const state = editor.getState();
              if (!state) return;

              // Get current block to check if there's an existing URL to clear from failed cache
              const block =
                state.document.page.blocks[imageUploadState.blockIndex];
              if (block && block.type === "image" && block.url) {
                clearFailedImageCache(block.url);
              }

              // Set uploading status
              editor.updateImageBlock(
                imageUploadState.blockIndex,
                {},
                "uploading"
              );

              try {
                // Upload the image
                const imageData = await uploadImage(file);

                // Update with the uploaded URL
                editor.updateImageBlock(
                  imageUploadState.blockIndex,
                  {
                    url: imageData.url,
                    alt: imageData.fileName,
                  },
                  "complete"
                );
              } catch (error) {
                console.error("Image upload failed:", error);
                editor.updateImageBlock(
                  imageUploadState.blockIndex,
                  {},
                  "error"
                );
              }
            }}
            onUrlSubmit={(url) => {
              if (!mountedRef.current) return;
              const editor = mountedRef.current.editor;

              // Clear failed cache for this URL to allow retry
              clearFailedImageCache(url);

              editor.updateImageBlock(
                imageUploadState.blockIndex,
                { url },
                "complete"
              );
            }}
            onDelete={() => {
              if (!mountedRef.current) return;
              setImageUploadState(null);
            }}
            onClose={() => {
              if (!mountedRef.current) return;
              // Clear the menu state in the editor
              mountedRef.current.editor.closeActiveMenu();
              setImageUploadState(null);
            }}
            collisionBoundary={mountedRef.current?.portalContainer}
            container={mountedRef.current?.portalContainer}
          />,
          mountedRef.current.portalContainer
        )}

      {/* Image hover edit button overlay */}
      {(imageHoverState ||
        imageUploadState ||
        persistedImageHoverRef.current) &&
        mountedRef.current?.portalContainer &&
        (() => {
          // Use imageHoverState if available, otherwise use persisted state or reconstruct from imageUploadState
          const displayState =
            imageHoverState ||
            persistedImageHoverRef.current ||
            (imageUploadState
              ? {
                  x:
                    imageUploadState.x -
                    (wrapperRef.current?.getBoundingClientRect().left || 0),
                  y:
                    imageUploadState.y -
                    (wrapperRef.current?.getBoundingClientRect().top || 0),
                  width: wrapperRef.current?.offsetWidth || 0,
                  height: 300, // Default image height
                  blockIndex: imageUploadState.blockIndex,
                  hoveredHandle: null,
                }
              : null);

          if (!displayState) return null;

          const state = mountedRef.current?.editor.getState();
          if (!state) return null;

          const block = state.document.page.blocks[displayState.blockIndex];
          if (block?.type !== "image") return null;

          // Check if the image is in placeholder mode (no URL)
          const isPlaceholder = !block.url;

          // Don't show the overlay for placeholder mode (no Edit Image button)
          if (isPlaceholder) return null;

          return createPortal(
            <div
              style={{
                position: "absolute",
                left: `${displayState.x}px`,
                top: `${displayState.y}px`,
                width: `${displayState.width}px`,
                height: `${displayState.height}px`,
                pointerEvents: "none",
                overflow: "hidden",
                zIndex: 10,
              }}
            >
              <div
                style={{
                  position: "absolute",
                  right: "8px",
                  top: "8px",
                  pointerEvents: "auto",
                }}
              >
                <Button
                  variant="outline"
                  size="sm"
                  onClick={(e) => {
                    if (!mountedRef.current) return;
                    const state = mountedRef.current.editor.getState();
                    if (!state) return;

                    const block =
                      state.document.page.blocks[displayState.blockIndex];
                    if (block.type === "image") {
                      // Get button position to open popover below it
                      const buttonRect =
                        e.currentTarget.getBoundingClientRect();
                      const containerRect =
                        wrapperRef.current?.getBoundingClientRect();

                      if (containerRect) {
                        // Convert button position to canvas-relative coordinates
                        const canvasX = buttonRect.left - containerRect.left;
                        const canvasY = buttonRect.bottom - containerRect.top;

                        // Open the image upload/edit popover
                        mountedRef.current.editor.openImageUploadMenu(
                          displayState.blockIndex,
                          canvasX,
                          canvasY,
                          block.url || undefined,
                          block.alt || undefined
                        );
                      }
                    }
                  }}
                  onMouseDown={(e) => {
                    // Prevent button from taking focus away from hidden input
                    e.preventDefault();
                  }}
                >
                  <ImageIcon className="size-4" />
                  <span className="text-xs">Edit Image</span>
                </Button>
              </div>
            </div>,
            mountedRef.current.portalContainer
          );
        })()}

      {/* Native Link Drawer (triggered by format button on mobile) */}
      {nativeLinkDrawerState &&
        mountedRef.current?.portalContainer &&
        createPortal(
          <LinkDrawer
            x={nativeLinkDrawerState.x}
            y={nativeLinkDrawerState.y}
            url={nativeLinkDrawerState.url}
            linkText={nativeLinkDrawerState.linkText}
            selectedText={nativeLinkDrawerState.selectedText}
            onUpdate={(newUrl, newText) => {
              if (!mountedRef.current) return;
              const editor = mountedRef.current.editor;
              
              if (nativeLinkDrawerState.blockIndex !== undefined && 
                  nativeLinkDrawerState.segmentIndex !== undefined) {
                // Update existing link
                editor.updateLink(
                  nativeLinkDrawerState.blockIndex,
                  nativeLinkDrawerState.segmentIndex,
                  newUrl,
                  newText
                );
              } else if (
                nativeLinkDrawerState.blockIndex !== undefined && 
                nativeLinkDrawerState.startTextIndex !== undefined && 
                nativeLinkDrawerState.endTextIndex !== undefined
              ) {
                // Create new link from selection - restore selection first
                const blockIndex = nativeLinkDrawerState.blockIndex;
                const startTextIndex = nativeLinkDrawerState.startTextIndex;
                const endTextIndex = nativeLinkDrawerState.endTextIndex;
                
                // Restore the selection by creating it programmatically
                const anchor = { blockIndex, textIndex: startTextIndex };
                const focus = { blockIndex, textIndex: endTextIndex };
                
                editor.restoreCursorAndSelection(
                  { position: focus, lastUpdate: Date.now() },
                  { anchor, focus, isForward: true, isCollapsed: false, lastUpdate: Date.now() }
                );
                
                // Now create the link with the restored selection
                editor.createLink(newUrl, newText);
              }
              setNativeLinkDrawerState(null);
            }}
            onClear={
              nativeLinkDrawerState.url
                ? () => {
                    if (!mountedRef.current) return;
                    const editor = mountedRef.current.editor;
                    if (nativeLinkDrawerState.blockIndex !== undefined && 
                        nativeLinkDrawerState.segmentIndex !== undefined) {
                      editor.clearLink(
                        nativeLinkDrawerState.blockIndex,
                        nativeLinkDrawerState.segmentIndex
                      );
                    }
                    setNativeLinkDrawerState(null);
                  }
                : undefined
            }
            onClose={() => setNativeLinkDrawerState(null)}
            collisionBoundary={mountedRef.current?.portalContainer}
            container={mountedRef.current?.portalContainer}
          />,
          mountedRef.current.portalContainer
        )}

      {/* Native Image Drawer (triggered by format button on mobile) */}
      {nativeImageDrawerState &&
        mountedRef.current?.portalContainer &&
        createPortal(
          <ImageUploadPopover
            x={nativeImageDrawerState.x}
            y={nativeImageDrawerState.y}
            uploadStatus="idle"
            onUpload={async (file) => {
              if (!mountedRef.current) return;
              const editor = mountedRef.current.editor;
              const state = editor.getState();
              if (!state) return;

              const block =
                state.document.page.blocks[nativeImageDrawerState.blockIndex];
              if (block && block.type === "image" && block.url) {
                clearFailedImageCache(block.url);
              }

              editor.updateImageBlock(
                nativeImageDrawerState.blockIndex,
                {},
                "uploading"
              );

              try {
                const imageData = await uploadImage(file);
                editor.updateImageBlock(
                  nativeImageDrawerState.blockIndex,
                  {
                    url: imageData.url,
                    alt: imageData.fileName,
                  },
                  "complete"
                );
              } catch (error) {
                console.error("Image upload failed:", error);
                editor.updateImageBlock(
                  nativeImageDrawerState.blockIndex,
                  {},
                  "error"
                );
              }
            }}
            onUrlSubmit={(url) => {
              if (!mountedRef.current) return;
              const editor = mountedRef.current.editor;
              editor.updateImageBlock(nativeImageDrawerState.blockIndex, {
                url,
              });
            }}
            onDelete={() => {
              if (!mountedRef.current) return;
              const editor = mountedRef.current.editor;
              editor.deleteImageBlock(nativeImageDrawerState.blockIndex);
              setNativeImageDrawerState(null);
            }}
            onClose={() => setNativeImageDrawerState(null)}
            collisionBoundary={mountedRef.current?.portalContainer}
            container={mountedRef.current?.portalContainer}
          />,
          mountedRef.current.portalContainer
        )}
    </div>
  );
};
