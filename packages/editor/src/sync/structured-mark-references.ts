/**
 * Structured-mark references held INSIDE structured documents.
 *
 * A structured mark (an inline formula) usually covers a block's own text and
 * points, through its attrs, at an attachment on the same block. A feature that
 * keeps rich text inside its own attachment — a table's cells — can carry the
 * same mark in a node's `markFields`, pointing at a sibling attachment on the
 * block. Block-level lifecycle code (clone on paste, duplicate, snapshot
 * restore) has to see those references too, or a copy keeps pointing at the
 * source block's attachment ids, which the copy does not have.
 *
 * Node- and mark-agnostic: the references and the rewrite are the mark spec's
 * own (`MarkSpec.structured`), dispatched by mark type through the schema.
 */

import type { Mark, MarkRange } from "../serlization/loadPage";
import type { DataSchema } from "./schema";
import type {
  StructuredContentMap,
  StructuredDocument,
  StructuredNode,
} from "./structured-content";

/**
 * Every content id that structured marks anywhere in `attachments` reference
 * (deleted nodes included — an undo can bring their marks back).
 */
export function attachmentMarkReferences(
  attachments: StructuredContentMap | undefined,
  schema: DataSchema,
): Set<string> {
  const ids = new Set<string>();
  if (!attachments) return ids;
  for (const contentId of Object.keys(attachments)) {
    const document = attachments[contentId];
    for (const node of Object.values(document.nodes)) {
      for (const spans of Object.values(node.markFields ?? {})) {
        for (const span of spans) {
          for (const id of schema.structuredMarkReferences(span.format.type, {
            mark: span.format,
            attachments,
          })) {
            ids.add(id);
          }
        }
      }
    }
  }
  return ids;
}

/**
 * `document` with every structured mark in its mark fields re-addressed after
 * a block clone, through the mark facet's own `clone`.
 *
 * Call it once the WHOLE block's `clonedContentIds` map is known: a reference
 * may name an attachment that sorts after the document holding it. A mark the
 * facet declines to rewrite is kept as it is. Returns `document` itself when
 * nothing changed.
 */
export function cloneDocumentMarkReferences(
  document: StructuredDocument,
  schema: DataSchema,
  ctx: {
    readonly sourceBlockId: string;
    readonly targetBlockId: string;
    readonly attachments: StructuredContentMap | undefined;
    readonly clonedContentIds: Readonly<Record<string, string>>;
  },
): StructuredDocument {
  let nodes: Record<string, StructuredNode> | undefined;
  for (const nodeId of Object.keys(document.nodes)) {
    const node = document.nodes[nodeId];
    if (!node.markFields) continue;
    let markFields: Record<string, readonly MarkRange[]> | undefined;
    for (const field of Object.keys(node.markFields)) {
      const spans = node.markFields[field];
      let rewritten: MarkRange[] | undefined;
      spans.forEach((span, index) => {
        const mark: Mark | undefined = schema.cloneStructuredMark(
          span.format.type,
          { mark: span.format, ...ctx },
        );
        if (!mark) return;
        if (mark.type !== span.format.type) {
          throw new Error(
            `Structured mark clone for "${span.format.type}" returned type "${mark.type}"`,
          );
        }
        rewritten ??= [...spans];
        rewritten[index] = { ...span, format: mark };
      });
      if (rewritten) {
        markFields ??= { ...node.markFields };
        markFields[field] = rewritten;
      }
    }
    if (markFields) {
      nodes ??= { ...document.nodes };
      nodes[nodeId] = { ...node, markFields };
    }
  }
  return nodes ? { ...document, nodes } : document;
}
