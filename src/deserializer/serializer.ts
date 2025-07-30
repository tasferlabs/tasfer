import type { Block } from "./loadPage";

export function serializeToMarkdown(blocks: Block[]): string {
  return blocks
    .map((block) => {
      const content = block.content.map((t) => t.content).join("");
      let prefix = "";
      if (block.type === "heading1") prefix = "# ";
      else if (block.type === "heading2") prefix = "## ";
      else if (block.type === "heading3") prefix = "### ";
      return prefix + content;
    })
    .join("\n\n");
}
