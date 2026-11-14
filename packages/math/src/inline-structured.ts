/**
 * Structured attachments owned by inline math marks.
 *
 * A MathMark anchors on a single flat placeholder character
 * ({@link import("@tasfer/editor/feature-facets").STRUCTURED_MARK_ANCHOR_CHAR});
 * `format.attrs.contentId` points at the supplemental `MathDocument` that is
 * the mark's only source. Every creation path mints the attachment in the
 * same transaction that inserts the anchor char.
 *
 * This module is deliberately data-only. It builds initializers and mark
 * metadata but does not choose an input gesture or emit page operation
 * envelopes.
 */

import {
  MATH_STRUCTURED_KIND,
  type MathDocumentInitMutation,
  parseMathDocumentInit,
  structuredToMathDocument,
  validateStructuredMathDocument,
} from "./structured";
import type { StructuredMarkFacet } from "@tasfer/editor/feature-facets";
import type {
  Char,
  CharRun,
  Mark,
  MarkSpan,
} from "@tasfer/editor/serlization/loadPage";
import { iterateAllChars } from "@tasfer/editor/sync/char-runs";
import type { IdentityAllocator } from "@tasfer/editor/sync/id";
import { parseAllocatedIdentity } from "@tasfer/editor/sync/id";
import type {
  StructuredContentMap,
  StructuredDocument,
} from "@tasfer/editor/sync/structured-content";
import { needsCommandSeparator, printMathDocument } from "@tasfer/tex/data";

/**
 * The attributes stored on an inline math mark.
 *
 * An inline formula keeps no LaTeX in the block's text. The mark covers one
 * placeholder character (U+FFFC), and the formula lives in the math document
 * that `contentId` names. An editor without math shows that placeholder
 * character. Read the LaTeX with {@link getStructuredMathMarkSource}.
 *
 * @group Setup
 */
export type MathMarkAttrs = {
  /** Id of the math document that holds this formula. */
  readonly contentId?: string;
};

/**
 * The parts of a text block that {@link resolveStructuredInlineMathRuns} reads.
 *
 * @group Structured content
 */
export interface InlineMathHostBlock {
  readonly id: string;
  readonly charRuns: readonly CharRun[];
  readonly formats: readonly MarkSpan[];
  readonly structuredContent?: StructuredContentMap;
}

/**
 * One inline formula in a block, as returned by
 * {@link resolveStructuredInlineMathRuns}. Deleted text is not counted.
 *
 * @group Structured content
 */
export interface ResolvedInlineMathRun {
  readonly startIndex: number;
  readonly endIndex: number;
  readonly charIds: readonly string[];
  readonly span: MarkSpan;
  /** Persisted attachment reference. Absent only on a broken mark. */
  readonly contentId?: string;
  /** Valid referenced math attachment, when it resolves. */
  readonly document?: StructuredDocument;
  /**
   * The formula's LaTeX. Undefined when its math document is missing or not
   * valid.
   */
  readonly latex?: string;
}

/**
 * Everything needed to add a new inline formula: the id of its math document,
 * the mark to put on the text, and the edit that creates the document.
 * Returned by {@link createStructuredMathMarkAttachment}.
 */
export interface StructuredMathMarkAttachment {
  readonly contentId: string;
  readonly format: Mark & { readonly attrs: MathMarkAttrs };
  readonly init: MathDocumentInitMutation;
}

/**
 * Read a valid structured attachment reference from arbitrary mark attrs.
 *
 * @group Structured content
 */
export function mathMarkContentId(mark: Mark): string | undefined {
  const value = mark.attrs?.contentId;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Creates what a new inline formula needs from its LaTeX: the math document's
 * id, the mark that points to it, and the edit that creates the document (see
 * {@link StructuredMathMarkAttachment}). Every new id comes from `identities`.
 * When editing live, pass the editor's `state.CRDTbinding`. When reading
 * Markdown, pass the importer's id allocator. Throws when `identities` returns
 * an id that is not an allocated id.
 */
export function createStructuredMathMarkAttachment(
  latex: string,
  identities: IdentityAllocator,
): StructuredMathMarkAttachment {
  const contentId = identities.nextId();
  if (!parseAllocatedIdentity(contentId)) {
    throw new Error(
      "MathMark content identity must come from IdentityAllocator",
    );
  }
  return {
    contentId,
    format: { type: "math", attrs: { contentId } },
    init: parseMathDocumentInit(latex, {
      contentId,
      identityAllocator: identities,
      authority: "supplemental",
    }),
  };
}

/**
 * How the math mark creates, joins, reads and copies its math documents.
 * {@link mathDataExtension} sets it as the math mark spec's `structured` field.
 * You need it only when you build that mark spec by hand.
 */
export const mathStructuredMarkFacet = {
  create: ({ text, identities }) => {
    const created = createStructuredMathMarkAttachment(text, identities);
    return {
      mark: created.format,
      attachments: [{ contentId: created.contentId, edit: created.init }],
    };
  },
  joinSources: ({ left, right }) =>
    left +
    (needsCommandSeparator(left, left.length, right[0] ?? "") ? " " : "") +
    right,
  resolve: ({ mark, attachments }) =>
    getStructuredMathMarkSource(mark, attachments),
  references: ({ mark }) => {
    const contentId = mathMarkContentId(mark);
    return contentId ? [contentId] : [];
  },
  clone: ({ mark, clonedContentIds }) => {
    const sourceContentId = mathMarkContentId(mark);
    const contentId = sourceContentId
      ? clonedContentIds[sourceContentId]
      : undefined;
    return contentId && contentId !== sourceContentId
      ? {
          ...mark,
          attrs: { ...mark.attrs, contentId },
        }
      : undefined;
  },
} satisfies StructuredMarkFacet;

/**
 * The LaTeX of the formula an inline math mark points to. Returns undefined
 * when the mark has no `contentId`, or when its math document is missing or not
 * valid.
 *
 * @group Structured content
 */
export function getStructuredMathMarkSource(
  mark: Mark,
  attachments: StructuredContentMap | undefined,
): string | undefined {
  const contentId = mathMarkContentId(mark);
  const document = contentId
    ? validInlineMathDocument(attachments?.[contentId])
    : undefined;
  const math = document ? structuredToMathDocument(document) : undefined;
  return math ? printMathDocument(math) : undefined;
}

/**
 * The math document an inline math mark points to. Returns undefined when the
 * mark has no `contentId`, or when its document is missing or not valid.
 */
export function getInlineMathStructuredDocument(
  mark: Mark,
  attachments: StructuredContentMap | undefined,
): StructuredDocument | undefined {
  const contentId = mathMarkContentId(mark);
  return contentId
    ? validInlineMathDocument(attachments?.[contentId])
    : undefined;
}

/**
 * Finds every inline formula in a block. Each run gives its place in the
 * visible text, its characters, and its math document and LaTeX when they
 * resolve. Deleted text is skipped. Works without the editor or any canvas
 * code.
 *
 * @group Structured content
 */
export function resolveStructuredInlineMathRuns(
  block: InlineMathHostBlock,
): ResolvedInlineMathRun[] {
  const chars = [...iterateAllChars([...block.charRuns])];
  const ordinal = new Map<string, number>();
  const visible: Array<{ readonly ordinal: number; readonly char: Char }> = [];
  chars.forEach((char, index) => {
    ordinal.set(char.id, index);
    if (!char.deleted) visible.push({ ordinal: index, char });
  });

  const runs: ResolvedInlineMathRun[] = [];
  for (const span of block.formats) {
    if (span.format.type !== "math") continue;
    const startOrdinal = ordinal.get(span.startCharId);
    const endOrdinal = ordinal.get(span.endCharId);
    if (
      startOrdinal === undefined ||
      endOrdinal === undefined ||
      startOrdinal > endOrdinal
    ) {
      continue;
    }

    const selected = visible.filter(
      (entry) => entry.ordinal >= startOrdinal && entry.ordinal <= endOrdinal,
    );
    if (selected.length === 0) continue;
    const startIndex = visible.indexOf(selected[0]);
    const endIndex = startIndex + selected.length;
    const contentId = mathMarkContentId(span.format);
    const candidate = contentId
      ? block.structuredContent?.[contentId]
      : undefined;
    const document = validInlineMathDocument(candidate);
    const math = document ? structuredToMathDocument(document) : undefined;
    runs.push({
      startIndex,
      endIndex,
      charIds: selected.map((entry) => entry.char.id),
      span,
      ...(contentId ? { contentId } : {}),
      ...(document ? { document } : {}),
      ...(math ? { latex: printMathDocument(math) } : {}),
    });
  }
  return runs;
}

/**
 * Whether `document` is the math document of an inline formula. Returns false
 * for a block equation's math document.
 */
export function isInlineMathStructuredDocument(
  document: StructuredDocument | undefined,
): document is StructuredDocument {
  return document?.kind === MATH_STRUCTURED_KIND && !document.authority;
}

function validInlineMathDocument(
  candidate: StructuredDocument | undefined,
): StructuredDocument | undefined {
  if (!candidate || candidate.authority) return undefined;
  return validateStructuredMathDocument(candidate);
}
