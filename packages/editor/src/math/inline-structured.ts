/**
 * Structured attachments owned by inline math marks.
 *
 * A MathMark anchors on a single flat placeholder character
 * ({@link import("../feature-facets").STRUCTURED_MARK_ANCHOR_CHAR});
 * `format.attrs.contentId` points at the supplemental `MathDocument` that is
 * the mark's only source. Every creation path mints the attachment in the
 * same transaction that inserts the anchor char.
 *
 * This module is deliberately data-only. It builds initializers and mark
 * metadata but does not choose an input gesture or emit page operation
 * envelopes.
 */

import type { StructuredMarkFacet } from "../feature-facets";
import type { Char, CharRun, Mark, MarkSpan } from "../serlization/loadPage";
import { iterateAllChars } from "../sync/char-runs";
import type { IdentityAllocator } from "../sync/id";
import { parseAllocatedIdentity } from "../sync/id";
import type {
  StructuredContentMap,
  StructuredDocument,
} from "../sync/structured-content";
import {
  MATH_STRUCTURED_KIND,
  type MathDocumentInitMutation,
  parseMathDocumentInit,
  structuredToMathDocument,
  validateStructuredMathDocument,
} from "./structured";
import { printMathDocument } from "@tasfer/tex/data";

/** Persisted attributes accepted by the structured and legacy MathMark paths. */
export type MathMarkAttrs = {
  /** Stable root/address of this mark's supplemental MathDocument. */
  readonly contentId?: string;
};

/** Minimal textual-block shape needed by the data-only resolver. */
export interface InlineMathHostBlock {
  readonly id: string;
  readonly charRuns: readonly CharRun[];
  readonly formats: readonly MarkSpan[];
  readonly structuredContent?: StructuredContentMap;
}

/** One surviving inline-math run resolved against CRDT tombstones. */
export interface ResolvedInlineMathRun {
  readonly startIndex: number;
  readonly endIndex: number;
  readonly charIds: readonly string[];
  readonly span: MarkSpan;
  /** Persisted attachment reference. Absent only on a broken mark. */
  readonly contentId?: string;
  /** Valid referenced math attachment, when it resolves. */
  readonly document?: StructuredDocument;
  /** Canonical tree source; undefined when the attachment is missing/invalid. */
  readonly latex?: string;
}

export interface StructuredMathMarkAttachment {
  readonly contentId: string;
  readonly format: Mark & { readonly attrs: MathMarkAttrs };
  readonly init: MathDocumentInitMutation;
}

/** Read a valid structured attachment reference from arbitrary mark attrs. */
export function mathMarkContentId(mark: Mark): string | undefined {
  const value = mark.attrs?.contentId;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Allocate a structured MathMark for newly-authored inline content.
 *
 * Live callers pass the editor's CRDT binding directly; parse-time callers
 * (markdown import) pass their deterministic import allocator. This is
 * construction, not an ID-generator factory: one allocator supplies the mark
 * attachment, math node, and math character identities in a single collision
 * domain.
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
 * Structured-content behavior of the math mark, carried on its spec
 * (`MarkSpec.structured`) and dispatched by the spec's own type.
 */
export const mathStructuredMarkFacet = {
  create: ({ text, identities }) => {
    const created = createStructuredMathMarkAttachment(text, identities);
    return {
      mark: created.format,
      attachments: [{ contentId: created.contentId, edit: created.init }],
    };
  },
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

/** Canonical source for a referenced supplemental MathDocument. */
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

/** Resolve the valid supplemental document referenced by one MathMark. */
export function getInlineMathStructuredDocument(
  mark: Mark,
  attachments: StructuredContentMap | undefined,
): StructuredDocument | undefined {
  const contentId = mathMarkContentId(mark);
  return contentId
    ? validInlineMathDocument(attachments?.[contentId])
    : undefined;
}

/** Resolve every surviving MathMark without importing rendering/editor state. */
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

/** Runtime discriminator used by generic attachment tooling. */
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
