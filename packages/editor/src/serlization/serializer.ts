/**
 * Markdown serializer — orchestrator only.
 *
 * Per-block-type markup lives in the block codecs (./codecs). This file owns
 * what is genuinely cross-block: frontmatter, numbered-list numbering (an
 * item's number depends on its neighbors), and the trailing-newline rule.
 */

import { getBaseDataSchema } from "../baseDataSchema";
import { getVisibleTextFromRuns } from "../sync/char-runs";
import type { DataSchema } from "../sync/schema";
import type { OutputCtx } from "./codecs";
import { inlineToMarkdown } from "./codecs/inline";
import type { Block } from "./loadPage";

/**
 * Optional page details written as front matter (the `---` section at the top
 * of a Markdown file): color, scheduled time, duration, all-day flag and
 * whether the page is a task. Pass it to {@link serializeToMarkdown}; read it
 * back with {@link parseFrontmatter}.
 */
export interface PageMetadata {
  color?: string | null;
  scheduledAt?: string | null;
  duration?: number | null;
  allDay?: boolean | null;
  task?: boolean;
}

/**
 * Options for {@link serializeToMarkdown}: rewrite asset URLs as they are
 * written out, and name the schema when the document uses custom block types.
 */
export interface MarkdownSerializeOptions {
  /**
   * Changes each asset URL as it is written, for example to a path inside an
   * export folder. By default URLs are written unchanged.
   */
  mapAssetUrl?: (url: string) => string;
  /**
   * Block/mark types in play. Defaults to the built-in set; pass a custom
   * schema to serialize custom block types via their codecs.
   */
  schema?: DataSchema;
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

/**
 * Turns blocks into a Markdown string. Pass `metadata` to add front matter at
 * the top. Deleted blocks are left out. Blocks whose type the schema does not
 * know are left out too, so pass the schema your document uses. When no blocks
 * are left, it returns an empty string, with no front matter.
 *
 * ```ts
 * const markdown = serializeToMarkdown(page.blocks, page.metadata, {
 *   schema: appSchema.data,
 * });
 * ```
 */
export function serializeToMarkdown(
  blocks: Block[],
  metadata?: PageMetadata,
  options?: MarkdownSerializeOptions,
): string {
  const schema = options?.schema ?? getBaseDataSchema();

  // Filter out deleted blocks (CRDT tombstones)
  blocks = blocks.filter((block) => !block.deleted);

  if (blocks.length === 0) {
    return "";
  }

  const ctx: OutputCtx = {
    format: "markdown",
    inline: (charRuns, formats) => inlineToMarkdown(charRuns, formats, schema),
    mapAssetUrl: options?.mapAssetUrl ?? ((url) => url),
  };

  // Track numbering for numbered lists at each indent level
  const numbering: Map<number, number> = new Map();

  const frontmatter = metadata ? serializeFrontmatter(metadata) : "";

  const serializedBlocks = blocks.map((block, index) => {
    // Numbered-list numbering depends on neighboring blocks, so it is
    // computed here and handed to the codec via ctx.
    let listNumber: number | undefined;
    if (schema.listKind(block.type) === "numbered" && "indent" in block) {
      const currentIndent = block.indent;

      // Reset numbering if indent changed or if previous block wasn't a numbered list at same indent
      if (index > 0) {
        const prevBlock = blocks[index - 1];
        if (
          schema.listKind(prevBlock.type) !== "numbered" ||
          !("indent" in prevBlock) ||
          prevBlock.indent !== currentIndent
        ) {
          numbering.set(currentIndent, 1);
        }
      }

      listNumber = numbering.get(currentIndent) || 1;
      numbering.set(currentIndent, listNumber + 1);
    }

    const codec = schema.getCodec(block.type);
    if (!codec) return "";
    return codec.markdown.output(block, {
      ...ctx,
      inline: (charRuns, formats) =>
        inlineToMarkdown(charRuns, formats, schema, block.structuredContent),
      listNumber,
    });
  });

  const result = serializedBlocks.join("\n");

  // If the last block is empty, we need to add a trailing newline
  // to preserve the empty block when deserializing
  const lastBlock = blocks[blocks.length - 1];

  // A trailing empty textual block (paragraph/heading/list item) would be
  // dropped on reparse; emit a trailing newline so it round-trips. Visual
  // blocks (image/line/math) carry no text, so the rule doesn't apply.
  if (schema.isTextual(lastBlock.type) && "charRuns" in lastBlock) {
    const lastBlockIsEmpty =
      getVisibleTextFromRuns(lastBlock.charRuns).length === 0;

    if (lastBlockIsEmpty && blocks.length > 1) {
      return frontmatter + result + "\n";
    }
  }

  return frontmatter + result;
}
