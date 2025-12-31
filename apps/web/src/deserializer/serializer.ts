import type { Block } from "./loadPage";

export function serializeToMarkdown(blocks: Block[]): string {
  return blocks
    .map((block) => {
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
    })
    .join("\n\n");
}
