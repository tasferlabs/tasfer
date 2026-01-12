import type {
  Block,
  Char,
  FormatSpan,
  TextFormat,
} from "../../deserializer/loadPage";
import { isListBlock, isTextualBlock, loadPage } from "../../deserializer/loadPage";
import { serializeToMarkdown } from "../../deserializer/serializer";
import type {
  BlockInsert,
  BlockSet,
  FormatSet,
  Operation,
} from "../sync/types";
import { deleteSelectedText, getSelectionRange } from "../actions/commands";
import { IMAGE_DEFAULT_HEIGHT } from "../constants";
import {
  deleteCharsInRange,
  getVisibleText,
  insertCharsAtPosition,
} from "../sync/crdt-helpers";
import { invalidateBlockCache } from "../renderer";
import {
  clearSelection,
  generateBlockId,
  getBlockTextContent,
  getBlockTextLength,
  moveCursorToPosition,
} from "../state";
import type {
  CommandResult,
  CRDTContext,
  EditorState,
  Position,
} from "../types";
import {} from "../undo";

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
    const textLength = getBlockTextLength(block);

    // Image cover and line blocks are included as-is
    if (block.type === "image" || block.type === "line") {
      return {
        blocks: [block],
        isPartial: false,
        start,
        end,
      };
    }

    if (!isTextualBlock(block)) {
      return {
        blocks: [block],
        isPartial: false,
        start,
        end,
      };
    }

    // Extract the selected portion of chars and formats
    const selectedChars = extractCharsInRange(
      block.chars,
      start.textIndex,
      end.textIndex
    );
    const selectedFormats = extractFormatsForChars(
      block.formats,
      selectedChars,
      block.chars
    );

    const partialBlock: Block = {
      ...block,
      chars: selectedChars,
      formats: selectedFormats,
    };

    return {
      blocks: [partialBlock],
      isPartial: start.textIndex > 0 || end.textIndex < textLength,
      start,
      end,
    };
  }

  // Multi-block selection
  const blocks: Block[] = [];

  for (let i = start.blockIndex; i <= end.blockIndex; i++) {
    const block = state.document.page.blocks[i];
    const textLength = getBlockTextLength(block);

    // Image cover and line blocks are included as-is
    if (block.type === "image" || block.type === "line") {
      blocks.push(block);
      continue;
    }

    if (!isTextualBlock(block)) {
      blocks.push(block);
      continue;
    }

    let chars = block.chars;
    let formats = block.formats;

    if (i === start.blockIndex) {
      // First block - cut from start position
      chars = extractCharsInRange(block.chars, start.textIndex, textLength);
      formats = extractFormatsForChars(block.formats, chars, block.chars);
    } else if (i === end.blockIndex) {
      // Last block - cut to end position
      chars = extractCharsInRange(block.chars, 0, end.textIndex);
      formats = extractFormatsForChars(block.formats, chars, block.chars);
    }
    // Middle blocks - include full content

    const newBlock: Block = {
      ...block,
      chars,
      formats,
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
 * Extract chars in a visible range (accounting for deleted chars)
 */
function extractCharsInRange(
  chars: Char[],
  startIndex: number,
  endIndex: number
): Char[] {
  const result: Char[] = [];
  let visibleCount = 0;

  for (const char of chars) {
    if (!char.deleted) {
      if (visibleCount >= startIndex && visibleCount < endIndex) {
        result.push(char);
      }
      visibleCount++;
      if (visibleCount >= endIndex) break;
    }
  }

  return result;
}

/**
 * Extract format spans that apply to the given chars
 */
function extractFormatsForChars(
  formats: FormatSpan[],
  extractedChars: Char[],
  originalChars: Char[]
): FormatSpan[] {
  if (extractedChars.length === 0) return [];

  const charIdSet = new Set(extractedChars.map((c) => c.id));
  const result: FormatSpan[] = [];

  for (const span of formats) {
    // Check if this span overlaps with extracted chars
    const startIdx = originalChars.findIndex((c) => c.id === span.startCharId);
    const endIdx = originalChars.findIndex((c) => c.id === span.endCharId);

    if (startIdx === -1 || endIdx === -1) continue;

    // Find intersection with extracted chars
    let newStartCharId: string | null = null;
    let newEndCharId: string | null = null;

    for (let i = startIdx; i <= endIdx; i++) {
      const char = originalChars[i];
      if (charIdSet.has(char.id)) {
        if (!newStartCharId) newStartCharId = char.id;
        newEndCharId = char.id;
      }
    }

    if (newStartCharId && newEndCharId) {
      result.push({
        ...span,
        startCharId: newStartCharId,
        endCharId: newEndCharId,
      });
    }
  }

  return result;
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
      const width = block.width ?? "full";
      const height = block.height ?? IMAGE_DEFAULT_HEIGHT;
      const objectFit = block.objectFit ?? "cover";

      // Always output with full properties for HTML clipboard
      const widthAttr =
        width === "full" ? 'data-width="full"' : `width="${width}"`;
      const heightAttr = `height="${height}"`;
      const objectFitAttr = `data-object-fit="${objectFit}"`;
      const altAttr = alt ? ` alt="${alt}"` : "";

      return `<img src="${block.url}"${altAttr} ${widthAttr} ${heightAttr} ${objectFitAttr} />`;
    }

    // Handle line/divider blocks
    if (block.type === "line") {
      return "<hr />";
    }

    if (!isTextualBlock(block)) {
      return "";
    }

    // Build content with inline formatting as HTML
    let htmlContent = "";
    const visibleChars = block.chars.filter((c) => !c.deleted);

    // Build a map of char ID to formats
    const charFormats = new Map<string, TextFormat[]>();
    for (const span of block.formats) {
      const startIdx = visibleChars.findIndex((c) => c.id === span.startCharId);
      const endIdx = visibleChars.findIndex((c) => c.id === span.endCharId);

      if (startIdx !== -1 && endIdx !== -1) {
        for (let i = startIdx; i <= endIdx; i++) {
          const charId = visibleChars[i].id;
          if (!charFormats.has(charId)) {
            charFormats.set(charId, []);
          }
          charFormats.get(charId)!.push(span.format);
        }
      }
    }

    // Generate HTML for each character
    for (const char of visibleChars) {
      // Escape HTML special characters
      let text = char.char
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");

      // Apply formats as HTML tags
      const formats = charFormats.get(char.id) || [];
      for (const format of formats) {
        if (format.type === "bold") {
          text = `<strong>${text}</strong>`;
        } else if (format.type === "italic") {
          text = `<em>${text}</em>`;
        } else if (format.type === "strikethrough") {
          text = `<s>${text}</s>`;
        } else if (format.type === "code") {
          text = `<code>${text}</code>`;
        } else if (format.type === "link" && format.url) {
          text = `<a href="${format.url}">${text}</a>`;
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
        const indentStyle =
          indent > 0 ? ` style="margin-left: ${indent * 24}px"` : "";
        return `<li${indentStyle}>${htmlContent}</li>`;
      }
      case "numbered_list": {
        const indent = isListBlock(block) ? block.indent : 0;
        const indentStyle =
          indent > 0 ? ` style="margin-left: ${indent * 24}px"` : "";
        return `<li${indentStyle} data-list-type="numbered">${htmlContent}</li>`;
      }
      case "todo_list": {
        const indent = isListBlock(block) ? block.indent : 0;
        const checked =
          isListBlock(block) && block.type === "todo_list"
            ? block.checked
            : false;
        const indentStyle =
          indent > 0 ? ` style="margin-left: ${indent * 24}px"` : "";
        const checkbox = checked ? "[x]" : "[ ]";
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
  state: EditorState,
  crdt: CRDTContext
): Promise<{ success: boolean; result: CommandResult | null }> {
  try {
    const selectedContent = getSelectedContent(state);
    if (!selectedContent) return { success: false, result: null };

    const { blocks } = selectedContent;
    if (blocks.length === 0) return { success: false, result: null };

    const markdown = blocksToMarkdown(blocks);

    let success = false;
    if (hasNativeBridge()) {
      success = await cutToNativeClipboard(markdown);
    } else {
      success = await copySelectionToClipboard(state);
    }

    if (success) {
      const stateWithUndo = state;

      const result = deleteSelectedText(stateWithUndo, crdt);
      return { success: true, result };
    }

    return { success: false, result: null };
  } catch (error) {
    console.error("Failed to cut to clipboard:", error);
    return { success: false, result: null };
  }
}

/**
 * Clean up Google Docs HTML by removing metadata and normalizing structure
 */
function cleanGoogleDocsHTML(html: string): string {
  // Remove Google Docs meta tags
  html = html.replace(/<meta[^>]*>/g, "");

  // Remove Google Docs internal wrapper with ID
  html = html.replace(/<b[^>]*id="docs-internal-guid-[^"]*"[^>]*>/g, "");
  html = html.replace(/<\/b>/g, "");

  // Convert multiple <br> or <br /> tags into paragraph separators
  html = html.replace(/(<br\s*\/?>\s*){2,}/gi, "</p><p>");

  // Wrap unwrapped text in paragraphs if needed
  html = html.trim();

  return html;
}

/**
 * Check if an element has Google Docs styling that indicates bold/italic
 */
function hasGoogleDocsFormat(
  element: Element,
  format: "bold" | "italic"
): boolean {
  const style = element.getAttribute("style") || "";

  if (format === "bold") {
    // Check for font-weight in inline styles
    const fontWeightMatch = style.match(/font-weight:\s*(\d+|bold)/i);
    if (fontWeightMatch) {
      const weight = fontWeightMatch[1];
      return weight === "bold" || parseInt(weight) >= 600;
    }
  } else if (format === "italic") {
    // Check for font-style in inline styles
    return /font-style:\s*italic/i.test(style);
  }

  return false;
}

/**
 * Simple ID generator for clipboard parsing (temporary IDs that will be replaced)
 */
let clipboardIdCounter = 0;
function makeClipboardIdGen(): () => string {
  return () => `clipboard:${clipboardIdCounter++}`;
}

/**
 * Convert text segments with formatting to chars and format spans
 */
function segmentsToCharsAndFormats(
  segments: Array<{ content: string; formats?: TextFormat[] }>
): { chars: Char[]; formats: FormatSpan[] } {
  const chars: Char[] = [];
  const formats: FormatSpan[] = [];
  const idGen = makeClipboardIdGen();
  const clock = { wall: Date.now(), logical: 0, peerId: "clipboard" };

  for (const segment of segments) {
    const startIdx = chars.length;

    // Create chars for this segment
    for (const char of segment.content) {
      chars.push({
        id: idGen(),
        char,
        deleted: false,
      });
    }

    const endIdx = chars.length - 1;

    // Create format spans for this segment
    if (segment.formats && segment.formats.length > 0 && startIdx <= endIdx) {
      for (const format of segment.formats) {
        formats.push({
          startCharId: chars[startIdx].id,
          endCharId: chars[endIdx].id,
          format,
          clock,
        });
      }
    }
  }

  return { chars, formats };
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
  function extractTextWithFormatting(
    node: Node,
    currentFormats: any[] = []
  ): any[] {
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
      if (
        tagName === "meta" ||
        tagName === "script" ||
        tagName === "style" ||
        tagName === "svg"
      ) {
        return segments;
      }

      // Add format based on tag
      if (tagName === "strong" || tagName === "b") {
        // For <b> tags, check if it's actually bold (Google Docs uses <b> with font-weight:normal)
        if (tagName === "b" && hasGoogleDocsFormat(element, "bold")) {
          newFormats.push({ type: "bold" });
        } else if (tagName === "strong") {
          newFormats.push({ type: "bold" });
        } else if (tagName === "b" && !element.hasAttribute("style")) {
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
        if (hasGoogleDocsFormat(element, "bold")) {
          newFormats.push({ type: "bold" });
        }
        if (hasGoogleDocsFormat(element, "italic")) {
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
        segments.push(
          ...extractTextWithFormatting(node.childNodes[i], newFormats)
        );
      }
    }

    return segments;
  }

  // Helper function to check if an element is a block-level content element
  function isBlockElement(tagName: string): boolean {
    return [
      "p",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "blockquote",
      "pre",
      "li",
      "img",
    ].includes(tagName);
  }

  // Helper function to check if an element is a container element
  function isContainerElement(tagName: string): boolean {
    return [
      "div",
      "main",
      "article",
      "section",
      "header",
      "footer",
      "nav",
      "aside",
      "ul",
      "ol",
    ].includes(tagName);
  }

  // Recursively find all block-level elements, even if deeply nested
  // Also handles orphaned text nodes by wrapping them in synthetic paragraphs
  function findBlockElements(
    element: Element
  ): Array<Element | { syntheticParagraph: true; content: any[] }> {
    const blockElements: Array<
      Element | { syntheticParagraph: true; content: any[] }
    > = [];
    const tagName = element.tagName.toLowerCase();

    // If this is a block element itself, add it
    if (isBlockElement(tagName)) {
      blockElements.push(element);
      return blockElements;
    }

    // If this is a container, recursively search its children
    if (isContainerElement(tagName) || tagName === "body") {
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
        if (content.length > 0 && content.some((seg) => seg.content.trim())) {
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
      const { chars, formats } = segmentsToCharsAndFormats(content);
      blocks.push({
        id: generateBlockId(),
        type: "paragraph",
        chars,
        formats,
      });
    }
    return blocks;
  }

  // Process each block element (including synthetic paragraphs)
  for (const element of blockElements) {
    // Handle synthetic paragraphs (orphaned text from containers)
    if ("syntheticParagraph" in element) {
      const content = element.content;
      const hasContent = content.some(
        (seg: any) => seg.content.trim().length > 0
      );
      if (hasContent) {
        const { chars, formats } = segmentsToCharsAndFormats(content);
        blocks.push({
          id: generateBlockId(),
          type: "paragraph",
          chars,
          formats,
        });
      }
      continue;
    }

    // Handle regular HTML elements
    const tagName = element.tagName.toLowerCase();

    // Handle img tags
    if (tagName === "img") {
      const src = element.getAttribute("src");
      if (src) {
        const alt = element.getAttribute("alt") || "";
        const widthAttr =
          element.getAttribute("width") || element.getAttribute("data-width");
        const heightAttr = element.getAttribute("height");
        const objectFitAttr = element.getAttribute("data-object-fit");

        const width =
          widthAttr === "full"
            ? "full"
            : widthAttr
            ? parseInt(widthAttr, 10)
            : undefined;
        const height = heightAttr ? parseInt(heightAttr, 10) : undefined;
        const objectFit = objectFitAttr as ("cover" | "contain") | undefined;

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
    const hasContent = content.some((seg) => seg.content.trim().length > 0);
    if (!hasContent) continue;

    // Check if this is a list item
    if (tagName === "li") {
      const listType = element.getAttribute("data-list-type");
      const indentStyle = element.getAttribute("style");
      const indentMatch = indentStyle?.match(/margin-left:\s*(\d+)px/);
      const indent = indentMatch
        ? Math.floor(parseInt(indentMatch[1], 10) / 24)
        : 0;

      const { chars, formats } = segmentsToCharsAndFormats(
        content.length > 0 ? content : [{ content: "" }]
      );

      if (listType === "todo") {
        const checked = element.getAttribute("data-checked") === "true";
        blocks.push({
          id: generateBlockId(),
          type: "todo_list",
          chars,
          formats,
          checked,
          indent,
        });
      } else if (listType === "numbered") {
        blocks.push({
          id: generateBlockId(),
          type: "numbered_list",
          chars,
          formats,
          indent,
        });
      } else {
        // Default to bullet list for generic <li> tags
        blocks.push({
          id: generateBlockId(),
          type: "bullet_list",
          chars,
          formats,
          indent,
        });
      }
      continue;
    }

    let blockType: "heading1" | "heading2" | "heading3" | "paragraph" =
      "paragraph";

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

    const { chars, formats } = segmentsToCharsAndFormats(
      content.length > 0 ? content : [{ content: "" }]
    );

    const block: Block = {
      id: generateBlockId(),
      type: blockType,
      chars,
      formats,
    };

    blocks.push(block);
  }

  // If no blocks were parsed, treat the entire content as paragraphs
  if (blocks.length === 0 && doc.body.textContent) {
    const lines = doc.body.textContent.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) {
        const { chars, formats } = segmentsToCharsAndFormats([
          { content: trimmed },
        ]);
        blocks.push({
          id: generateBlockId(),
          type: "paragraph",
          chars,
          formats,
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
    console.error(
      "Failed to parse markdown, falling back to plain text:",
      error
    );

    // Fallback: create simple blocks without formatting
    const blocks: Block[] = [];
    const lines = text.split("\n");

    for (const line of lines) {
      let block: Block;
      let blockType: "heading1" | "heading2" | "heading3" | "paragraph";
      let content: string;

      // Check for markdown-style headings
      if (line.startsWith("### ")) {
        blockType = "heading3";
        content = line.slice(4);
      } else if (line.startsWith("## ")) {
        blockType = "heading2";
        content = line.slice(3);
      } else if (line.startsWith("# ")) {
        blockType = "heading1";
        content = line.slice(2);
      } else {
        blockType = "paragraph";
        content = line;
      }

      const { chars, formats } = segmentsToCharsAndFormats([{ content }]);
      block = {
        id: generateBlockId(),
        type: blockType,
        chars,
        formats,
      };

      blocks.push(block);
    }

    return blocks;
  }
}

/**
 * Paste content from native clipboard (for mobile apps)
 */
export async function pasteFromNativeClipboardAPI(
  state: EditorState,
  crdt: CRDTContext
): Promise<CommandResult | null> {
  try {
    const text = await pasteFromNativeClipboard();
    if (!text) return null;

    const blocks = parsePlainTextToBlocks(text);
    if (blocks.length === 0) return null;

    return insertBlocksAtCursor(state, blocks, crdt);
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
  blocks: Block[],
  crdt: CRDTContext
): CommandResult {
  if (blocks.length === 0) return { state, ops: [] };

  const ops: Operation[] = [];

  // Record undo state before modification
  let newState = state;

  // If there's a selection, delete it first
  if (newState.document.selection && !newState.document.selection.isCollapsed) {
    const deleteResult = deleteSelectedText(newState, crdt);
    newState = deleteResult.state;
    ops.push(...deleteResult.ops);
  }

  // If no cursor is set, default to the end of the document
  let blockIndex: number;
  let textIndex: number;

  if (!newState.document.cursor) {
    // Insert at the end of the last block
    blockIndex = newState.document.page.blocks.length - 1;
    const lastBlock = newState.document.page.blocks[blockIndex];
    textIndex = getBlockTextLength(lastBlock);
  } else {
    blockIndex = newState.document.cursor.position.blockIndex;
    textIndex = newState.document.cursor.position.textIndex;
  }

  // Ensure cursor position is valid
  if (blockIndex < 0 || blockIndex >= newState.document.page.blocks.length) {
    blockIndex = newState.document.page.blocks.length - 1;
    const lastBlock = newState.document.page.blocks[blockIndex];
    textIndex = getBlockTextLength(lastBlock);
  }
  const currentBlock = newState.document.page.blocks[blockIndex];

  // If pasting a single block
  if (blocks.length === 1) {
    // Can't paste into non-text blocks
    if (!isTextualBlock(currentBlock)) {
      return { state, ops: [] };
    }

    // Can't paste non-text blocks into text blocks
    if (!isTextualBlock(blocks[0])) {
      return { state, ops: [] };
    }

    const pasteBlock = blocks[0];
    const pasteText = getVisibleText(pasteBlock.chars);

    // Insert the pasted text at cursor position
    const { newChars, op: insertOp } = insertCharsAtPosition(
      currentBlock.chars,
      textIndex,
      pasteText,
      currentBlock.id,
      crdt
    );
    ops.push(insertOp);

    // Apply formatting from pasted block
    let newFormats = currentBlock.formats;
    for (const pasteFormat of pasteBlock.formats) {
      // Find the new char IDs in the inserted range
      const pasteStartIdx = pasteBlock.chars.findIndex(
        (c) => c.id === pasteFormat.startCharId
      );
      const pasteEndIdx = pasteBlock.chars.findIndex(
        (c) => c.id === pasteFormat.endCharId
      );

      if (pasteStartIdx !== -1 && pasteEndIdx !== -1) {
        // Map to the newly inserted chars
        const insertedChars = insertOp.chars;
        const newStartCharId = insertedChars[pasteStartIdx]?.id;
        const newEndCharId = insertedChars[pasteEndIdx]?.id;

        if (newStartCharId && newEndCharId) {
          const newSpan: FormatSpan = {
            startCharId: newStartCharId,
            endCharId: newEndCharId,
            format: pasteFormat.format,
            clock: crdt.clock(),
          };
          newFormats = [...newFormats, newSpan];

          // Create format operation
          const charIds = insertedChars
            .slice(pasteStartIdx, pasteEndIdx + 1)
            .map((c) => c.id);
          const formatOp: FormatSet = {
            op: "format_set",
            id: crdt.idGen(),
            clock: crdt.clock(),
            pageId: crdt.pageId,
            blockId: currentBlock.id,
            charIds,
            format: pasteFormat.format,
            value:
              pasteFormat.format.type === "link"
                ? pasteFormat.format.url || true
                : true,
          };
          ops.push(formatOp);
        }
      }
    }

    const newBlock: Block = {
      ...currentBlock,
      chars: newChars,
      formats: newFormats,
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
      textIndex + pasteText.length
    );

    return { state: clearSelection(newState), ops };
  } else {
    // Pasting multiple blocks - split current block and insert pasted blocks
    if (!isTextualBlock(currentBlock)) {
      return { state, ops: [] };
    }

    // Filter out non-text blocks from paste (or handle them separately)
    const textBlocks = blocks.filter(isTextualBlock);
    if (textBlocks.length === 0) {
      return { state, ops: [] };
    }

    const currentTextLength = getBlockTextLength(currentBlock);

    // Extract chars before and after cursor
    const beforeChars = extractCharsInRange(currentBlock.chars, 0, textIndex);
    const afterChars = extractCharsInRange(
      currentBlock.chars,
      textIndex,
      currentTextLength
    );
    const beforeFormats = extractFormatsForChars(
      currentBlock.formats,
      beforeChars,
      currentBlock.chars
    );
    const afterFormats = extractFormatsForChars(
      currentBlock.formats,
      afterChars,
      currentBlock.chars
    );

    // Delete text after cursor in current block
    if (textIndex < currentTextLength) {
      const { op: deleteOp } = deleteCharsInRange(
        currentBlock.chars,
        textIndex,
        currentTextLength,
        currentBlock.id,
        crdt
      );
      ops.push(deleteOp);
    }

    // First block: keep current block, append first pasted block's content
    const firstPastedText = getVisibleText(textBlocks[0].chars);
    const { newChars: firstBlockChars, op: firstInsertOp } =
      insertCharsAtPosition(
        beforeChars,
        beforeChars.filter((c) => !c.deleted).length,
        firstPastedText,
        currentBlock.id,
        crdt
      );
    ops.push(firstInsertOp);

    // Apply formats from first pasted block to inserted chars
    let firstBlockFormats = beforeFormats;
    for (const pasteFormat of textBlocks[0].formats) {
      const pasteStartIdx = textBlocks[0].chars.findIndex(
        (c) => c.id === pasteFormat.startCharId
      );
      const pasteEndIdx = textBlocks[0].chars.findIndex(
        (c) => c.id === pasteFormat.endCharId
      );

      if (pasteStartIdx !== -1 && pasteEndIdx !== -1) {
        const insertedChars = firstInsertOp.chars;
        const newStartCharId = insertedChars[pasteStartIdx]?.id;
        const newEndCharId = insertedChars[pasteEndIdx]?.id;

        if (newStartCharId && newEndCharId) {
          const newSpan: FormatSpan = {
            startCharId: newStartCharId,
            endCharId: newEndCharId,
            format: pasteFormat.format,
            clock: crdt.clock(),
          };
          firstBlockFormats = [...firstBlockFormats, newSpan];

          const charIds = insertedChars
            .slice(pasteStartIdx, pasteEndIdx + 1)
            .map((c) => c.id);
          const formatOp: FormatSet = {
            op: "format_set",
            id: crdt.idGen(),
            clock: crdt.clock(),
            pageId: crdt.pageId,
            blockId: currentBlock.id,
            charIds,
            format: pasteFormat.format,
            value:
              pasteFormat.format.type === "link"
                ? pasteFormat.format.url || true
                : true,
          };
          ops.push(formatOp);
        }
      }
    }

    const firstBlock: Block = {
      ...currentBlock,
      chars: firstBlockChars,
      formats: firstBlockFormats,
    };
    invalidateBlockCache(firstBlock);

    // Middle blocks: insert as new blocks
    const middleBlocks = textBlocks.slice(1, -1).map((block) => {
      const newBlock = { ...block, id: generateBlockId() };
      invalidateBlockCache(newBlock);

      const blockInsertOp: BlockInsert = {
        op: "block_insert",
        id: crdt.idGen(),
        clock: crdt.clock(),
        pageId: crdt.pageId,
        afterBlockId:
          blockIndex === 0
            ? null
            : newState.document.page.blocks[blockIndex - 1]?.id || null,
        blockId: newBlock.id,
        blockType: newBlock.type as any,
      };
      ops.push(blockInsertOp);

      // Add list properties if needed
      if (isListBlock(newBlock)) {
        if (newBlock.indent > 0) {
          const indentOp: BlockSet = {
            op: "block_set",
            id: crdt.idGen(),
            clock: crdt.clock(),
            pageId: crdt.pageId,
            blockId: newBlock.id,
            field: "indent",
            value: newBlock.indent,
          };
          ops.push(indentOp);
        }
        if (newBlock.type === "todo_list") {
          const checkedOp: BlockSet = {
            op: "block_set",
            id: crdt.idGen(),
            clock: crdt.clock(),
            pageId: crdt.pageId,
            blockId: newBlock.id,
            field: "checked",
            value: newBlock.checked,
          };
          ops.push(checkedOp);
        }
      }

      return newBlock;
    });

    // Last block: pasted content + after content from current block
    const lastPastedBlock = textBlocks[textBlocks.length - 1];
    const lastBlockId = generateBlockId();
    const lastBlock: Block = {
      ...lastPastedBlock,
      id: lastBlockId,
      chars: [...lastPastedBlock.chars, ...afterChars],
      formats: [...lastPastedBlock.formats, ...afterFormats],
    };
    invalidateBlockCache(lastBlock);

    const lastBlockInsertOp: BlockInsert = {
      op: "block_insert",
      id: crdt.idGen(),
      clock: crdt.clock(),
      pageId: crdt.pageId,
      afterBlockId: currentBlock.id,
      blockId: lastBlockId,
      blockType: lastBlock.type as any,
    };
    ops.push(lastBlockInsertOp);

    // Add list properties for last block if needed
    if (isListBlock(lastBlock)) {
      if (lastBlock.indent > 0) {
        const indentOp: BlockSet = {
          op: "block_set",
          id: crdt.idGen(),
          clock: crdt.clock(),
          pageId: crdt.pageId,
          blockId: lastBlockId,
          field: "indent",
          value: lastBlock.indent,
        };
        ops.push(indentOp);
      }
      if (lastBlock.type === "todo_list") {
        const checkedOp: BlockSet = {
          op: "block_set",
          id: crdt.idGen(),
          clock: crdt.clock(),
          pageId: crdt.pageId,
          blockId: lastBlockId,
          field: "checked",
          value: lastBlock.checked,
        };
        ops.push(checkedOp);
      }
    }

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
    const lastPastedText = getVisibleText(lastPastedBlock.chars);
    newState = moveCursorToPosition(
      newState,
      lastBlockIndex,
      lastPastedText.length
    );

    return { state: clearSelection(newState), ops };
  }
}

/**
 * Paste content from ClipboardEvent with HTML formatting (Ctrl+V)
 * This uses the paste event's clipboardData, which doesn't require permission
 */
export function pasteFromClipboardEvent(
  state: EditorState,
  event: ClipboardEvent,
  crdt: CRDTContext,
  extractedData?: { html: string; text: string } | null
): CommandResult | null {
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
      return insertBlocksAtCursor(state, blocks, crdt);
    }
  }

  // Fallback to plain text
  if (text) {
    const blocks = parsePlainTextToBlocks(text);
    if (blocks.length > 0) {
      return insertBlocksAtCursor(state, blocks, crdt);
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
  event: ClipboardEvent,
  crdt: CRDTContext
): Promise<CommandResult | null> {
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

      resolve(insertBlocksAtCursor(state, blocks, crdt));
    } catch (error) {
      console.error("Failed to paste plain text from clipboard event:", error);
      resolve(null);
    }
  });
}
