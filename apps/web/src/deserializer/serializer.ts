import { IMAGE_DEFAULT_HEIGHT } from "@/editor/constants";
import type { Block } from "./loadPage";
import { isImageDefault, isListBlock } from "./loadPage";

export function serializeToMarkdown(blocks: Block[]): string {
  if (blocks.length === 0) {
    return "";
  }
  
  // Track numbering for numbered lists at each indent level
  const numbering: Map<number, number> = new Map();
  
  const serializedBlocks = blocks.map((block, index) => {
    // Handle image cover blocks separately
    if (block.type === "image") {
      const alt = block.alt || "";
      
      // If image is in default state, use markdown syntax
      if (isImageDefault(block)) {
        return `![${alt}](${block.url})`;
      }
      
      // Otherwise, use HTML tag with custom properties
      const width = block.width ?? 'full';
      const height = block.height ?? IMAGE_DEFAULT_HEIGHT;
      const objectFit = block.objectFit ?? 'cover';
      
      const widthAttr = width === 'full' ? 'data-width="full"' : `width="${width}"`;
      const heightAttr = `height="${height}"`;
      const objectFitAttr = `data-object-fit="${objectFit}"`;
      const altAttr = alt ? ` alt="${alt}"` : '';
      
      return `<img src="${block.url}"${altAttr} ${widthAttr} ${heightAttr} ${objectFitAttr} />`;
    }
    
    // Handle list blocks
    if (isListBlock(block)) {
      const indent = " ".repeat(block.indent * 2);
      
      // Build content with inline formatting
      let content = "";
      for (const segment of block.content) {
        let text = segment.content;
        
        // Apply formats
        if (segment.formats) {
          for (const format of segment.formats) {
            if (format.type === 'bold') {
              text = `**${text}**`;
            } else if (format.type === 'italic') {
              text = `*${text}*`;
            } else if (format.type === 'strikethrough') {
              text = `~~${text}~~`;
            } else if (format.type === 'code') {
              text = `\`${text}\``;
            } else if (format.type === 'link' && format.url) {
              text = `[${text}](${format.url})`;
            }
          }
        }
        
        content += text;
      }
      
      if (block.type === "bullet_list") {
        return `${indent}- ${content}`;
      } else if (block.type === "numbered_list") {
        // Calculate the number for this item based on previous items at same indent
        const currentIndent = block.indent;
        
        // Reset numbering if indent changed or if previous block wasn't a numbered list at same indent
        if (index > 0) {
          const prevBlock = blocks[index - 1];
          if (!isListBlock(prevBlock) || prevBlock.type !== "numbered_list" || prevBlock.indent !== currentIndent) {
            numbering.set(currentIndent, 1);
          }
        }
        
        const number = numbering.get(currentIndent) || 1;
        numbering.set(currentIndent, number + 1);
        
        return `${indent}${number}. ${content}`;
      } else if (block.type === "todo_list") {
        const checkbox = block.checked ? "[x]" : "[ ]";
        return `${indent}- ${checkbox} ${content}`;
      }
    }
    
    // Handle text blocks (headings and paragraphs)
    let content = "";
    
    // Build content with inline formatting
    for (const segment of block.content) {
      let text = segment.content;
      
      // Apply formats
      if (segment.formats) {
        for (const format of segment.formats) {
          if (format.type === 'bold') {
            text = `**${text}**`;
          } else if (format.type === 'italic') {
            text = `*${text}*`;
          } else if (format.type === 'strikethrough') {
            text = `~~${text}~~`;
          } else if (format.type === 'code') {
            text = `\`${text}\``;
          } else if (format.type === 'link' && format.url) {
            text = `[${text}](${format.url})`;
          }
        }
      }
      
      content += text;
    }
    
    let prefix = "";
    if (block.type === "heading1") prefix = "# ";
    else if (block.type === "heading2") prefix = "## ";
    else if (block.type === "heading3") prefix = "### ";
    return prefix + content;
  });
  
  const result = serializedBlocks.join("\n");
  
  // If the last block is empty, we need to add a trailing newline
  // to preserve the empty block when deserializing
  const lastBlock = blocks[blocks.length - 1];
  
  // Only check for empty content if it's a text block or list block
  if (lastBlock.type !== "image") {
    const hasContent = isListBlock(lastBlock) || lastBlock.type === "heading1" || lastBlock.type === "heading2" || lastBlock.type === "heading3" || lastBlock.type === "paragraph";
    if (hasContent) {
      const lastBlockIsEmpty = lastBlock.content.length === 0 || 
        (lastBlock.content.length === 1 && lastBlock.content[0].content === "");
      
      if (lastBlockIsEmpty && blocks.length > 1) {
        return result + "\n";
      }
    }
  }
  
  return result;
}
