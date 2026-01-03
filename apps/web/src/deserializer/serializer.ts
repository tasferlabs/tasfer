import type { Block } from "./loadPage";

export function serializeToMarkdown(blocks: Block[]): string {
  if (blocks.length === 0) {
    return "";
  }
  
  const serializedBlocks = blocks.map((block) => {
    // Handle image blocks separately
    if (block.type === "image") {
      const alt = block.alt || "";
      return `![${alt}](${block.url})`;
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
  
  // Only check for empty content if it's a text block
  if (lastBlock.type !== "image") {
    const lastBlockIsEmpty = lastBlock.content.length === 0 || 
      (lastBlock.content.length === 1 && lastBlock.content[0].content === "");
    
    if (lastBlockIsEmpty && blocks.length > 1) {
      return result + "\n";
    }
  }
  
  return result;
}
