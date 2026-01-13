import {
  isListBlock,
  type Block,
  isTextualBlock,
} from "@/deserializer/loadPage";
import type { Operation } from "../sync/sync";
import { getVisibleBlocks, getPageId, nextId, getClock } from "../sync/sync";
import { copySelectionToClipboard } from "../actions/clipboard";
import {
  selectAll,
  toggleBold,
  outdentListItem,
  indentListItem,
  getSelectionRange,
  deleteSelectedText,
  applySlashCommand,
  deleteText,
  insertText,
  extendSelectionWordLeft,
  moveToPreviousWord,
  extendSelectionWordRight,
  moveToNextWord,
  extendSelectionHome,
  moveToLineStart,
  extendSelectionEnd,
  moveToLineEnd,
  deleteWordBackward,
  deleteWordForward,
  deleteForward,
  splitBlock,
} from "../actions/commands";
import { deleteCharsInRange } from "../sync/crdt-helpers";
import { ensureCursorVisible, isTouchDevice } from "./eventUtils";
import { invalidateBlockCache } from "../renderer";
import { getTextDirection } from "../rtl";
import {
  scrollToMakeCursorVisible,
  getTextPositionFromViewport,
} from "../selection";
import { SLASH_COMMANDS } from "../SlashCommandMenu";
import {
  closeSlashCommand,
  updateSlashCommandSelection,
  moveCursorToPosition,
  getBlockTextContent,
  updateSlashCommandFilter,
  updateFocus,
  extendSelectionLeft,
  clearSelection,
  moveCursorLeft,
  clearAutoCreatedParagraph,
  extendSelectionRight,
  moveCursorRight,
  extendSelectionUp,
  moveCursorUp,
  extendSelectionDown,
  moveCursorDown,
  extendSelectionPageUp,
  moveCursorPageUp,
  extendSelectionPageDown,
  moveCursorPageDown,
  getBlockTextLength,
  openSlashCommand,
  updateCursor,
  openContextMenu,
} from "../state";
import type {
  EditorState,
  ViewportState,
  KeyboardEvent,
  MouseEvent,
} from "../types";
import { undoState, redoState } from "../undo";

export function handleKeyDown(
  state: EditorState,
  viewport: ViewportState,
  event: Event,
  updateViewportCallback?: (viewport: Partial<ViewportState>) => void
): { state: EditorState; ops: Operation[] } {
  const ops: Operation[] = [];
  const keyEvent = event as unknown as KeyboardEvent;
  const key = keyEvent.key;
  const code = keyEvent.code;
  const isCtrl = keyEvent.ctrlKey || keyEvent.metaKey;

  // In locked mode, block all operations
  if (state.ui.mode === "locked") {
    return { state, ops };
  }

  // If editor is not focused, ignore keyboard input
  if (!state.view.isFocused) {
    return { state, ops };
  }

  // Block most operations during composition - let IME handle input
  if (state.ui.composition?.isComposing) {
    // Block undo/redo
    if (isCtrl && (code === "KeyZ" || code === "KeyY")) {
      return { state, ops };
    }
    // Block cut operation
    if (isCtrl && code === "KeyX") {
      return { state, ops };
    }
    // Block text input keys - let IME handle all text input
    if (
      key === "Backspace" ||
      key === "Delete" ||
      key === "Enter" ||
      key === " " ||
      key === "Space"
    ) {
      return { state, ops };
    }
    // Block regular character input during composition
    if (
      key.length === 1 &&
      !keyEvent.ctrlKey &&
      !keyEvent.altKey &&
      !keyEvent.metaKey
    ) {
      return { state, ops };
    }
  }

  // Undo/Redo - handle these first, even if slash command is open
  // Use code instead of key for keyboard layout independence
  if (isCtrl && code === "KeyZ" && !keyEvent.shiftKey) {
    const result = undoState(state);
    ensureCursorVisible(result.state, state, viewport, updateViewportCallback);
    return { state: result.state, ops: result.ops };
  }
  if (isCtrl && (code === "KeyY" || (keyEvent.shiftKey && code === "KeyZ"))) {
    const result = redoState(state);
    ensureCursorVisible(result.state, state, viewport, updateViewportCallback);
    return { state: result.state, ops: result.ops };
  }

  // Select All
  if (isCtrl && code === "KeyA") {
    return { state: selectAll(state), ops };
  }

  // Bold
  if (isCtrl && code === "KeyB") {
    // Only record undo if there's a selection (actual document change)
    const hasSelection =
      state.document.selection && !state.document.selection.isCollapsed;
    const result = toggleBold(hasSelection ? state : state);
    ops.push(...result.ops);
    return { state: result.state, ops };
  }

  // Tab - indent/outdent list items
  if (key === "Tab") {
    if (state.document.cursor) {
      const { blockIndex } = state.document.cursor.position;
      const block = state.document.page.blocks[blockIndex];

      if (isListBlock(block)) {
        if (keyEvent.shiftKey) {
          // Shift+Tab: outdent
          const result = outdentListItem(state);
          const newState = result.state;
          ops.push(...result.ops);
          ensureCursorVisible(
            newState,
            state,
            viewport,
            updateViewportCallback
          );
          return { state: newState, ops };
        } else {
          // Tab: indent
          const result = indentListItem(state);
          const newState = result.state;
          ops.push(...result.ops);
          ensureCursorVisible(
            newState,
            state,
            viewport,
            updateViewportCallback
          );
          return { state: newState, ops };
        }
      }
    }
    // For non-list blocks, return state without preventing default
    return { state, ops };
  }

  // Copy
  if (isCtrl && code === "KeyC") {
    // Don't prevent default - allow browser's copy to work as fallback
    // But also handle our custom copy with formatting
    copySelectionToClipboard(state).catch((err) => {
      console.error("Copy failed:", err);
    });
    return { state, ops };
  }

  // Cut
  if (isCtrl && code === "KeyX") {
    const range = getSelectionRange(state);
    if (range) {
      // Copy to clipboard first
      copySelectionToClipboard(state).catch((err) => {
        console.error("Cut (copy) failed:", err);
      });
      // Then delete the selected text
      const result = deleteSelectedText(state);
      const newState = result.state;
      ops.push(...result.ops);
      ensureCursorVisible(newState, state, viewport, updateViewportCallback);
      return { state: newState, ops };
    }
    return { state, ops };
  }

  // Handle slash command menu navigation
  if (state.ui.activeMenu.type === "slashCommand") {
    const slashMenu = state.ui.activeMenu;
    const filteredCommands = slashMenu.filter
      ? SLASH_COMMANDS.filter(
          (cmd) =>
            cmd.label.toLowerCase().includes(slashMenu.filter.toLowerCase()) ||
            cmd.description
              .toLowerCase()
              .includes(slashMenu.filter.toLowerCase()) ||
            cmd.keywords?.some((keyword) =>
              keyword.toLowerCase().startsWith(slashMenu.filter.toLowerCase())
            )
        )
      : SLASH_COMMANDS;

    switch (key) {
      case "ArrowLeft":
      case "ArrowRight":
        // Close slash menu on left/right arrow and continue to normal arrow key handling
        state = closeSlashCommand(state);
        break;
      case "ArrowDown":
        if (filteredCommands.length > 0) {
          const newIndex = Math.min(
            slashMenu.selectedIndex + 1,
            filteredCommands.length - 1
          );
          return { state: updateSlashCommandSelection(state, newIndex), ops };
        }
        return { state, ops };
      case "ArrowUp":
        const newIndex = Math.max(slashMenu.selectedIndex - 1, 0);
        return { state: updateSlashCommandSelection(state, newIndex), ops };
      case "Enter":
        if (filteredCommands.length > 0 && state.document.cursor) {
          const selectedCommand = filteredCommands[slashMenu.selectedIndex];
          const result = applySlashCommand(state, selectedCommand);
          const newState = result.state;
          ops.push(...result.ops);
          ensureCursorVisible(
            newState,
            state,
            viewport,
            updateViewportCallback
          );
          return { state: newState, ops };
        }
        return { state: closeSlashCommand(state), ops };
      case "Escape":
        // Close slash command and remove the "/" character
        if (state.document.cursor) {
          const { blockIndex, textIndex } = slashMenu;
          const block = state.document.page.blocks[blockIndex];
          if (!block || block.deleted) return { state, ops };

          // Visual blocks (image/line) don't have text content, so guard anyway
          if (block.type === "image" || block.type === "line") {
            return { state: closeSlashCommand(state), ops };
          }

          // Remove the "/" and filter text using CRDT operations
          const { newChars } = deleteCharsInRange(
            block.chars,
            textIndex - 1, // Remove the "/"
            state.document.cursor.position.textIndex, // Remove up to cursor (the filter text)
            block.id
          );

          const newBlock: Block = {
            ...block,
            chars: newChars,
          };

          invalidateBlockCache(newBlock);

          const newBlocks = [...state.document.page.blocks];
          newBlocks[blockIndex] = newBlock;
          const newPage = { ...state.document.page, blocks: newBlocks };

          let newState: EditorState = {
            ...state,
            document: { ...state.document, page: newPage },
          };
          newState = closeSlashCommand(newState);
          newState = moveCursorToPosition(newState, blockIndex, textIndex - 1);

          ensureCursorVisible(
            newState,
            state,
            viewport,
            updateViewportCallback
          );
          return { state: newState, ops };
        }
        return { state: closeSlashCommand(state), ops };
      case "Backspace":
        // If at the start of filter, close menu
        if (
          state.document.cursor &&
          state.ui.activeMenu.type === "slashCommand" &&
          state.document.cursor.position.textIndex <=
            state.ui.activeMenu.textIndex
        ) {
          // Close menu and delete the slash character - no  needed since deleteText already records
          const deleteResult = deleteText(state);
          const newState = closeSlashCommand(deleteResult.state);
          ops.push(...deleteResult.ops);
          ensureCursorVisible(
            newState,
            state,
            viewport,
            updateViewportCallback
          );
          return { state: newState, ops };
        }
        // Otherwise update filter - deleteText handles  internally
        if (
          state.document.cursor &&
          state.ui.activeMenu.type === "slashCommand"
        ) {
          const slashMenu = state.ui.activeMenu;
          const result = deleteText(state);
          const newState = result.state;
          ops.push(...result.ops);
          if (newState.document.cursor) {
            const block = newState.document.page.blocks[slashMenu.blockIndex];
            if (!block || block.deleted) return { state, ops };
            const text = getBlockTextContent(block);
            const filter = text.slice(
              slashMenu.textIndex,
              newState.document.cursor.position.textIndex
            );
            const finalState = updateSlashCommandFilter(newState, filter);
            ensureCursorVisible(
              finalState,
              state,
              viewport,
              updateViewportCallback
            );
            return { state: finalState, ops };
          }
        }
        return { state, ops };
      default:
        // Handle typing to filter commands (including spaces)
        if (
          key.length === 1 &&
          !keyEvent.ctrlKey &&
          !keyEvent.altKey &&
          !keyEvent.metaKey &&
          state.ui.activeMenu.type === "slashCommand"
        ) {
          const slashMenu = state.ui.activeMenu;
          // insertText handles  internally
          const result = insertText(state, key);
          ops.push(...result.ops);
          if (result.state.document.cursor) {
            const block =
              result.state.document.page.blocks[slashMenu.blockIndex];
            if (!block || block.deleted) return { state, ops };
            const text = getBlockTextContent(block);
            const filter = text.slice(
              slashMenu.textIndex,
              result.state.document.cursor.position.textIndex
            );
            const finalState = updateSlashCommandFilter(result.state, filter);
            ensureCursorVisible(
              finalState,
              state,
              viewport,
              updateViewportCallback
            );
            return { state: finalState, ops };
          }
          return { state: result.state, ops };
        }
        return { state, ops };
    }
  }

  let newState = state;

  // Prevent navigation keys during composition (IME input)
  // These keys are used by the IME to navigate candidate characters
  const navigationKeys = [
    "ArrowLeft",
    "ArrowRight",
    "ArrowUp",
    "ArrowDown",
    "PageUp",
    "PageDown",
    "Home",
    "End",
  ];
  if (state.ui.composition?.isComposing && navigationKeys.includes(key)) {
    return { state, ops };
  }

  // Navigation & selection
  switch (key) {
    case "ArrowLeft":
      // Ensure editor is focused
      newState = updateFocus(state, true);

      if (isCtrl && keyEvent.shiftKey) {
        newState = extendSelectionWordLeft(newState);
      } else if (keyEvent.shiftKey) {
        newState = extendSelectionLeft(newState);
      } else {
        // Check if we're on an image at the start of the page
        if (state.document.cursor) {
          const currentBlock =
            state.document.page.blocks[
              state.document.cursor.position.blockIndex
            ];
          if (!currentBlock || currentBlock.deleted) return { state, ops };
          const visibleBlocks = getVisibleBlocks(state.document.page);
          const firstVisibleBlock =
            visibleBlocks.length > 0 ? visibleBlocks[0] : null;
          const isFirstBlock =
            firstVisibleBlock && currentBlock.id === firstVisibleBlock.id;

          if (isFirstBlock && currentBlock?.type === "image") {
            // Create a new paragraph above the image
            const newParagraphId = nextId();
            const newParagraph: Block = {
              id: newParagraphId,
              type: "paragraph",
              chars: [],
              formats: [],
            };

            const blockInsertOp: Operation = {
              op: "block_insert",
              id: nextId(),
              clock: getClock(),
              pageId: getPageId(),
              afterBlockId: null,
              blockId: newParagraphId,
              blockType: "paragraph",
            };

            const newBlocks = [newParagraph, ...state.document.page.blocks];
            const newPage = { ...state.document.page, blocks: newBlocks };

            newState = {
              ...state,
              document: { ...state.document, page: newPage },
            };
            newState = clearSelection(newState);
            newState = moveCursorToPosition(newState, 0, 0);

            // Broadcast the operation
            ops.push(blockInsertOp);

            break;
          }
        }

        // Check if we should remove an auto-created paragraph (RTL: left = forward)
        if (state.ui.autoCreatedParagraph && state.document.cursor) {
          const { blockIndex, blockId } = state.ui.autoCreatedParagraph;
          const currentBlock =
            state.document.page.blocks[
              state.document.cursor.position.blockIndex
            ];

          // Check if cursor is on the auto-created paragraph and it's RTL and empty
          if (
            state.document.cursor.position.blockIndex === blockIndex &&
            currentBlock?.id === blockId &&
            currentBlock.type === "paragraph" &&
            isTextualBlock(currentBlock) &&
            getBlockTextContent(currentBlock) === "" &&
            getTextDirection(getBlockTextContent(currentBlock)) === "rtl"
          ) {
            // Remove the auto-created paragraph and move to the image below
            const blockToDelete = state.document.page.blocks[blockIndex];

            const blockDeleteOp: Operation = {
              op: "block_delete",
              id: nextId(),
              clock: getClock(),
              pageId: getPageId(),
              blockId: blockToDelete.id,
            };
            ops.push(blockDeleteOp);

            const newBlocks = state.document.page.blocks.filter(
              (_, i) => i !== blockIndex
            );
            const newPage = { ...state.document.page, blocks: newBlocks };

            newState = {
              ...state,
              document: { ...state.document, page: newPage },
              ui: {
                ...state.ui,
                autoCreatedParagraph: null,
              },
            };

            // Broadcast the operation
            // Move cursor to the image that was below
            newState = clearSelection(newState);
            newState = moveCursorToPosition(newState, 0, 0);

            // Select the visual block (image/line)
            const visibleBlocks = getVisibleBlocks(newState.document.page);
            const firstBlock =
              visibleBlocks.length > 0 ? visibleBlocks[0] : null;
            if (firstBlock?.type === "image" || firstBlock?.type === "line") {
              newState = {
                ...newState,
                document: {
                  ...newState.document,
                  selection: {
                    anchor: { blockIndex: 0, textIndex: 0 },
                    focus: { blockIndex: 0, textIndex: 0 },
                    isForward: true,
                    isCollapsed: false,
                    lastUpdate: Date.now(),
                  },
                },
              };
            }
            break;
          }
        }

        // If there's a selection, check if it's a visual block selection (image/line)
        const range = getSelectionRange(newState);
        const startBlock = range
          ? state.document.page.blocks[range.start.blockIndex]
          : null;
        const isVisualBlockSelection =
          range &&
          (startBlock?.type === "image" || startBlock?.type === "line") &&
          range.start.blockIndex === range.end.blockIndex;

        if (range && !isVisualBlockSelection) {
          // Regular text selection - move to the start of it
          newState = moveCursorToPosition(
            clearSelection(newState),
            range.start.blockIndex,
            range.start.textIndex
          );
        } else if (isCtrl) {
          newState = moveToPreviousWord(clearSelection(newState));
        } else {
          newState = moveCursorLeft(clearSelection(newState));
        }

        // If we moved to a visual block (image/line), select it; otherwise leave just cursor
        if (newState.document.cursor) {
          const targetBlock =
            newState.document.page.blocks[
              newState.document.cursor.position.blockIndex
            ];
          if (
            targetBlock &&
            (targetBlock.type === "image" || targetBlock.type === "line")
          ) {
            const visualBlockPosition = {
              blockIndex: newState.document.cursor.position.blockIndex,
              textIndex: 0,
            };
            newState = {
              ...newState,
              document: {
                ...newState.document,
                selection: {
                  anchor: visualBlockPosition,
                  focus: visualBlockPosition,
                  isForward: true,
                  isCollapsed: false,
                  lastUpdate: Date.now(),
                },
              },
            };
          }

          // Clear auto-created paragraph tracking only if we moved away from it
          if (
            state.ui.autoCreatedParagraph &&
            newState.document.cursor &&
            newState.document.cursor.position.blockIndex !==
              state.ui.autoCreatedParagraph.blockIndex
          ) {
            newState = clearAutoCreatedParagraph(newState);
          }
        }
      }
      break;
    case "ArrowRight":
      // Ensure editor is focused
      newState = updateFocus(state, true);

      if (isCtrl && keyEvent.shiftKey) {
        newState = extendSelectionWordRight(state);
      } else if (keyEvent.shiftKey) {
        newState = extendSelectionRight(newState);
      } else {
        // Check if we're on a visual block (image/line) at the end of the page
        if (state.document.cursor) {
          const currentBlock =
            state.document.page.blocks[
              state.document.cursor.position.blockIndex
            ];
          const visibleBlocks = getVisibleBlocks(state.document.page);
          const lastVisibleBlockIndex =
            visibleBlocks.length > 0
              ? state.document.page.blocks.findIndex(
                  (b) => b.id === visibleBlocks[visibleBlocks.length - 1].id
                )
              : -1;
          const isLastBlock =
            state.document.cursor.position.blockIndex === lastVisibleBlockIndex;

          if (
            isLastBlock &&
            (currentBlock?.type === "image" || currentBlock?.type === "line")
          ) {
            // Create a new paragraph below the visual block
            const newParagraphId = nextId();
            const newParagraph: Block = {
              id: newParagraphId,
              type: "paragraph",
              chars: [],
              formats: [],
            };

            const blockInsertOp: Operation = {
              op: "block_insert",
              id: nextId(),
              clock: getClock(),
              pageId: getPageId(),
              afterBlockId: currentBlock.id,
              blockId: newParagraphId,
              blockType: "paragraph",
            };

            const newBlocks = [...state.document.page.blocks, newParagraph];
            const newPage = { ...state.document.page, blocks: newBlocks };

            newState = {
              ...state,
              document: { ...state.document, page: newPage },
            };
            newState = clearSelection(newState);
            newState = moveCursorToPosition(newState, newBlocks.length - 1, 0);

            // Broadcast the operation
            ops.push(blockInsertOp);

            break;
          }
        }

        // Check if we should remove an auto-created paragraph (LTR: right = forward)
        if (state.ui.autoCreatedParagraph && state.document.cursor) {
          const { blockIndex, blockId } = state.ui.autoCreatedParagraph;
          const currentBlock =
            state.document.page.blocks[
              state.document.cursor.position.blockIndex
            ];

          // Check if cursor is on the auto-created paragraph and it's LTR and empty
          if (
            state.document.cursor.position.blockIndex === blockIndex &&
            currentBlock?.id === blockId &&
            currentBlock.type === "paragraph" &&
            isTextualBlock(currentBlock) &&
            getBlockTextContent(currentBlock) === "" &&
            getTextDirection(getBlockTextContent(currentBlock)) === "ltr"
          ) {
            // Remove the auto-created paragraph and move to the image below
            const blockToDelete = state.document.page.blocks[blockIndex];

            const blockDeleteOp: Operation = {
              op: "block_delete",
              id: nextId(),
              clock: getClock(),
              pageId: getPageId(),
              blockId: blockToDelete.id,
            };
            ops.push(blockDeleteOp);

            const newBlocks = state.document.page.blocks.filter(
              (_, i) => i !== blockIndex
            );
            const newPage = { ...state.document.page, blocks: newBlocks };

            newState = {
              ...state,
              document: { ...state.document, page: newPage },
              ui: {
                ...state.ui,
                autoCreatedParagraph: null,
              },
            };

            // Broadcast the operation
            // Move cursor to the visual block that was below
            newState = clearSelection(newState);
            newState = moveCursorToPosition(newState, 0, 0);

            // Select the visual block (image/line)
            const visibleBlocks = getVisibleBlocks(newState.document.page);
            const firstBlock =
              visibleBlocks.length > 0 ? visibleBlocks[0] : null;
            if (firstBlock?.type === "image" || firstBlock?.type === "line") {
              newState = {
                ...newState,
                document: {
                  ...newState.document,
                  selection: {
                    anchor: { blockIndex: 0, textIndex: 0 },
                    focus: { blockIndex: 0, textIndex: 0 },
                    isForward: true,
                    isCollapsed: false,
                    lastUpdate: Date.now(),
                  },
                },
              };
            }
            break;
          }
        }

        // If there's a selection, check if it's a visual block selection (image/line)
        const range = getSelectionRange(newState);
        const endBlock = range
          ? state.document.page.blocks[range.end.blockIndex]
          : null;
        const isVisualBlockSelection =
          range &&
          (endBlock?.type === "image" || endBlock?.type === "line") &&
          range.start.blockIndex === range.end.blockIndex;

        if (range && !isVisualBlockSelection) {
          // Regular text selection - move to the end of it
          newState = moveCursorToPosition(
            clearSelection(newState),
            range.end.blockIndex,
            range.end.textIndex
          );
        } else if (isCtrl) {
          newState = moveToNextWord(clearSelection(newState));
        } else {
          newState = moveCursorRight(clearSelection(newState));
        }

        // If we moved to a visual block (image/line), select it; otherwise leave just cursor
        if (newState.document.cursor) {
          const targetBlock =
            newState.document.page.blocks[
              newState.document.cursor.position.blockIndex
            ];
          if (
            targetBlock &&
            (targetBlock.type === "image" || targetBlock.type === "line")
          ) {
            const visualBlockPosition = {
              blockIndex: newState.document.cursor.position.blockIndex,
              textIndex: 0,
            };
            newState = {
              ...newState,
              document: {
                ...newState.document,
                selection: {
                  anchor: visualBlockPosition,
                  focus: visualBlockPosition,
                  isForward: true,
                  isCollapsed: false,
                  lastUpdate: Date.now(),
                },
              },
            };
          }

          // Clear auto-created paragraph tracking only if we moved away from it
          if (
            state.ui.autoCreatedParagraph &&
            newState.document.cursor &&
            newState.document.cursor.position.blockIndex !==
              state.ui.autoCreatedParagraph.blockIndex
          ) {
            newState = clearAutoCreatedParagraph(newState);
          }
        }
      }
      break;
    case "ArrowUp":
      // Ensure editor is focused
      newState = updateFocus(state, true);

      if (keyEvent.shiftKey) {
        newState = extendSelectionUp(newState, viewport);
      } else {
        // Check if we're on a visual block (image/line) at the start of the page
        if (state.document.cursor) {
          const currentBlock =
            state.document.page.blocks[
              state.document.cursor.position.blockIndex
            ];
          const isFirstBlock = state.document.cursor.position.blockIndex === 0;

          if (
            isFirstBlock &&
            (currentBlock?.type === "image" || currentBlock?.type === "line")
          ) {
            // Create a new paragraph above the visual block
            const newParagraphId = nextId();
            const newParagraph: Block = {
              id: newParagraphId,
              type: "paragraph",
              chars: [],
              formats: [],
            };

            const blockInsertOp: Operation = {
              op: "block_insert",
              id: nextId(),
              clock: getClock(),
              pageId: getPageId(),
              afterBlockId: null,
              blockId: newParagraphId,
              blockType: "paragraph",
            };

            const newBlocks = [newParagraph, ...state.document.page.blocks];
            const newPage = { ...state.document.page, blocks: newBlocks };

            newState = {
              ...state,
              document: { ...state.document, page: newPage },
              ui: {
                ...state.ui,
                autoCreatedParagraph: {
                  blockIndex: 0,
                  blockId: newParagraph.id,
                },
              },
            };

            // Broadcast the operation
            ops.push(blockInsertOp);

            newState = clearSelection(newState);
            newState = moveCursorToPosition(newState, 0, 0);
            break;
          }
        }

        // Clear selection and move cursor
        newState = moveCursorUp(clearSelection(newState), viewport);

        // If we moved to a visual block (image/line), select it; otherwise leave just cursor
        if (newState.document.cursor) {
          const targetBlock =
            newState.document.page.blocks[
              newState.document.cursor.position.blockIndex
            ];
          if (
            targetBlock &&
            (targetBlock.type === "image" || targetBlock.type === "line")
          ) {
            const visualBlockPosition = {
              blockIndex: newState.document.cursor.position.blockIndex,
              textIndex: 0,
            };
            newState = {
              ...newState,
              document: {
                ...newState.document,
                selection: {
                  anchor: visualBlockPosition,
                  focus: visualBlockPosition,
                  isForward: true,
                  isCollapsed: false,
                  lastUpdate: Date.now(),
                },
              },
            };
          }

          // Clear auto-created paragraph tracking only if we moved away from it
          if (
            state.ui.autoCreatedParagraph &&
            newState.document.cursor &&
            newState.document.cursor.position.blockIndex !==
              state.ui.autoCreatedParagraph.blockIndex
          ) {
            newState = clearAutoCreatedParagraph(newState);
          }
        }
      }
      break;
    case "ArrowDown":
      // Ensure editor is focused
      newState = updateFocus(state, true);

      if (keyEvent.shiftKey) {
        newState = extendSelectionDown(newState, viewport);
      } else {
        // Check if we should remove an auto-created paragraph
        if (state.ui.autoCreatedParagraph && state.document.cursor) {
          const { blockIndex, blockId } = state.ui.autoCreatedParagraph;
          const currentBlock =
            state.document.page.blocks[
              state.document.cursor.position.blockIndex
            ];

          // If cursor is on the auto-created paragraph and it's still empty
          if (
            state.document.cursor.position.blockIndex === blockIndex &&
            currentBlock?.id === blockId &&
            currentBlock.type === "paragraph" &&
            isTextualBlock(currentBlock) &&
            getBlockTextContent(currentBlock) === ""
          ) {
            // Remove the auto-created paragraph and move to the visual block below
            const blockToDelete = state.document.page.blocks[blockIndex];

            const blockDeleteOp: Operation = {
              op: "block_delete",
              id: nextId(),
              clock: getClock(),
              pageId: getPageId(),
              blockId: blockToDelete.id,
            };
            ops.push(blockDeleteOp);

            const newBlocks = state.document.page.blocks.filter(
              (_, i) => i !== blockIndex
            );
            const newPage = { ...state.document.page, blocks: newBlocks };

            newState = {
              ...state,
              document: { ...state.document, page: newPage },
              ui: {
                ...state.ui,
                autoCreatedParagraph: null,
              },
            };

            // Broadcast the operation
            // Move cursor to the visual block that was below
            newState = clearSelection(newState);
            newState = moveCursorToPosition(newState, 0, 0);

            // Select the visual block (image/line)
            const visibleBlocks = getVisibleBlocks(newState.document.page);
            const firstBlock =
              visibleBlocks.length > 0 ? visibleBlocks[0] : null;
            if (firstBlock?.type === "image" || firstBlock?.type === "line") {
              newState = {
                ...newState,
                document: {
                  ...newState.document,
                  selection: {
                    anchor: { blockIndex: 0, textIndex: 0 },
                    focus: { blockIndex: 0, textIndex: 0 },
                    isForward: true,
                    isCollapsed: false,
                    lastUpdate: Date.now(),
                  },
                },
              };
            }
            break;
          }
        }

        // Check if we're on a visual block (image/line) at the end of the page
        if (state.document.cursor) {
          const currentBlock =
            state.document.page.blocks[
              state.document.cursor.position.blockIndex
            ];
          const visibleBlocks = getVisibleBlocks(state.document.page);
          const lastVisibleBlockIndex =
            visibleBlocks.length > 0
              ? state.document.page.blocks.findIndex(
                  (b) => b.id === visibleBlocks[visibleBlocks.length - 1].id
                )
              : -1;
          const isLastBlock =
            state.document.cursor.position.blockIndex === lastVisibleBlockIndex;

          if (
            isLastBlock &&
            (currentBlock?.type === "image" || currentBlock?.type === "line")
          ) {
            // Create a new paragraph below the visual block
            const newParagraphId = nextId();
            const newParagraph: Block = {
              id: newParagraphId,
              type: "paragraph",
              chars: [],
              formats: [],
            };

            const blockInsertOp: Operation = {
              op: "block_insert",
              id: nextId(),
              clock: getClock(),
              pageId: getPageId(),
              afterBlockId: currentBlock.id,
              blockId: newParagraphId,
              blockType: "paragraph",
            };

            const newBlocks = [...state.document.page.blocks, newParagraph];
            const newPage = { ...state.document.page, blocks: newBlocks };

            newState = {
              ...state,
              document: { ...state.document, page: newPage },
            };
            newState = clearSelection(newState);
            newState = moveCursorToPosition(newState, newBlocks.length - 1, 0);

            // Broadcast the operation
            ops.push(blockInsertOp);

            break;
          }
        }

        // Clear selection and move cursor
        newState = moveCursorDown(clearSelection(newState), viewport);

        // If we moved to a visual block (image/line), select it; otherwise leave just cursor
        if (newState.document.cursor) {
          const targetBlock =
            newState.document.page.blocks[
              newState.document.cursor.position.blockIndex
            ];
          if (
            targetBlock &&
            (targetBlock.type === "image" || targetBlock.type === "line")
          ) {
            const visualBlockPosition = {
              blockIndex: newState.document.cursor.position.blockIndex,
              textIndex: 0,
            };
            newState = {
              ...newState,
              document: {
                ...newState.document,
                selection: {
                  anchor: visualBlockPosition,
                  focus: visualBlockPosition,
                  isForward: true,
                  isCollapsed: false,
                  lastUpdate: Date.now(),
                },
              },
            };
          }

          // Clear auto-created paragraph tracking only if we moved away from it
          if (
            state.ui.autoCreatedParagraph &&
            newState.document.cursor &&
            newState.document.cursor.position.blockIndex !==
              state.ui.autoCreatedParagraph.blockIndex
          ) {
            newState = clearAutoCreatedParagraph(newState);
          }
        }
      }
      break;
    case "PageUp":
      // Ensure editor is focused
      newState = updateFocus(state, true);

      if (keyEvent.shiftKey) {
        newState = extendSelectionPageUp(newState, viewport);
      } else {
        newState = moveCursorPageUp(clearSelection(state), viewport);

        // If we moved to a visual block (image/line), select it; otherwise leave just cursor
        if (newState.document.cursor) {
          const targetBlock =
            newState.document.page.blocks[
              newState.document.cursor.position.blockIndex
            ];
          if (
            targetBlock &&
            (targetBlock.type === "image" || targetBlock.type === "line")
          ) {
            const visualBlockPosition = {
              blockIndex: newState.document.cursor.position.blockIndex,
              textIndex: 0,
            };
            newState = {
              ...newState,
              document: {
                ...newState.document,
                selection: {
                  anchor: visualBlockPosition,
                  focus: visualBlockPosition,
                  isForward: true,
                  isCollapsed: false,
                  lastUpdate: Date.now(),
                },
              },
            };
          }

          // Clear auto-created paragraph tracking only if we moved away from it
          if (
            state.ui.autoCreatedParagraph &&
            newState.document.cursor &&
            newState.document.cursor.position.blockIndex !==
              state.ui.autoCreatedParagraph.blockIndex
          ) {
            newState = clearAutoCreatedParagraph(newState);
          }
        }
      }
      break;
    case "PageDown":
      // Ensure editor is focused
      newState = updateFocus(state, true);

      if (keyEvent.shiftKey) {
        newState = extendSelectionPageDown(newState, viewport);
      } else {
        newState = moveCursorPageDown(clearSelection(state), viewport);

        // If we moved to a visual block (image/line), select it; otherwise leave just cursor
        if (newState.document.cursor) {
          const targetBlock =
            newState.document.page.blocks[
              newState.document.cursor.position.blockIndex
            ];
          if (
            targetBlock &&
            (targetBlock.type === "image" || targetBlock.type === "line")
          ) {
            const visualBlockPosition = {
              blockIndex: newState.document.cursor.position.blockIndex,
              textIndex: 0,
            };
            newState = {
              ...newState,
              document: {
                ...newState.document,
                selection: {
                  anchor: visualBlockPosition,
                  focus: visualBlockPosition,
                  isForward: true,
                  isCollapsed: false,
                  lastUpdate: Date.now(),
                },
              },
            };
          }

          // Clear auto-created paragraph tracking only if we moved away from it
          if (
            state.ui.autoCreatedParagraph &&
            newState.document.cursor &&
            newState.document.cursor.position.blockIndex !==
              state.ui.autoCreatedParagraph.blockIndex
          ) {
            newState = clearAutoCreatedParagraph(newState);
          }
        }
      }
      break;
    case "Home":
      // Ensure editor is focused
      newState = updateFocus(state, true);

      if (keyEvent.shiftKey) {
        newState = extendSelectionHome(newState, isCtrl);
      } else {
        if (isCtrl) {
          newState = moveCursorToPosition(clearSelection(state), 0, 0);
        } else {
          newState = moveToLineStart(clearSelection(state));
        }
      }
      break;
    case "End":
      // Ensure editor is focused
      newState = updateFocus(state, true);

      if (keyEvent.shiftKey) {
        newState = extendSelectionEnd(newState, isCtrl);
      } else {
        if (isCtrl) {
          // Get last visible block and find its index in the full array
          const visibleBlocks = getVisibleBlocks(state.document.page);
          if (visibleBlocks.length === 0) {
            newState = clearSelection(state);
          } else {
            const lastVisibleBlock = visibleBlocks[visibleBlocks.length - 1];
            const allBlocks = state.document.page.blocks;
            const lastVisibleBlockIndex = allBlocks.findIndex(
              (b) => b.id === lastVisibleBlock.id
            );
            if (lastVisibleBlockIndex !== -1) {
              newState = moveCursorToPosition(
                clearSelection(state),
                lastVisibleBlockIndex,
                getBlockTextLength(lastVisibleBlock)
              );
            } else {
              newState = clearSelection(state);
            }
          }
        } else {
          newState = moveToLineEnd(clearSelection(state));
        }
      }
      break;
    case "Escape":
      return { state: clearSelection(state), ops };
    case "Backspace":
      if (isCtrl) {
        const result = deleteWordBackward(state);
        newState = result.state;
        ops.push(...result.ops);
      } else {
        const result = deleteText(state);
        newState = result.state;
        ops.push(...result.ops);
      }
      // Clear auto-created paragraph tracking on delete
      newState = clearAutoCreatedParagraph(newState);
      break;
    case "Delete":
      if (isCtrl) {
        const result = deleteWordForward(state);
        newState = result.state;
        ops.push(...result.ops);
      } else {
        const result = deleteForward(state);
        newState = result.state;
        ops.push(...result.ops);
      }
      // Clear auto-created paragraph tracking on delete
      newState = clearAutoCreatedParagraph(newState);
      break;
    case "Enter":
      const splitResult = splitBlock(state);
      newState = splitResult.state;
      ops.push(...splitResult.ops);
      // Clear auto-created paragraph tracking on enter
      newState = clearAutoCreatedParagraph(newState);
      break;
    case " ":
    case "Space":
      const spaceResult = insertText(state, " ");
      newState = spaceResult.state;
      ops.push(...spaceResult.ops);
      // Clear auto-created paragraph tracking on space (already cleared in insertText, but for safety)
      newState = clearAutoCreatedParagraph(newState);
      break;
    default:
      // Check if typing "/" at the start of a block (only on desktop)
      if (
        key === "/" &&
        !isTouchDevice() &&
        state.document.cursor &&
        !keyEvent.ctrlKey &&
        !keyEvent.altKey &&
        !keyEvent.metaKey
      ) {
        const { blockIndex } = state.document.cursor.position;

        // Allow slash command anywhere in paragraphs and headings
        const slashResult = insertText(state, "/");
        const newState = slashResult.state;
        ops.push(...slashResult.ops);
        if (newState.document.cursor) {
          const finalState = openSlashCommand(
            newState,
            blockIndex,
            newState.document.cursor.position.textIndex
          );
          ensureCursorVisible(
            finalState,
            state,
            viewport,
            updateViewportCallback
          );
          return { state: finalState, ops };
        }
        return { state: newState, ops };
      }

      if (
        key.length === 1 &&
        !keyEvent.ctrlKey &&
        !keyEvent.altKey &&
        !keyEvent.metaKey
      ) {
        const result = insertText(state, key);
        newState = result.state;
        ops.push(...result.ops);
        break;
      }
      return { state, ops };
  }

  if (
    newState !== state &&
    newState.document.cursor &&
    updateViewportCallback
  ) {
    const newScrollY = scrollToMakeCursorVisible(
      newState.document.cursor.position,
      newState,
      viewport
    );
    if (newScrollY !== null) {
      updateViewportCallback({ scrollY: newScrollY });
    }
  }

  return { state: newState, ops };
}
export function handleContextMenu(
  state: EditorState,
  viewport: ViewportState,
  event: MouseEvent,
  containerRect: { left: number; top: number },
  visibility: { start: number; end: number }
): EditorState {
  event.preventDefault();

  // Don't open context menu if we're dragging an image
  if (state.ui.imageDrag) {
    return state;
  }

  const canvasX = event.x - containerRect.left;
  const canvasY = event.y - containerRect.top;

  const position = getTextPositionFromViewport(
    canvasX,
    canvasY,
    state,
    viewport,
    visibility
  );

  // Always open context menu at click position if we have a valid position
  // Preserve existing selection for copy/cut operations
  if (position) {
    // Only update cursor/clear selection if there's no selection active
    // This preserves "Select All" and other selections when right-clicking
    if (!state.document.selection) {
      state = updateCursor(state, position);
    }

    // Clear link hover tooltip and slash menu when opening context menu
    state = {
      ...state,
      ui: {
        ...state.ui,
        isHoveringLinkWithModifier: false,
      },
    };

    state = openContextMenu(state, canvasX, canvasY);
  }

  return state;
}
