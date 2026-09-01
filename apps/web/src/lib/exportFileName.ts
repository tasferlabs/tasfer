import type { Block } from "@tasfer/editor";
import { extractTitleFromBlocks } from "@tasfer/editor/internal";

/**
 * The file name stem an exported page gets: its title, stripped of the
 * characters no file system takes, capped at a sane length. Shared by the
 * export dialog and the ⌘S download so the two agree on the name.
 */
export function exportBaseName(blocks: Block[]): string {
  const title = extractTitleFromBlocks(blocks) || "document";
  const sanitized = title
    .replace(/[<>:"/\\|?*]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
  return sanitized || "document";
}
