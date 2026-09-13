/**
 * Prose inside structured content — the read behind `editor.query.textFields`.
 *
 * A block's own text is one flat field every prose tool already reads. Text a
 * node keeps inside a structured attachment (a table's cells) is invisible to
 * those tools unless the attachment's kind says which of its character fields
 * are prose. The kind answers through its `textFields` adapter; this module
 * turns that answer into plain data, so the core stays node-agnostic and a
 * tool such as a spell checker never imports a feature package.
 */

import { resolveMarkRunsFromChars } from "./mark-runs";
import type { Block } from "./serlization/loadPage";
import { iterateAllChars } from "./sync/char-runs";
import type { DataSchema } from "./sync/schema";
import {
  getStructuredMarks,
  getStructuredText,
} from "./sync/structured-content";

/** One mark run inside a text field, in the field's visible offsets. */
export interface TextFieldMark {
  readonly name: string;
  readonly attrs: Record<string, unknown>;
  readonly from: number;
  readonly to: number;
}

/**
 * One prose field inside a block's structured content, addressed the way a
 * `ContentTextPoint` addresses it. Offsets are visible UTF-16 offsets into
 * `text`.
 */
export interface TextFieldInfo {
  readonly blockId: string;
  readonly contentId: string;
  readonly nodeId: string;
  readonly field: string;
  readonly text: string;
  readonly marks: readonly TextFieldMark[];
}

/**
 * Every prose field in `block`'s structured attachments, attachment by
 * attachment, each in the reading order its kind reports. Empty for a block
 * without structured prose — its flat text is read through `query.block`.
 */
export function blockTextFields(
  block: Block,
  schema: DataSchema,
): TextFieldInfo[] {
  if (block.deleted || !block.structuredContent) return [];
  const result: TextFieldInfo[] = [];
  for (const [contentId, document] of Object.entries(block.structuredContent)) {
    for (const { nodeId, field } of schema.structuredTextFields(document)) {
      const node = document.nodes[nodeId];
      const runs = node?.textFields[field];
      if (!node || node.deleted || !runs) continue;
      const marks = resolveMarkRunsFromChars(
        iterateAllChars([...runs]),
        getStructuredMarks(document, nodeId, field),
      ).map((run) => ({
        name: run.name,
        attrs: run.attrs,
        from: run.startIndex,
        to: run.endIndex,
      }));
      result.push({
        blockId: block.id,
        contentId,
        nodeId,
        field,
        text: getStructuredText(document, nodeId, field),
        marks,
      });
    }
  }
  return result;
}
