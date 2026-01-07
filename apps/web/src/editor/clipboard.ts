import type { EditorState, Position } from "./types";
import type { Block } from "../deserializer/loadPage";
import { isTextBlock, isListBlock } from "../deserializer/loadPage";
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
import { serializeToMarkdown } from "../deserializer/serializer";
import { loadPage } from "../deserializer/loadPage";
import { IMAGE_DEFAULT_HEIGHT } from "./constants";

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
    const block = state.document.page.blocks[start.blockIndex];
    const text = getBlockTextContent(block);
    
    // Image cover blocks are included as-is
    if (block.type === "image") {
      return {
        blocks: [block],
        isPartial: false,
        start,
        end,
      };
    }
    
    if (!isTextBlock(block)) {
      return {
        blocks: [block],
        isPartial: false,
        start,
        end,
      };
    }
    
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
    const block = state.document.page.blocks[i];
    const text = getBlockTextContent(block);

    // Image cover blocks are included as-is
    if (block.type === "image") {
      blocks.push(block);
      continue;
    }

    if (!isTextBlock(block)) {
      blocks.push(block);
      continue;
    }

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
  // Use the proper serializer that handles inline formatting
  return serializeToMarkdown(blocks);
}

/**
 * Convert blocks to HTML with formatting
 */
function blocksToHTML(blocks: Block[]): string {
  const htmlBlocks = blocks.map((block) => {
    // Handle image cover blocks
    if (block.type === "image") {
      const alt = block.alt || "";
      
      // Check if image has custom properties
      const width = block.width ?? 'full';
      const height = block.height ?? IMAGE_DEFAULT_HEIGHT;
      const objectFit = block.objectFit ?? 'cover';
      
      // Always output with full properties for HTML clipboard
      const widthAttr = width === 'full' ? 'data-width="full"' : `width="${width}"`;
      const heightAttr = `height="${height}"`;
      const objectFitAttr = `data-object-fit="${objectFit}"`;
      const altAttr = alt ? ` alt="${alt}"` : '';
      
      return `<img src="${block.url}"${altAttr} ${widthAttr} ${heightAttr} ${objectFitAttr} />`;
    }

    if (!isTextBlock(block)) {
      return "";
    }

    // Build content with inline formatting as HTML
    let htmlContent = "";
    
    for (const segment of block.content) {
      // Escape HTML special characters
      let text = segment.content
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
      
      // Apply formats as HTML tags
      if (segment.formats) {
        for (const format of segment.formats) {
          if (format.type === 'bold') {
            text = `<strong>${text}</strong>`;
          } else if (format.type === 'italic') {
            text = `<em>${text}</em>`;
          } else if (format.type === 'strikethrough') {
            text = `<s>${text}</s>`;
          } else if (format.type === 'code') {
            text = `<code>${text}</code>`;
          } else if (format.type === 'link' && format.url) {
            text = `<a href="${format.url}">${text}</a>`;
          }
        }
      }
      
      htmlContent += text;
    }

    switch (block.type) {
      case "heading1":
        return `<h1>${htmlContent}</h1>`;
      case "heading2":
        return `<h2>${htmlContent}</h2>`;
      case "heading3":
        return `<h3>${htmlContent}</h3>`;
      case "bullet_list": {
        const indent = isListBlock(block) ? block.indent : 0;
        const indentStyle = indent > 0 ? ` style="margin-left: ${indent * 24}px"` : '';
        return `<li${indentStyle}>${htmlContent}</li>`;
      }
      case "numbered_list": {
        const indent = isListBlock(block) ? block.indent : 0;
        const indentStyle = indent > 0 ? ` style="margin-left: ${indent * 24}px"` : '';
        return `<li${indentStyle} data-list-type="numbered">${htmlContent}</li>`;
      }
      case "todo_list": {
        const indent = isListBlock(block) ? block.indent : 0;
        const checked = isListBlock(block) && block.type === "todo_list" ? block.checked : false;
        const indentStyle = indent > 0 ? ` style="margin-left: ${indent * 24}px"` : '';
        const checkbox = checked ? '[x]' : '[ ]';
        return `<li${indentStyle} data-list-type="todo" data-checked="${checked}">${checkbox} ${htmlContent}</li>`;
      }
      case "paragraph":
      default:
        return `<p>${htmlContent}</p>`;
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
 * Clean up Google Docs HTML by removing metadata and normalizing structure
 */
function cleanGoogleDocsHTML(html: string): string {
  // Remove Google Docs meta tags
  html = html.replace(/<meta[^>]*>/g, '');
  
  // Remove Google Docs internal wrapper with ID
  html = html.replace(/<b[^>]*id="docs-internal-guid-[^"]*"[^>]*>/g, '');
  html = html.replace(/<\/b>/g, '');
  
  // Convert multiple <br> or <br /> tags into paragraph separators
  html = html.replace(/(<br\s*\/?>\s*){2,}/gi, '</p><p>');
  
  // Wrap unwrapped text in paragraphs if needed
  html = html.trim();
  
  return html;
}

/**
 * Check if an element has Google Docs styling that indicates bold/italic
 */
function hasGoogleDocsFormat(element: Element, format: 'bold' | 'italic'): boolean {
  const style = element.getAttribute('style') || '';
  
  if (format === 'bold') {
    // Check for font-weight in inline styles
    const fontWeightMatch = style.match(/font-weight:\s*(\d+|bold)/i);
    if (fontWeightMatch) {
      const weight = fontWeightMatch[1];
      return weight === 'bold' || parseInt(weight) >= 600;
    }
  } else if (format === 'italic') {
    // Check for font-style in inline styles
    return /font-style:\s*italic/i.test(style);
  }
  
  return false;
}

/**
 * Parse HTML string into blocks with inline formatting
 */
function parseHTMLToBlocks(html: string): Block[] {
  // Clean up Google Docs HTML first
  html = cleanGoogleDocsHTML(html);
  
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");
  const blocks: Block[] = [];

  // Helper function to recursively extract text with formatting from DOM nodes
  function extractTextWithFormatting(node: Node, currentFormats: any[] = []): any[] {
    const segments: any[] = [];

    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent || "";
      if (text) {
        segments.push({
          content: text,
          formats: currentFormats.length > 0 ? [...currentFormats] : undefined,
        });
      }
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const element = node as Element;
      const tagName = element.tagName.toLowerCase();
      let newFormats = [...currentFormats];

      // Skip meta tags and other non-content elements
      if (tagName === 'meta' || tagName === 'script' || tagName === 'style' || tagName === 'svg') {
        return segments;
      }

      // Add format based on tag
      if (tagName === "strong" || tagName === "b") {
        // For <b> tags, check if it's actually bold (Google Docs uses <b> with font-weight:normal)
        if (tagName === "b" && hasGoogleDocsFormat(element, 'bold')) {
          newFormats.push({ type: "bold" });
        } else if (tagName === "strong") {
          newFormats.push({ type: "bold" });
        } else if (tagName === "b" && !element.hasAttribute('style')) {
          // Regular <b> tag without styles
          newFormats.push({ type: "bold" });
        }
      } else if (tagName === "em" || tagName === "i") {
        newFormats.push({ type: "italic" });
      } else if (tagName === "s" || tagName === "strike" || tagName === "del") {
        newFormats.push({ type: "strikethrough" });
      } else if (tagName === "code") {
        newFormats.push({ type: "code" });
      } else if (tagName === "a") {
        const href = element.getAttribute("href");
        if (href) {
          newFormats.push({ type: "link", url: href });
        }
      } else if (tagName === "span") {
        // Check for Google Docs inline styling on spans
        if (hasGoogleDocsFormat(element, 'bold')) {
          newFormats.push({ type: "bold" });
        }
        if (hasGoogleDocsFormat(element, 'italic')) {
          newFormats.push({ type: "italic" });
        }
      }

      // Handle <br> tags as text breaks within the same block
      if (tagName === "br") {
        segments.push({
          content: "\n",
          formats: currentFormats.length > 0 ? [...currentFormats] : undefined,
        });
        return segments;
      }
      
      // Handle <img> tags - these should be handled as blocks, not inline
      // Skip them here and they'll be processed separately
      if (tagName === "img") {
        return segments;
      }

      // Process child nodes
      for (let i = 0; i < node.childNodes.length; i++) {
        segments.push(...extractTextWithFormatting(node.childNodes[i], newFormats));
      }
    }

    return segments;
  }

  // Helper function to check if an element is a block-level content element
  function isBlockElement(tagName: string): boolean {
    return ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'li', 'img'].includes(tagName);
  }

  // Helper function to check if an element is a container element
  function isContainerElement(tagName: string): boolean {
    return ['div', 'main', 'article', 'section', 'header', 'footer', 'nav', 'aside', 'ul', 'ol'].includes(tagName);
  }

  // Recursively find all block-level elements, even if deeply nested
  // Also handles orphaned text nodes by wrapping them in synthetic paragraphs
  function findBlockElements(element: Element): Array<Element | { syntheticParagraph: true; content: any[] }> {
    const blockElements: Array<Element | { syntheticParagraph: true; content: any[] }> = [];
    const tagName = element.tagName.toLowerCase();

    // If this is a block element itself, add it
    if (isBlockElement(tagName)) {
      blockElements.push(element);
      return blockElements;
    }

    // If this is a container, recursively search its children
    if (isContainerElement(tagName) || tagName === 'body') {
      // Check if there's any meaningful direct text content (orphaned text nodes)
      let hasDirectText = false;
      
      for (let i = 0; i < element.childNodes.length; i++) {
        const child = element.childNodes[i];
        
        // Check for text nodes or inline elements (like <span>, <a>) that aren't in block elements
        if (child.nodeType === Node.TEXT_NODE) {
          const text = child.textContent?.trim();
          if (text) {
            hasDirectText = true;
            break;
          }
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          const childElement = child as Element;
          const childTag = childElement.tagName.toLowerCase();
          
          // If it's an inline element or unknown element, check if it has text
          if (!isBlockElement(childTag) && !isContainerElement(childTag)) {
            const text = childElement.textContent?.trim();
            if (text) {
              hasDirectText = true;
              break;
            }
          }
        }
      }
      
      // If there's direct text content, treat the whole container as a paragraph
      if (hasDirectText) {
        const content = extractTextWithFormatting(element);
        if (content.length > 0 && content.some(seg => seg.content.trim())) {
          blockElements.push({
            syntheticParagraph: true,
            content: content,
          });
        }
        return blockElements;
      }
      
      // Otherwise, recursively search children
      for (let i = 0; i < element.children.length; i++) {
        blockElements.push(...findBlockElements(element.children[i]));
      }
      return blockElements;
    }

    // For other elements (like span), treat as inline content - don't recurse
    return blockElements;
  }

  // Find all block elements recursively
  const blockElements = findBlockElements(doc.body);

  // If there are no block-level elements but there's content, wrap it
  if (blockElements.length === 0 && doc.body.textContent?.trim()) {
    const content = extractTextWithFormatting(doc.body);
    if (content.length > 0) {
      blocks.push({
        id: generateBlockId(),
        type: "paragraph",
        content: content,
      });
    }
    return blocks;
  }

  // Process each block element (including synthetic paragraphs)
  for (const element of blockElements) {
    // Handle synthetic paragraphs (orphaned text from containers)
    if ('syntheticParagraph' in element) {
      const content = element.content;
      const hasContent = content.some((seg: any) => seg.content.trim().length > 0);
      if (hasContent) {
        blocks.push({
          id: generateBlockId(),
          type: "paragraph",
          content: content,
        });
      }
      continue;
    }
    
    // Handle regular HTML elements
    const tagName = element.tagName.toLowerCase();
    
    // Handle img tags
    if (tagName === 'img') {
      const src = element.getAttribute('src');
      if (src) {
        const alt = element.getAttribute('alt') || '';
        const widthAttr = element.getAttribute('width') || element.getAttribute('data-width');
        const heightAttr = element.getAttribute('height');
        const objectFitAttr = element.getAttribute('data-object-fit');
        
        const width = widthAttr === 'full' ? 'full' : (widthAttr ? parseInt(widthAttr, 10) : undefined);
        const height = heightAttr ? parseInt(heightAttr, 10) : undefined;
        const objectFit = objectFitAttr as ('cover' | 'contain') | undefined;
        
        blocks.push({
          id: generateBlockId(),
          type: "image",
          url: src,
          alt,
          width,
          height,
          objectFit,
        });
      }
      continue;
    }
    
    // Extract formatted content
    const content = extractTextWithFormatting(element);
    
    // Skip empty blocks (except if they have meaningful line breaks)
    const hasContent = content.some(seg => seg.content.trim().length > 0);
    if (!hasContent) continue;
    
    // Check if this is a list item
    if (tagName === 'li') {
      const listType = element.getAttribute('data-list-type');
      const indentStyle = element.getAttribute('style');
      const indentMatch = indentStyle?.match(/margin-left:\s*(\d+)px/);
      const indent = indentMatch ? Math.floor(parseInt(indentMatch[1], 10) / 24) : 0;
      
      if (listType === 'todo') {
        const checked = element.getAttribute('data-checked') === 'true';
        blocks.push({
          id: generateBlockId(),
          type: "todo_list",
          content: content.length > 0 ? content : [{ content: "" }],
          checked,
          indent,
        });
      } else if (listType === 'numbered') {
        blocks.push({
          id: generateBlockId(),
          type: "numbered_list",
          content: content.length > 0 ? content : [{ content: "" }],
          indent,
        });
      } else {
        // Default to bullet list for generic <li> tags
        blocks.push({
          id: generateBlockId(),
          type: "bullet_list",
          content: content.length > 0 ? content : [{ content: "" }],
          indent,
        });
      }
      continue;
    }
    
    let blockType: "heading1" | "heading2" | "heading3" | "paragraph" = "paragraph";

    switch (tagName) {
      case "h1":
        blockType = "heading1";
        break;
      case "h2":
        blockType = "heading2";
        break;
      case "h3":
        blockType = "heading3";
        break;
      case "h4":
      case "h5":
      case "h6":
        // Map h4-h6 to heading3
        blockType = "heading3";
        break;
      case "p":
      case "blockquote":
      case "pre":
      default:
        blockType = "paragraph";
        break;
    }

    const block: Block = {
      id: generateBlockId(),
      type: blockType,
      content: content.length > 0 ? content : [{ content: "" }],
    };

    blocks.push(block);
  }

  // If no blocks were parsed, treat the entire content as paragraphs
  if (blocks.length === 0 && doc.body.textContent) {
    const lines = doc.body.textContent.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) {
        blocks.push({
          id: generateBlockId(),
          type: "paragraph",
          content: [{ content: trimmed }],
        });
      }
    }
  }

  return blocks;
}

/**
 * Parse plain text into blocks
 * Respects markdown formatting including inline formats
 */
function parsePlainTextToBlocks(text: string): Block[] {
  try {
    // Use the markdown parser to properly handle inline formatting
    const page = loadPage(text);
    return page.blocks;
  } catch (error) {
    console.error("Failed to parse markdown, falling back to plain text:", error);
    
    // Fallback: create simple blocks without formatting
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
  if (newState.document.selection && !newState.document.selection.isCollapsed) {
    newState = deleteSelectedText(newState);
  }

  // If no cursor is set, default to the end of the document
  let blockIndex: number;
  let textIndex: number;

  if (!newState.document.cursor) {
    // Insert at the end of the last block
    blockIndex = newState.document.page.blocks.length - 1;
    const lastBlock = newState.document.page.blocks[blockIndex];
    textIndex = getBlockTextContent(lastBlock).length;
  } else {
    blockIndex = newState.document.cursor.position.blockIndex;
    textIndex = newState.document.cursor.position.textIndex;
  }

  // Ensure cursor position is valid
  if (blockIndex < 0 || blockIndex >= newState.document.page.blocks.length) {
    blockIndex = newState.document.page.blocks.length - 1;
    const lastBlock = newState.document.page.blocks[blockIndex];
    textIndex = getBlockTextContent(lastBlock).length;
  }
  const currentBlock = newState.document.page.blocks[blockIndex];
  const currentText = getBlockTextContent(currentBlock);

  // If pasting a single block
  if (blocks.length === 1) {
    // Can't paste into non-text blocks
    if (!isTextBlock(currentBlock)) {
      return state;
    }
    
    // Can't paste non-text blocks into text blocks
    if (!isTextBlock(blocks[0])) {
      return state;
    }
    
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
      ...newState.document.page.blocks.slice(0, blockIndex),
      newBlock,
      ...newState.document.page.blocks.slice(blockIndex + 1),
    ];

    newState = {
      ...newState,
      document: {
        ...newState.document,
        page: { ...newState.document.page, blocks: newBlocks },
      },
    };

    // Move cursor to end of pasted text
    newState = moveCursorToPosition(
      newState,
      blockIndex,
      textIndex + pasteTextLength
    );
  } else {
    // Pasting multiple blocks - preserve formatting in split blocks
    if (!isTextBlock(currentBlock)) {
      return state;
    }
    
    // Filter out non-text blocks from paste (or handle them separately)
    const textBlocks = blocks.filter(isTextBlock);
    if (textBlocks.length === 0) {
      return state;
    }
    
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
    const firstPastedContent = textBlocks[0].content;
    const firstBlockContent = [...beforeContent, ...firstPastedContent];
    const firstBlock: Block = {
      ...textBlocks[0],
      content: mergeAdjacentSegments(firstBlockContent),
    };

    // Middle blocks: paste as-is (only text blocks)
    const middleBlocks = textBlocks.slice(1, -1);

    // Last block: last pasted block's content + current block's content after cursor
    const lastPastedContent = textBlocks[textBlocks.length - 1].content;
    const lastBlockContent = [...lastPastedContent, ...afterContent];
    const lastBlock: Block = {
      ...textBlocks[textBlocks.length - 1],
      content: mergeAdjacentSegments(lastBlockContent),
    };

    // Invalidate cache for ALL pasted blocks
    invalidateBlockCache(firstBlock);
    for (const middleBlock of middleBlocks) {
      invalidateBlockCache(middleBlock);
    }
    invalidateBlockCache(lastBlock);

    const newBlocks = [
      ...newState.document.page.blocks.slice(0, blockIndex),
      firstBlock,
      ...middleBlocks,
      lastBlock,
      ...newState.document.page.blocks.slice(blockIndex + 1),
    ];

    newState = {
      ...newState,
      document: {
        ...newState.document,
        page: { ...newState.document.page, blocks: newBlocks },
      },
    };

    // Move cursor to end of last pasted block
    const lastBlockIndex = blockIndex + textBlocks.length - 1;
    const lastPastedText = getBlockTextContent(textBlocks[textBlocks.length - 1]);
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
  console.log("extractedData", extractedData);

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
    console.log("html", html);
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
