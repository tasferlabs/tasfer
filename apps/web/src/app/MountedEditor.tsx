import { Button } from "@/components/ui/button";
import {
  Bold,
  Clipboard,
  Code,
  Copy,
  Image as ImageIcon,
  Italic,
  Scissors,
  Strikethrough,
  Type,
} from "lucide-react";
import { useEffect, useRef, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import type { Block } from "../deserializer/loadPage";
import { ContextMenu, type ContextMenuItem } from "../editor/ContextMenu";
import { ImageUploadPopover } from "../editor/ImageUploadPopover";
import { LinkDrawer } from "../editor/LinkDrawer";
import { LinkEditPopover } from "../editor/LinkEditPopover";
import { LinkTooltip } from "../editor/LinkTooltip";
import { SlashCommandMenu } from "../editor/SlashCommandMenu";
import {
  getFormatsAtPosition,
  getSelectionRange,
} from "../editor/actions/commands";
import { allCharsHaveFormat } from "../editor/sync/crdt-helpers";
import { isTextualBlock } from "../deserializer/loadPage";
import {
  mountEditor,
  type MountedEditor as MountedEditorInstance,
} from "../editor/mount";
import { clearFailedImageCache } from "../editor/renderer";
import { getLinkAtPosition } from "../editor/selection";
import { getBlockTextContent, isTouchDevice } from "../editor/state";
import type { EditorState, SlashCommand, TextStyle } from "../editor/types";
import { cn, shallowEqual } from "../lib/utils";
import { uploadImage } from "./api/images.api";
import { useRoom, type SyncState } from "@/websocket/hooks/useRoom";
import { SyncEngine, type HLC, serializeVV, deserializeVV } from "@/editor/sync/sync";
import type { AwarenessState, AwarenessUser } from "@/editor/sync/awareness";
import type { Operation } from "@/websocket/types";
import { hasNativeBridge } from "@/editor/actions/clipboard";
import { OfflineStore } from "@/offline/store";

interface MountedEditorProps {
  snapshot: Block[];
  className?: string;
  /** Called when content changes. clock is the HLC of the latest operation. */
  onContentChange?: (snapshot: Block[], clock: HLC | null) => void;
  /** Callback for all content updates (local and remote) - used for word count, etc. */
  onContentUpdate?: (blocks: (Block & { originalIndex: number })[]) => void;
  autoFocus?: boolean;
  /** Unique page ID for CRDT sync - if provided, enables live collaboration */
  pageId: string;
  /** @deprecated WebSocket URL is now managed by WebSocketProvider */
  signalingUrl?: string;
  /** Callback when sync state changes */
  onSyncStateChange?: (state: SyncState) => void;
  /** Clock of the snapshot - used for delta sync */
  snapshotClock?: HLC | null;
  /** Callback to update snapshotClock after operations are sent */
  onSnapshotClockUpdate?: (clock: HLC | null) => void;
  /** Callback when active users change */
  onAwarenessChange?: (users: AwarenessUser[]) => void;
  /** Callback when restore function is ready */
  onRestoreReady?: (restoreFn: (blocks: Block[]) => void) => void;
  /** Callback when confirmSave function is ready - call this after backend save succeeds */
  onConfirmSaveReady?: (confirmFn: (clock: HLC) => void) => void;
  /** When true, editor is read-only - no editing, no CRDT sync, no native bridge updates */
  readonly?: boolean;
  /** Override default canvas padding */
  padding?: Partial<{
    paddingTop: number;
    paddingBottom: number;
    paddingLeft: number;
    paddingRight: number;
  }>;
  /** Override block text styles (e.g. heading font sizes) */
  blockStyleOverrides?: Partial<Record<string, Partial<TextStyle>>> | null;
  /** Callback when canvas scroll position changes */
  onScroll?: (scrollY: number) => void;
}

export function MountedEditor({
  snapshot,
  className = "",
  onContentChange,
  onContentUpdate,
  autoFocus = false,
  pageId,
  signalingUrl: _signalingUrl,
  onSyncStateChange,
  snapshotClock,
  onSnapshotClockUpdate,
  onAwarenessChange,
  onRestoreReady,
  onConfirmSaveReady,
  readonly = false,
  padding,
  blockStyleOverrides,
  onScroll,
}: MountedEditorProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef<MountedEditorInstance | null>(null);
  const syncEngineRef = useRef<SyncEngine | null>(null);
  const offlineStoreRef = useRef<OfflineStore | null>(null);
  const onScrollRef = useRef(onScroll);
  onScrollRef.current = onScroll;
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
    startIndex: number;
    endIndex: number;
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
  // Track when applying remote operations to prevent triggering saves for non-local changes
  const isApplyingRemoteOpsRef = useRef(false);
  // Track snapshot clock for delta operations (operations after this clock need to be sent)
  const snapshotClockRef = useRef<HLC | null>(snapshotClock ?? null);

  // Update ref when snapshotClock prop changes
  useEffect(() => {
    snapshotClockRef.current = snapshotClock ?? null;
  }, [snapshotClock]);

  // Track current toolbar icon type
  const currentIconTypeRef = useRef<"link" | "image" | "format" | "none">(
    "format"
  );

  // Callbacks for useRoom - use refs to avoid recreating callbacks
  const onRoomOperationsRef = useRef<((ops: Operation[]) => void) | null>(null);
  const onRoomSyncRequestRef = useRef<
    | ((
        vv: Record<string, number>,
        clock: { counter: number; peerId: string } | null | undefined,
        requesterId?: string
      ) => void)
    | null
  >(null);
  const onRoomSyncResponseRef = useRef<
    ((ops: Operation[], vv: Record<string, number>) => void) | null
  >(null);
  const onRoomAwarenessRef = useRef<
    ((awarenesspeerId: string, state: AwarenessState | null) => void) | null
  >(null);
  const onRoomFirstPeerRef = useRef<(() => void) | null>(null);
  const onRoomAwarenessStatesRef = useRef<
    ((states: Record<string, AwarenessState>) => void) | null
  >(null);
  const onRoomJoinedRef = useRef<((hasOtherPeers: boolean) => void) | null>(
    null
  );
  // Track sync state for confirmSave callback
  const syncStateRef = useRef<SyncState>({ status: "disconnected" });

  // Use the global WebSocket room subscription
  const {
    broadcast: roomBroadcast,
    broadcastAwareness: roomBroadcastAwareness,
    sendSyncRequest: roomSendSyncRequest,
    sendSyncResponse: roomSendSyncResponse,
    syncState,
    localUser,
    peerId,
  } = useRoom(pageId, {
    onOperations: useCallback((ops: Operation[]) => {
      onRoomOperationsRef.current?.(ops);
    }, []),
    onSyncRequest: useCallback(
      (
        vv: Record<string, number>,
        clock: { counter: number; peerId: string } | null | undefined,
        requesterId?: string
      ) => {
        onRoomSyncRequestRef.current?.(vv, clock, requesterId);
      },
      []
    ),
    onSyncResponse: useCallback((ops: Operation[], vv: Record<string, number>) => {
      onRoomSyncResponseRef.current?.(ops, vv);
    }, []),
    onAwarenessUpdate: useCallback((pId: string, state: AwarenessState | null) => {
      onRoomAwarenessRef.current?.(pId, state);
    }, []),
    onFirstPeer: useCallback(() => {
      onRoomFirstPeerRef.current?.();
    }, []),
    onAwarenessStates: useCallback((states: Record<string, AwarenessState>) => {
      onRoomAwarenessStatesRef.current?.(states);
    }, []),
    onJoined: useCallback((hasOtherPeers: boolean) => {
      onRoomJoinedRef.current?.(hasOtherPeers);
    }, []),
  });

  // Keep syncStateRef up to date for use in callbacks
  useEffect(() => {
    syncStateRef.current = syncState;
  }, [syncState]);

  // Notify parent of sync state changes
  useEffect(() => {
    onSyncStateChange?.(syncState);
  }, [syncState, onSyncStateChange]);

  // Native drawer states (triggered by format button on mobile)
  const [nativeLinkDrawerState, setNativeLinkDrawerState] = useState<{
    x: number;
    y: number;
    url?: string;
    linkText?: string;
    selectedText?: string;
    blockIndex?: number;
    startIndex?: number;
    endIndex?: number;
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

    // Clean up previous sync engine
    if (syncEngineRef.current) {
      syncEngineRef.current = null;
    }

    // Reset serialization tracking and initialization flag when snapshot changes
    lastSerializedBlocksRef.current = null;
    editorInitializedRef.current = false;

    const mounted = mountEditor(el, snapshot, { readonly, padding, blockStyleOverrides });
    mountedRef.current = mounted;

    // Wire up scroll callback
    mounted.editor.onScroll((scrollY) => {
      onScrollRef.current?.(scrollY);
    });

    // Skip offline store and sync setup in readonly mode
    if (readonly) {
      // In readonly mode, we only render the content - no sync, no offline store
      // Subscribe to state changes for context menu only
      const unsubscribe = mounted.editor.subscribe((state: EditorState) => {
        // Calculate context menu state for readonly mode
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
              // Execute the action asynchronously
              setTimeout(async () => {
                if (!mountedRef.current) return;
                const editor = mountedRef.current.editor;
                switch (selectedItemId) {
                  case "copy":
                    await editor.copy();
                    break;
                  case "selectAll":
                    editor.selectAll();
                    break;
                }
              }, 0);
              newContextMenuState = null;
            }
          }
        }

        if (!shallowEqual(newContextMenuState, lastContextMenuStateRef.current)) {
          lastContextMenuStateRef.current = newContextMenuState;
          setContextMenuState(newContextMenuState);
        }
      });

      return () => {
        unsubscribe();
        mounted.destroy();
        if (mountedRef.current === mounted) {
          mountedRef.current = null;
        }
      };
    }

    // Initialize offline store for this page
    const offlineStore = new OfflineStore(pageId);
    offlineStoreRef.current = offlineStore;

    // Load persisted operations from IndexedDB (if any)
    // This restores local changes that weren't synced before page reload
    offlineStore.loadOperations().then((persistedOps) => {
      if (persistedOps.length > 0 && syncEngineRef.current) {
        console.log(
          `[Offline] Loading ${persistedOps.length} persisted operations`
        );
        syncEngineRef.current.loadOperations(persistedOps);
      }
    });

    // Expose restore function to parent
    // Uses restoreFromSnapshot which generates and broadcasts operations
    if (onRestoreReady) {
      onRestoreReady((blocks: Block[]) => {
        mounted.editor.restoreFromSnapshot(blocks);
      });
    }

    // Expose confirmSave function to parent
    // Called after backend confirms save succeeded - updates snapshotClock and marks ops as synced
    if (onConfirmSaveReady) {
      onConfirmSaveReady((clock: HLC) => {
        // Update local snapshotClock ref
        snapshotClockRef.current = clock;
        // Notify parent of clock update
        onSnapshotClockUpdate?.(clock);
        // Only mark operations as synced and compact if WebSocket is connected
        // This ensures operations aren't deleted before they've been broadcast to peers
        if (syncStateRef.current.status === "connected") {
          offlineStoreRef.current?.markSynced(clock).then(() => {
            offlineStoreRef.current?.compactSynced();
          });
        }
      });
    }

    // Initialize sync engine for CRDT (use same peerId as WebSocket)
    const syncEngine = new SyncEngine(pageId, peerId);
    syncEngineRef.current = syncEngine;

    // Wire up room callbacks to sync engine and editor
    // These refs are called by useRoom when messages arrive
    onRoomOperationsRef.current = (ops) => {
      isApplyingRemoteOpsRef.current = true;
      mounted.editor.applyRemoteOperations(ops);
      isApplyingRemoteOpsRef.current = false;
    };

    onRoomSyncRequestRef.current = (versionVector, _snapshotClock, requesterId) => {
      const remoteVV = deserializeVV(versionVector);
      const missingOps = syncEngine.getOpsSince(remoteVV);
      const localVV = serializeVV(syncEngine.getVersionVector());

      if (missingOps.length > 0 || requesterId) {
        roomSendSyncResponse(missingOps, localVV, requesterId);
      }
    };

    onRoomSyncResponseRef.current = (ops, _versionVector) => {
      if (ops.length > 0) {
        isApplyingRemoteOpsRef.current = true;
        syncEngine.apply(ops);
        mounted.editor.applyRemoteOperations(ops);
        isApplyingRemoteOpsRef.current = false;
      }
    };

    onRoomFirstPeerRef.current = () => {
      // The editor already has the initial content loaded
    };

    onRoomAwarenessRef.current = (awarenesspeerId, state) => {
      mounted.editor.setRemoteAwareness(awarenesspeerId, state);

      if (onAwarenessChange) {
        const remoteAwareness = mounted.editor.getRemoteAwareness();
        const users = Array.from(remoteAwareness.values()).map((s) => s.user);
        onAwarenessChange(users);
      }
    };

    onRoomAwarenessStatesRef.current = (states) => {
      for (const [awarenesspeerId, state] of Object.entries(states)) {
        mounted.editor.setRemoteAwareness(awarenesspeerId, state);
      }

      if (onAwarenessChange) {
        const users = Object.values(states).map((s) => s.user);
        onAwarenessChange(users);
      }
    };

    // Handle room join/rejoin - broadcast unsynced ops and request sync
    onRoomJoinedRef.current = (hasOtherPeers) => {
      // Broadcast any unsynced operations from IndexedDB
      // This handles both: initial load with pending ops, and reconnect after offline typing
      offlineStore.getUnsyncedOperations().then((unsyncedOps) => {
        if (unsyncedOps.length > 0) {
          roomBroadcast(unsyncedOps);
        }
      });

      // If there are other peers, request sync to get any operations we missed
      if (hasOtherPeers) {
        const localVV = serializeVV(syncEngine.getVersionVector());
        roomSendSyncRequest(localVV, snapshotClockRef.current);
      }
    };

    // Connect editor's broadcast to room
    mounted.editor.setBroadcast((ops) => {
      // Add to sync engine's log
      syncEngine.emit(ops);
      // Broadcast to peers via global WebSocket
      roomBroadcast(ops);
      // Persist to IndexedDB for offline support
      offlineStoreRef.current?.persistOperations(ops);
    });

    // Connect editor's awareness broadcast to room
    mounted.editor.setAwarenessBroadcast((state: AwarenessState) => {
      roomBroadcastAwareness(state);
    }, localUser);

    // Handle pasted image files (e.g. screenshots) — upload and update block URL
    mounted.editor.onImagePaste(async (file, blockIndex) => {
      try {
        const imageData = await uploadImage(file);
        // Revoke the temporary blob URL
        const state = mounted.editor.getState();
        if (state) {
          const block = state.document.page.blocks[blockIndex];
          if (block && block.type === "image" && block.url?.startsWith("blob:")) {
            URL.revokeObjectURL(block.url);
          }
        }
        mounted.editor.updateImageBlock(blockIndex, {
          url: imageData.url,
          alt: imageData.fileName,
        });
      } catch (error) {
        console.error("Image paste upload failed:", error);
      }
    });

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
          const linkData = getLinkAtPosition(
            state.document.cursor.position,
            state
          );

          if (linkData) {
            // Editing existing link
            setNativeLinkDrawerState({
              x: containerRect.left + containerRect.width / 2,
              y: containerRect.top + 100,
              url: linkData.url,
              linkText: linkData.text,
              blockIndex: state.document.cursor.position.blockIndex,
              startIndex: linkData.startIndex,
              endIndex: linkData.endIndex,
            });
            return true;
          } else if (
            state.document.selection &&
            !state.document.selection.isCollapsed
          ) {
            // Creating new link from selection
            const range = getSelectionRange(state);
            if (range) {
              const { start, end } = range;
              const block = state.document.page.blocks[start.blockIndex];
              if (block && block.type !== "image") {
                const text = getBlockTextContent(block);
                const selectedText = text.substring(
                  start.textIndex,
                  end.textIndex
                );

                setNativeLinkDrawerState({
                  x: containerRect.left + containerRect.width / 2,
                  y: containerRect.top + 100,
                  selectedText,
                  blockIndex: start.blockIndex,
                  startIndex: start.textIndex,
                  endIndex: end.textIndex,
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
      toggleBold: () => mounted.editor.toggleBold(),
      toggleItalic: () => mounted.editor.toggleItalic(),
      toggleCode: () => mounted.editor.toggleCode(),
      toggleStrikethrough: () => mounted.editor.toggleStrikethrough(),
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
      if ((onContentChange || onContentUpdate) && state.document.page?.blocks) {
        const currentBlocks = state.document.page.blocks;

        // On first state change, store the initial blocks and notify for read-only callbacks
        // Skip onContentChange to prevent overwriting backend content with empty state on mount
        if (!editorInitializedRef.current) {
          lastSerializedBlocksRef.current = currentBlocks;
          editorInitializedRef.current = true;
          // Still call onContentUpdate for read-only purposes (word count, export)
          onContentUpdate?.(state.view.visibleBlocks);
          return;
        }

        // Check if blocks reference has changed (indicates actual content modification)
        if (currentBlocks !== lastSerializedBlocksRef.current) {
          lastSerializedBlocksRef.current = currentBlocks;

          // Notify of all content updates (local and remote) - used for word count, etc.
          onContentUpdate?.(state.view.visibleBlocks);

          // Only trigger saves for local user-initiated changes, not remote peer updates
          // Remote peers handle saving their own changes
          if (!isApplyingRemoteOpsRef.current && onContentChange) {
            // Get the latest clock for the save request
            const latestClock = syncEngineRef.current?.getLatestClock() ?? null;

            // NOTE: snapshotClock is NOT updated here - it will be updated
            // by confirmSave() after the backend confirms the save succeeded.
            // This prevents offline operations from being marked as synced
            // before they're actually persisted to the server.

            // Save snapshot with tombstones preserved for offline sync
            onContentChange(currentBlocks as Block[], latestClock);
          }
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
      const determineToolbarIcon = (): "link" | "image" | "format" | "none" => {
        // Check if an image block is selected
        if (state.document.selection && !state.document.selection.isCollapsed) {
          const { anchor, focus } = state.document.selection;
          // If selection is on a single block
          if (anchor.blockIndex === focus.blockIndex) {
            const block = state.document.page.blocks[anchor.blockIndex];
            if (block && block.type === "image") {
              return "image";
            }
          } else {
            // Selection spans multiple blocks - don't show any icon
            return "none";
          }
        }

        // Check if cursor is in a link or text is selected
        if (state.document.cursor) {
          const linkData = getLinkAtPosition(
            state.document.cursor.position,
            state
          );
          if (linkData) {
            return "link";
          }
        }

        // Check if there's a text selection (show link icon to allow creating links)
        if (state.document.selection && !state.document.selection.isCollapsed) {
          const range = getSelectionRange(state);
          if (range) {
            const { start, end } = range;
            // Only show link icon if selection is within a single block
            if (start.blockIndex === end.blockIndex) {
              const block = state.document.page.blocks[start.blockIndex];
              if (block && block.type !== "image") {
                return "link";
              }
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

      // Send formatting state to native bridge
      // When there's a selection, check if ALL chars have the format
      const range = getSelectionRange(state);
      let isBold: boolean;
      let isItalic: boolean;
      let isCode: boolean;
      let isStrikethrough: boolean;

      if (range && range.start.blockIndex === range.end.blockIndex) {
        // Single block selection: check if all chars have each format
        const block = state.document.page.blocks[range.start.blockIndex];
        if (isTextualBlock(block)) {
          isBold = allCharsHaveFormat(block.charRuns, block.formats, range.start.textIndex, range.end.textIndex, "bold");
          isItalic = allCharsHaveFormat(block.charRuns, block.formats, range.start.textIndex, range.end.textIndex, "italic");
          isCode = allCharsHaveFormat(block.charRuns, block.formats, range.start.textIndex, range.end.textIndex, "code");
          isStrikethrough = allCharsHaveFormat(block.charRuns, block.formats, range.start.textIndex, range.end.textIndex, "strikethrough");
        } else {
          isBold = isItalic = isCode = isStrikethrough = false;
        }
      } else {
        // No selection or multi-block: use cursor position
        const getActiveFormats = () => {
          if (state.ui.activeFormatsMode.type === "explicit") {
            return state.ui.activeFormatsMode.formats;
          }
          if (state.document.cursor) {
            const { blockIndex, textIndex } = state.document.cursor.position;
            const block = state.document.page.blocks[blockIndex];
            return getFormatsAtPosition(block, textIndex) || [];
          }
          return [];
        };
        const activeFormats = getActiveFormats();
        isBold = activeFormats.some((f) => f.type === "bold");
        isItalic = activeFormats.some((f) => f.type === "italic");
        isCode = activeFormats.some((f) => f.type === "code");
        isStrikethrough = activeFormats.some(
          (f) => f.type === "strikethrough"
        );
      }

      if (window.IOSBridge) {
        window.IOSBridge.postMessage({
          action: "formatting-state",
          bold: isBold,
          italic: isItalic,
          code: isCode,
          strikethrough: isStrikethrough,
        });
      }

      if (window.AndroidBridge) {
        window.AndroidBridge.updateFormattingState?.(
          isBold,
          isItalic,
          isCode,
          isStrikethrough
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

      // Clear room callback refs
      onRoomOperationsRef.current = null;
      onRoomSyncRequestRef.current = null;
      onRoomSyncResponseRef.current = null;
      onRoomAwarenessRef.current = null;
      onRoomFirstPeerRef.current = null;
      onRoomAwarenessStatesRef.current = null;
      onRoomJoinedRef.current = null;

      // Clean up sync engine
      if (syncEngineRef.current) {
        syncEngineRef.current = null;
      }

      // Clean up offline store
      if (offlineStoreRef.current) {
        offlineStoreRef.current = null;
      }

      mounted.destroy();

      if (window.AndroidBridge) {
        delete window.AndroidBridge.undo;
        delete window.AndroidBridge.redo;
        delete window.AndroidBridge.setBlockType;
        delete window.AndroidBridge.focus;
        delete window.AndroidBridge.toggleBold;
        delete window.AndroidBridge.toggleItalic;
        delete window.AndroidBridge.toggleCode;
        delete window.AndroidBridge.toggleStrikethrough;
      }
      if (mountedRef.current === mounted) {
        mountedRef.current = null;
      }
    };
  }, [
    snapshot,
    onContentChange,
    onContentUpdate,
    autoFocus,
    pageId,
    roomBroadcast,
    roomBroadcastAwareness,
    roomSendSyncRequest,
    roomSendSyncResponse,
    localUser,
    peerId,
    onSnapshotClockUpdate,
    readonly,
    padding,
    blockStyleOverrides,
  ]);

  // Note: WebSocket reconnection is handled by the global WebSocketProvider

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
    ];

    // Hide edit-related items in readonly mode
    if (!readonly) {
      items.push({
        id: "cut",
        label: "Cut",
        icon: <Scissors size={16} />,
        action: () => handleContextMenuAction("cut"),
        disabled: !hasSelection,
      });

      if (canPaste) {
        items.push({
          id: "paste",
          label: "Paste",
          icon: <Clipboard size={16} />,
          action: () => handleContextMenuAction("paste"),
        });
      }
    }

    // Add Format submenu for desktop when text is selected (not in readonly mode)
    if (hasSelection && !isTouchDevice() && !readonly) {
      // Get active formats from current selection
      // When there's a selection, check if ALL chars have the format
      const state = mountedRef.current?.editor.getState();
      let isBold = false;
      let isItalic = false;
      let isCode = false;
      let isStrikethrough = false;

      if (state) {
        const range = getSelectionRange(state);
        if (range && range.start.blockIndex === range.end.blockIndex) {
          // Single block selection: check if all chars have each format
          const block = state.document.page.blocks[range.start.blockIndex];
          if (isTextualBlock(block)) {
            isBold = allCharsHaveFormat(block.charRuns, block.formats, range.start.textIndex, range.end.textIndex, "bold");
            isItalic = allCharsHaveFormat(block.charRuns, block.formats, range.start.textIndex, range.end.textIndex, "italic");
            isCode = allCharsHaveFormat(block.charRuns, block.formats, range.start.textIndex, range.end.textIndex, "code");
            isStrikethrough = allCharsHaveFormat(block.charRuns, block.formats, range.start.textIndex, range.end.textIndex, "strikethrough");
          }
        } else {
          // No selection or multi-block: use cursor position
          const getActiveFormats = () => {
            if (state.ui.activeFormatsMode.type === "explicit") {
              return state.ui.activeFormatsMode.formats;
            }
            if (state.document.cursor) {
              const { blockIndex, textIndex } = state.document.cursor.position;
              const block = state.document.page.blocks[blockIndex];
              return getFormatsAtPosition(block, textIndex) || [];
            }
            return [];
          };
          const activeFormats = getActiveFormats();
          isBold = activeFormats.some((f) => f.type === "bold");
          isItalic = activeFormats.some((f) => f.type === "italic");
          isCode = activeFormats.some((f) => f.type === "code");
          isStrikethrough = activeFormats.some(
            (f) => f.type === "strikethrough"
          );
        }
      }

      items.push({
        id: "format",
        label: "Format",
        icon: <Type size={16} />,
        children: [
          {
            id: "format-bold",
            label: "Bold",
            icon: <Bold size={16} />,
            action: () => mountedRef.current?.editor.toggleBold(),
            active: isBold,
          },
          {
            id: "format-italic",
            label: "Italic",
            icon: <Italic size={16} />,
            action: () => mountedRef.current?.editor.toggleItalic(),
            active: isItalic,
          },
          {
            id: "format-code",
            label: "Code",
            icon: <Code size={16} />,
            action: () => mountedRef.current?.editor.toggleCode(),
            active: isCode,
          },
          {
            id: "format-strikethrough",
            label: "Strikethrough",
            icon: <Strikethrough size={16} />,
            action: () => mountedRef.current?.editor.toggleStrikethrough(),
            active: isStrikethrough,
          },
        ],
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
          startIndex: linkData.startIndex,
          endIndex: linkData.endIndex,
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
      linkEditState.startIndex,
      linkEditState.endIndex,
      newUrl,
      newText
    );
    // Mark that an action was performed (don't restore selection on close)
    linkEditActionPerformedRef.current = true;
  };

  const handleLinkClear = () => {
    if (!linkEditState || !mountedRef.current) return;

    const editor = mountedRef.current.editor;
    editor.clearLink(
      linkEditState.blockIndex,
      linkEditState.startIndex,
      linkEditState.endIndex
    );
    // Mark that an action was performed (don't restore selection on close)
    linkEditActionPerformedRef.current = true;
  };

  const handleLinkEditClose = () => {
    if (!linkEditState || !mountedRef.current) return;
    mountedRef.current.editor.closeActiveMenu();
    setLinkEditState(null);

    if (window.IOSBridge) {
      // Refocus editor to restore island toolbar on iOS
      mountedRef.current.refocus();
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
                // Use native bridge on mobile apps, fallback to window.open on web
                if (window.IOSBridge?.postMessage) {
                  window.IOSBridge.postMessage({
                    action: "open-url",
                    url: linkTooltipState.url,
                  });
                } else if (window.AndroidBridge?.openUrl) {
                  window.AndroidBridge.openUrl(linkTooltipState.url);
                } else {
                  window.open(
                    linkTooltipState.url,
                    "_blank",
                    "noopener,noreferrer"
                  );
                }
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

              if (
                nativeLinkDrawerState.blockIndex !== undefined &&
                nativeLinkDrawerState.startIndex !== undefined &&
                nativeLinkDrawerState.endIndex !== undefined
              ) {
                // Update existing link
                editor.updateLink(
                  nativeLinkDrawerState.blockIndex,
                  nativeLinkDrawerState.startIndex,
                  nativeLinkDrawerState.endIndex,
                  newUrl,
                  newText
                );
              } else if (
                nativeLinkDrawerState.blockIndex !== undefined &&
                nativeLinkDrawerState.startIndex !== undefined &&
                nativeLinkDrawerState.endIndex !== undefined
              ) {
                // Create new link from selection - restore selection first
                const blockIndex = nativeLinkDrawerState.blockIndex;
                const startTextIndex = nativeLinkDrawerState.startIndex;
                const endTextIndex = nativeLinkDrawerState.endIndex;

                // Restore the selection by creating it programmatically
                const anchor = { blockIndex, textIndex: startTextIndex };
                const focus = { blockIndex, textIndex: endTextIndex };

                editor.restoreCursorAndSelection(
                  { position: focus, lastUpdate: Date.now() },
                  {
                    anchor,
                    focus,
                    isForward: true,
                    isCollapsed: false,
                    lastUpdate: Date.now(),
                  }
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
                    if (
                      nativeLinkDrawerState.blockIndex !== undefined &&
                      nativeLinkDrawerState.startIndex !== undefined &&
                      nativeLinkDrawerState.endIndex !== undefined
                    ) {
                      editor.clearLink(
                        nativeLinkDrawerState.blockIndex,
                        nativeLinkDrawerState.startIndex,
                        nativeLinkDrawerState.endIndex
                      );
                    }
                    setNativeLinkDrawerState(null);
                  }
                : undefined
            }
            onClose={() => {
              setNativeLinkDrawerState(null);
              // Refocus editor to restore island toolbar on iOS
              mountedRef.current?.refocus();
            }}
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
            onClose={() => {
              setNativeImageDrawerState(null);
              // Refocus editor to restore island toolbar on iOS
              mountedRef.current?.refocus();
            }}
            collisionBoundary={mountedRef.current?.portalContainer}
            container={mountedRef.current?.portalContainer}
          />,
          mountedRef.current.portalContainer
        )}
    </div>
  );
}
