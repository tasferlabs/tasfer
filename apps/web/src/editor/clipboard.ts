import type { EditorState, Position } from "./types";
import type { Block } from "../deserializer/loadPage";
import {
  getBlockTextContent,
  moveCursorToPosition,
  clearSelection,
  generateBlockId,
} from "./state";
import { 
  getSelectionRange, 
  deleteSelectedText,
  insertTextIntoFormattedContent,
  deleteTextRangeInFormattedContent,
  mergeAdjacentSegments,
} from "./commands";
import { recordUndo } from "./undo";
import { invalidateBlockCache } from "./renderer";

export function hasNativeBridge(): boolean {
  return !!(window.IOSBridge || window.AndroidBridge);
}

async function copyToNativeClipboard(text: string): Promise<boolean> {
  try {
    if (window.IOSBridge) {
      window.IOSBridge.postMessage({
        action: "copy",
        text,
      });
      return true;
    }

    if (window.AndroidBridge) {
      window.AndroidBridge.copy(text);
      return true;
    }

    return false;
  } catch (error) {
    console.error("Failed to copy to native clipboard:", error);
    return false;
  }
}

async function cutToNativeClipboard(text: string): Promise<boolean> {
  try {
    if (window.IOSBridge) {
      window.IOSBridge.postMessage({
        action: "cut",
        text,
      });
      return true;
    }

    if (window.AndroidBridge) {
      window.AndroidBridge.cut(text);
      return true;
    }

    return false;
  } catch (error) {
    console.error("Failed to cut to native clipboard:", error);
    return false;
  }
}

async function pasteFromNativeClipboard(): Promise<string | null> {
  try {
    if (window.IOSBridge) {
      return new Promise((resolve) => {
        window.IOSBridge!.postMessage({
          action: "paste",
        });
        const handler = (event: MessageEvent) => {
          if (event.data?.type === "clipboard-paste") {
            window.removeEventListener("message", handler);
            resolve(event.data.text || null);
          }
        };
        window.addEventListener("message", handler);
        setTimeout(() => {
          window.removeEventListener("message", handler);
          resolve(null);
        }, 1000);
      });
    }

    if (window.AndroidBridge) {
      const text = window.AndroidBridge.paste();
      return text || null;
    }

    return null;
  } catch (error) {
    console.error("Failed to paste from native clipboard:", error);
    return null;
  }
}

/**
 * Get the selected content from the editor state
 */
function getSelectedContent(state: EditorState): {
  blocks: Block[];
  isPartial: boolean;
  start: Position;
  end: Position;
} | null {
  const range = getSelectionRange(state);
  if (!range) return null;

  const { start, end } = range;

  // If selection is in a single block
  if (start.blockIndex === end.blockIndex) {
    const block = state.page.blocks[start.blockIndex];
    const text = getBlockTextContent(block);
    
    // Extract the selected portion while preserving formatting
    const selectedContent = deleteTextRangeInFormattedContent(
      deleteTextRangeInFormattedContent(block.content, 0, start.textIndex),
      end.textIndex - start.textIndex,
      text.length
    );

    const partialBlock: Block = {
      ...block,
      content: selectedContent,
    };

    return {
      blocks: [partialBlock],
      isPartial: start.textIndex > 0 || end.textIndex < text.length,
      start,
      end,
    };
  }

  // Multi-block selection
  const blocks: Block[] = [];

  for (let i = start.blockIndex; i <= end.blockIndex; i++) {
    const block = state.page.blocks[i];
    const text = getBlockTextContent(block);

    let blockContent = block.content;
    if (i === start.blockIndex) {
      // First block - cut from start position, preserving formatting
      blockContent = deleteTextRangeInFormattedContent(
        block.content,
        0,
        start.textIndex
      );
    } else if (i === end.blockIndex) {
      // Last block - cut to end position, preserving formatting
      blockContent = deleteTextRangeInFormattedContent(
        block.content,
        end.textIndex,
        text.length
      );
    }
    // Middle blocks - include full content with formatting

    const newBlock: Block = {
      ...block,
      content: blockContent,
    };

    blocks.push(newBlock);
  }

  return {
    blocks,
    isPartial: true,
    start,
    end,
  };
}

/**
 * Convert blocks to plain text
 */
function blocksToPlainText(blocks: Block[]): string {
  return blocks.map((block) => getBlockTextContent(block)).join("\n\n");
}

/**
 * Convert blocks to markdown with formatting
 */
function blocksToMarkdown(blocks: Block[]): string {
  return blocks
    .map((block) => {
      const content = getBlockTextContent(block);
      let prefix = "";
      if (block.type === "heading1") prefix = "# ";
      else if (block.type === "heading2") prefix = "## ";
      else if (block.type === "heading3") prefix = "### ";
      return prefix + content;
    })
    .join("\n\n");
}

/**
 * Convert blocks to HTML with formatting
 */
function blocksToHTML(blocks: Block[]): string {
  const htmlBlocks = blocks.map((block) => {
    const content = getBlockTextContent(block);
    // Escape HTML special characters
    const escapedContent = content
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");

    switch (block.type) {
      case "heading1":
        return `<h1>${escapedContent}</h1>`;
      case "heading2":
        return `<h2>${escapedContent}</h2>`;
      case "heading3":
        return `<h3>${escapedContent}</h3>`;
      case "paragraph":
      default:
        return `<p>${escapedContent}</p>`;
    }
  });

  return htmlBlocks.join("\n");
}

/**
 * Copy selected content to clipboard with formatting
 * Returns true if successful, false otherwise
 */
export async function copySelectionToClipboard(
  state: EditorState
): Promise<boolean> {
  try {
    const selectedContent = getSelectedContent(state);
    if (!selectedContent) return false;

    const { blocks } = selectedContent;
    if (blocks.length === 0) return false;

    const plainText = blocksToPlainText(blocks);
    const markdown = blocksToMarkdown(blocks);
    const html = blocksToHTML(blocks);

    if (hasNativeBridge()) {
      return await copyToNativeClipboard(markdown);
    }

    if (navigator.clipboard && navigator.clipboard.write) {
      const clipboardItems = [
        new ClipboardItem({
          "text/plain": new Blob([plainText], { type: "text/plain" }),
          "text/html": new Blob([html], { type: "text/html" }),
        }),
      ];

      await navigator.clipboard.write(clipboardItems);
      return true;
    } else if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(markdown);
      return true;
    }

    return false;
  } catch (error) {
    console.error("Failed to copy to clipboard:", error);
    return false;
  }
}

export async function cutSelectionToClipboard(
  state: EditorState
): Promise<{ success: boolean; newState: EditorState | null }> {
  try {
    const selectedContent = getSelectedContent(state);
    if (!selectedContent) return { success: false, newState: null };

    const { blocks } = selectedContent;
    if (blocks.length === 0) return { success: false, newState: null };

    const markdown = blocksToMarkdown(blocks);

    let success = false;
    if (hasNativeBridge()) {
      success = await cutToNativeClipboard(markdown);
    } else {
      success = await copySelectionToClipboard(state);
    }

    if (success) {
      const newState = deleteSelectedText(recordUndo(state));
      return { success: true, newState };
    }

    return { success: false, newState: null };
  } catch (error) {
    console.error("Failed to cut to clipboard:", error);
    return { success: false, newState: null };
  }
}

/**
 * Parse HTML string into blocks
 */
function parseHTMLToBlocks(html: string): Block[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");
  const blocks: Block[] = [];

  // Get all top-level elements from body
  const elements = doc.body.children;

  for (let i = 0; i < elements.length; i++) {
    const element = elements[i];
    const tagName = element.tagName.toLowerCase();
    const text = element.textContent || "";

    let block: Block;

    switch (tagName) {
      case "h1":
        block = {
          id: generateBlockId(),
          type: "heading1",
          content: [{ content: text }],
        };
        break;
      case "h2":
        block = {
          id: generateBlockId(),
          type: "heading2",
          content: [{ content: text }],
        };
        break;
      case "h3":
        block = {
          id: generateBlockId(),
          type: "heading3",
          content: [{ content: text }],
        };
        break;
      case "p":
      case "div":
      case "span":
      default:
        block = {
          id: generateBlockId(),
          type: "paragraph",
          content: [{ content: text }],
        };
        break;
    }

    blocks.push(block);
  }

  // If no blocks were parsed, treat the entire content as paragraphs
  if (blocks.length === 0 && doc.body.textContent) {
    const lines = doc.body.textContent.split("\n");
    for (const line of lines) {
      blocks.push({
        id: generateBlockId(),
        type: "paragraph",
        content: [{ content: line }],
      });
    }
  }

  return blocks;
}

/**
 * Parse plain text into blocks
 * Respects markdown-style headings (# ## ###)
 */
function parsePlainTextToBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.split("\n");

  for (const line of lines) {
    let block: Block;

    // Check for markdown-style headings
    if (line.startsWith("### ")) {
      block = {
        id: generateBlockId(),
        type: "heading3",
        content: [{ content: line.slice(4) }],
      };
    } else if (line.startsWith("## ")) {
      block = {
        id: generateBlockId(),
        type: "heading2",
        content: [{ content: line.slice(3) }],
      };
    } else if (line.startsWith("# ")) {
      block = {
        id: generateBlockId(),
        type: "heading1",
        content: [{ content: line.slice(2) }],
      };
    } else {
      // Regular paragraph
      block = {
        id: generateBlockId(),
        type: "paragraph",
        content: [{ content: line }],
      };
    }

    blocks.push(block);
  }

  return blocks;
}

/**
 * Paste content from native clipboard (for mobile apps)
 */
export async function pasteFromNativeClipboardAPI(
  state: EditorState
): Promise<EditorState | null> {
  try {
    const text = await pasteFromNativeClipboard();
    if (!text) return null;

    const blocks = parsePlainTextToBlocks(text);
    if (blocks.length === 0) return null;

    return insertBlocksAtCursor(state, blocks);
  } catch (error) {
    console.error("Failed to paste from native clipboard:", error);
    return null;
  }
}

/**
 * Insert blocks at cursor position
 * If there's a selection, it will be deleted first
 * If no cursor is set, inserts at the end of the document
 */
function insertBlocksAtCursor(
  state: EditorState,
  blocks: Block[]
): EditorState {
  if (blocks.length === 0) return state;

  // Record undo state before modification
  let newState = recordUndo(state);

  // If there's a selection, delete it first
  if (newState.selection && !newState.selection.isCollapsed) {
    newState = deleteSelectedText(newState);
  }

  // If no cursor is set, default to the end of the document
  let blockIndex: number;
  let textIndex: number;

  if (!newState.cursor) {
    // Insert at the end of the last block
    blockIndex = newState.page.blocks.length - 1;
    const lastBlock = newState.page.blocks[blockIndex];
    textIndex = getBlockTextContent(lastBlock).length;
  } else {
    blockIndex = newState.cursor.position.blockIndex;
    textIndex = newState.cursor.position.textIndex;
  }

  // Ensure cursor position is valid
  if (blockIndex < 0 || blockIndex >= newState.page.blocks.length) {
    blockIndex = newState.page.blocks.length - 1;
    const lastBlock = newState.page.blocks[blockIndex];
    textIndex = getBlockTextContent(lastBlock).length;
  }
  const currentBlock = newState.page.blocks[blockIndex];
  const currentText = getBlockTextContent(currentBlock);

  // If pasting a single block
  if (blocks.length === 1) {
    // Merge the pasted block's formatted content into current block at cursor position
    const pasteContent = blocks[0].content;
    
    // Insert the pasted formatted content at the cursor position
    let newContent = currentBlock.content;
    
    // For each segment in the pasted content, insert it
    for (const segment of pasteContent) {
      newContent = insertTextIntoFormattedContent(
        newContent,
        textIndex,
        segment.content
      );
      // Update textIndex to account for the inserted text length
      // But we need to preserve the segment's formatting, so let's do it differently
    }
    
    // Actually, let's properly merge the formatted content arrays
    const beforeContent = deleteTextRangeInFormattedContent(
      currentBlock.content,
      textIndex,
      getBlockTextContent(currentBlock).length
    );
    const afterContent = deleteTextRangeInFormattedContent(
      currentBlock.content,
      0,
      textIndex
    );
    
    // Merge: before + pasted + after
    const mergedContent = [...beforeContent, ...pasteContent, ...afterContent];
    const pasteTextLength = getBlockTextContent(blocks[0]).length;

    const newBlock: Block = {
      ...currentBlock,
      content: mergeAdjacentSegments(mergedContent),
    };

    // Invalidate only the affected block
    invalidateBlockCache(newBlock);

    const newBlocks = [
      ...newState.page.blocks.slice(0, blockIndex),
      newBlock,
      ...newState.page.blocks.slice(blockIndex + 1),
    ];

    newState = {
      ...newState,
      page: { ...newState.page, blocks: newBlocks },
    };

    // Move cursor to end of pasted text
    newState = moveCursorToPosition(
      newState,
      blockIndex,
      textIndex + pasteTextLength
    );
  } else {
    // Pasting multiple blocks - preserve formatting in split blocks
    const beforeContent = deleteTextRangeInFormattedContent(
      currentBlock.content,
      textIndex,
      currentText.length
    );
    const afterContent = deleteTextRangeInFormattedContent(
      currentBlock.content,
      0,
      textIndex
    );

    // First block: current block's content before cursor + first pasted block's content
    const firstPastedContent = blocks[0].content;
    const firstBlockContent = [...beforeContent, ...firstPastedContent];
    const firstBlock: Block = {
      ...blocks[0],
      content: mergeAdjacentSegments(firstBlockContent),
    };

    // Middle blocks: paste as-is
    const middleBlocks = blocks.slice(1, -1);

    // Last block: last pasted block's content + current block's content after cursor
    const lastPastedContent = blocks[blocks.length - 1].content;
    const lastBlockContent = [...lastPastedContent, ...afterContent];
    const lastBlock: Block = {
      ...blocks[blocks.length - 1],
      content: mergeAdjacentSegments(lastBlockContent),
    };

    // Invalidate cache for the modified blocks (first and last)
    invalidateBlockCache(firstBlock);
    invalidateBlockCache(lastBlock);

    const newBlocks = [
      ...newState.page.blocks.slice(0, blockIndex),
      firstBlock,
      ...middleBlocks,
      lastBlock,
      ...newState.page.blocks.slice(blockIndex + 1),
    ];

    newState = {
      ...newState,
      page: { ...newState.page, blocks: newBlocks },
    };

    // Move cursor to end of last pasted block
    const lastBlockIndex = blockIndex + blocks.length - 1;
    const lastPastedText = getBlockTextContent(blocks[blocks.length - 1]);
    newState = moveCursorToPosition(
      newState,
      lastBlockIndex,
      lastPastedText.length
    );
  }

  return clearSelection(newState);
}

/**
 * Paste content from ClipboardEvent with HTML formatting (Ctrl+V)
 * This uses the paste event's clipboardData, which doesn't require permission
 */
export function pasteFromClipboardEvent(
  state: EditorState,
  event: ClipboardEvent,
  extractedData?: { html: string; text: string } | null
): EditorState | null {
  // Use extracted data if provided (from immediate event handler)
  // Otherwise try to get from event (may be empty if not called synchronously)
  let html = "";
  let text = "";

  if (extractedData) {
    html = extractedData.html;
    text = extractedData.text;
  } else {
    const clipboardData = event.clipboardData;
    if (!clipboardData) {
      console.error("Failed to paste from clipboard event: no clipboard data");
      return null;
    }
    html = clipboardData.getData("text/html");
    text = clipboardData.getData("text/plain") || clipboardData.getData("text");
  }

  // Try to get HTML first
  if (html) {
    const blocks = parseHTMLToBlocks(html);
    if (blocks.length > 0) {
      return insertBlocksAtCursor(state, blocks);
    }
  }

  // Fallback to plain text
  if (text) {
    const blocks = parsePlainTextToBlocks(text);
    if (blocks.length > 0) {
      return insertBlocksAtCursor(state, blocks);
    }
  }

  return null;
}

/**
 * Paste content from ClipboardEvent as plain text only (Ctrl+Shift+V)
 * This uses the paste event's clipboardData, which doesn't require permission
 */
export function pasteFromClipboardEventAsPlainText(
  state: EditorState,
  event: ClipboardEvent
): Promise<EditorState | null> {
  return new Promise((resolve) => {
    try {
      const clipboardData = event.clipboardData;
      if (!clipboardData) {
        resolve(null);
        console.error(
          "Failed to paste from clipboard event: no clipboard data"
        );
        return;
      }

      const text =
        clipboardData.getData("text/plain") || clipboardData.getData("text");
      if (!text) {
        resolve(null);
        console.error("Failed to paste from clipboard event: no text");
        return;
      }

      const blocks = parsePlainTextToBlocks(text);
      if (blocks.length === 0) {
        resolve(null);
        return;
      }

      resolve(insertBlocksAtCursor(state, blocks));
    } catch (error) {
      console.error("Failed to paste plain text from clipboard event:", error);
      resolve(null);
    }
  });
}
