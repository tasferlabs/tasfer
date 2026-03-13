import { IMAGE_DEFAULT_HEIGHT } from "@/editor/constants";
import type { Block, CharRun, FormatSpan, TextFormat } from "./loadPage";
import { isImageDefault, isListBlock, isTextualBlock } from "./loadPage";
import {
  getVisibleTextFromRuns,
  iterateVisibleChars,
} from "../editor/sync/char-runs";

// Helper to group chars with same formatting for serialization
function groupCharsForSerialization(charRuns: CharRun[], formats: FormatSpan[]): { text: string; formats?: TextFormat[] }[] {
  // Convert charRuns to visible chars array for format mapping
  const visibleChars: Array<{ id: string; char: string }> = [];
  for (const { id, char } of iterateVisibleChars(charRuns)) {
    visibleChars.push({ id, char });
  }
  
  if (visibleChars.length === 0) return [{ text: "" }];
  
  // Build format map: charId -> Set<TextFormat>
  const formatMap = new Map<string, Set<string>>();
  
  for (const span of formats) {
    const startIdx = visibleChars.findIndex(c => c.id === span.startCharId);
    const endIdx = visibleChars.findIndex(c => c.id === span.endCharId);
    
    if (startIdx === -1 || endIdx === -1) continue;
    
    for (let i = startIdx; i <= endIdx; i++) {
      const charId = visibleChars[i].id;
      if (!formatMap.has(charId)) {
        formatMap.set(charId, new Set());
      }
      const key = span.format.type + (span.format.url ? `:${span.format.url}` : '');
      formatMap.get(charId)!.add(key);
    }
  }
  
  // Group consecutive chars with same formatting
  const segments: { text: string; formats?: TextFormat[] }[] = [];
  let currentChars: string[] = [];
  let currentFormatKeys = new Set<string>();
  
  for (const char of visibleChars) {
    const charFormats = formatMap.get(char.id) || new Set();
    
    if (setsEqual(currentFormatKeys, charFormats)) {
      currentChars.push(char.char);
    } else {
      if (currentChars.length > 0) {
        segments.push({
          text: currentChars.join(""),
          formats: formatKeysToFormats(currentFormatKeys),
        });
      }
      currentChars = [char.char];
      currentFormatKeys = new Set(charFormats);
    }
  }
  
  if (currentChars.length > 0) {
    segments.push({
      text: currentChars.join(""),
      formats: formatKeysToFormats(currentFormatKeys),
    });
  }
  
  return segments.length > 0 ? segments : [{ text: "" }];
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const item of a) {
    if (!b.has(item)) return false;
  }
  return true;
}

function formatKeysToFormats(keys: Set<string>): TextFormat[] | undefined {
  if (keys.size === 0) return undefined;
  const formats: TextFormat[] = [];
  for (const key of keys) {
    if (key.startsWith('link:')) {
      formats.push({ type: 'link', url: key.slice(5) });
    } else {
      formats.push({ type: key as any });
    }
  }
  return formats.length > 0 ? formats : undefined;
}

export interface PageMetadata {
  color?: string | null;
  scheduledAt?: string | null;
  duration?: number | null;
  allDay?: boolean | null;
  task?: boolean;
}

function serializeFrontmatter(metadata: PageMetadata): string {
  const lines: string[] = [];
  if (metadata.task) lines.push(`task: true`);
  if (metadata.scheduledAt) lines.push(`scheduledAt: ${metadata.scheduledAt}`);
  if (metadata.duration != null) lines.push(`duration: ${metadata.duration}`);
  if (metadata.allDay != null) lines.push(`allDay: ${metadata.allDay}`);
  if (metadata.color) lines.push(`color: ${metadata.color}`);
  if (lines.length === 0) return "";
  return `---\n${lines.join("\n")}\n---\n`;
}

export function serializeToMarkdown(blocks: Block[], metadata?: PageMetadata): string {
  // Filter out deleted blocks (CRDT tombstones)
  blocks = blocks.filter(block => !block.deleted);

  if (blocks.length === 0) {
    return "";
  }

  // Track numbering for numbered lists at each indent level
  const numbering: Map<number, number> = new Map();

  const frontmatter = metadata ? serializeFrontmatter(metadata) : "";

  const serializedBlocks = blocks.map((block, index) => {
    // Handle line/divider blocks
    if (block.type === "line") {
      return "---";
    }

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
      
      // Convert charRuns to segments for serialization
      const segments = groupCharsForSerialization(block.charRuns, block.formats);
      
      // Build content with inline formatting
      let content = "";
      for (const segment of segments) {
        let text = segment.text;
        
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
    
    if (isTextualBlock(block)) {
      // Convert charRuns to segments for serialization
      const segments = groupCharsForSerialization(block.charRuns, block.formats);
      
      // Build content with inline formatting
      for (const segment of segments) {
        let text = segment.text;
        
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
  if (lastBlock.type !== "image" && lastBlock.type !== "line") {
    const hasContent = isListBlock(lastBlock) || lastBlock.type === "heading1" || lastBlock.type === "heading2" || lastBlock.type === "heading3" || lastBlock.type === "paragraph";
    if (hasContent && isTextualBlock(lastBlock)) {
      const lastBlockIsEmpty = getVisibleTextFromRuns(lastBlock.charRuns).length === 0;

      if (lastBlockIsEmpty && blocks.length > 1) {
        return frontmatter + result + "\n";
      }
    }
  }

  return frontmatter + result;
}
