/**
 * Structured attachments owned by inline math marks.
 *
 * A MathMark still covers ordinary block characters so old clients can render,
 * copy, and synchronize it. Once attached, `format.attrs.contentId` points at a
 * supplemental `MathDocument`; the marked characters are its compatibility
 * projection rather than a second editable authority.
 *
 * This module is deliberately data-only. It plans initialization and mark
 * metadata updates but does not choose an input gesture or emit page operation
 * envelopes. Interactive code can therefore commit the returned `document_init`
 * and `mark_set` in the same editor transaction.
 */

import type { StructuredMarkFacet } from "../feature-facets";
import type { Char, CharRun, Mark, MarkSpan } from "../serlization/loadPage";
import { iterateAllChars } from "../sync/char-runs";
import type { IdentityAllocator } from "../sync/id";
import { parseAllocatedIdentity } from "../sync/id";
import {
  structuredContentId,
  type StructuredContentMap,
  type StructuredDocument,
} from "../sync/structured-content";
import {
  MATH_STRUCTURED_KIND,
  type MathDocumentInitMutation,
  parseLegacyMathDocumentInit,
  structuredToMathDocument,
  validateStructuredMathDocument,
} from "./structured";
import { printMathDocument } from "@cypherkit/tex/data";

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
  /** Visible marked characters retained for old clients. */
  readonly compatibilityLatex: string;
  readonly charIds: readonly string[];
  readonly span: MarkSpan;
  /** Persisted attachment reference, when this mark has already migrated. */
  readonly contentId?: string;
  /** Valid referenced math attachment, when present. */
  readonly document?: StructuredDocument;
  /** Canonical tree source when attached, otherwise compatibility source. */
  readonly latex: string;
  /** A persisted reference exists but does not resolve to valid math content. */
  readonly attachmentConflict: boolean;
}

export interface StructuredMathMarkAttachment {
  readonly contentId: string;
  readonly format: Mark & { readonly attrs: MathMarkAttrs };
  readonly init: MathDocumentInitMutation;
}

export type InlineMathMigrationPlan =
  | {
      readonly ok: true;
      readonly contentId: string;
      readonly document: StructuredDocument;
      readonly charIds: readonly string[];
      readonly format: Mark & { readonly attrs: MathMarkAttrs };
      /** Omitted when the referenced attachment was already initialized. */
      readonly init?: MathDocumentInitMutation;
      /** Whether the covering mark needs its contentId persisted. */
      readonly needsMarkUpdate: boolean;
    }
  | {
      readonly ok: false;
      readonly reason:
        | "invalid-legacy-span-identity"
        | "conflicting-attachment"
        | "empty-run";
    };

/** Read a valid structured attachment reference from arbitrary mark attrs. */
export function mathMarkContentId(mark: Mark): string | undefined {
  const value = mark.attrs?.contentId;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Allocate a structured MathMark for newly-authored inline content.
 *
 * Live callers pass the editor's CRDT binding directly. This is construction,
 * not an ID-generator factory: one allocator supplies the mark attachment,
 * math node, and math character identities in a single collision domain.
 *
 * This low-level constructor does not opt the stock editable MathMark into tree
 * mode. A host that persists its result must route every later mark mutation to
 * the returned document (or expose the mark as atomic/read-only) so the legacy
 * character projection cannot diverge from canonical content.
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
    init: parseLegacyMathDocumentInit(latex, {
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
    const compatibilityLatex = selected
      .map((entry) => entry.char.char)
      .join("");
    const contentId = mathMarkContentId(span.format);
    const candidate = contentId
      ? block.structuredContent?.[contentId]
      : undefined;
    const document = validInlineMathDocument(candidate);
    const math = document ? structuredToMathDocument(document) : undefined;
    const attachmentConflict = !!contentId && !!candidate && !document;
    runs.push({
      startIndex,
      endIndex,
      compatibilityLatex,
      charIds: selected.map((entry) => entry.char.id),
      span,
      ...(contentId ? { contentId } : {}),
      ...(document ? { document } : {}),
      latex: math ? printMathDocument(math) : compatibilityLatex,
      attachmentConflict,
    });
  }
  return runs;
}

/**
 * Plan a convergent first-edit migration for one legacy run.
 *
 * Old marks have no contentId. Every peer derives the same generic attachment
 * address from persisted CRDT facts and builds the same initializer with the
 * generic deterministic import allocator. The start-character identity is part
 * of the address because Markdown imports currently stamp every mark clock as
 * `parser:0`; using the clock alone would alias multiple inline equations.
 * Once `contentId` is persisted in mark attrs, it is always preferred and this
 * compatibility derivation is never repeated.
 */
export function planInlineMathMigration(
  block: InlineMathHostBlock,
  run: ResolvedInlineMathRun,
): InlineMathMigrationPlan {
  if (run.charIds.length === 0) return { ok: false, reason: "empty-run" };
  if (run.attachmentConflict) {
    return { ok: false, reason: "conflicting-attachment" };
  }

  const persistedContentId = run.contentId;
  const contentId =
    persistedContentId ?? legacyInlineMathContentId(block.id, run.span);
  if (!contentId) {
    return { ok: false, reason: "invalid-legacy-span-identity" };
  }

  const existing = block.structuredContent?.[contentId];
  const document = validInlineMathDocument(existing);
  if (existing && !document) {
    return { ok: false, reason: "conflicting-attachment" };
  }

  const init = document
    ? undefined
    : parseLegacyMathDocumentInit(run.compatibilityLatex, {
        contentId,
        authority: "supplemental",
      });
  const initialized = document ?? init!.document;
  return {
    ok: true,
    contentId,
    document: initialized,
    charIds: run.charIds,
    format: {
      ...run.span.format,
      attrs: { ...(run.span.format.attrs ?? {}), contentId },
    },
    ...(init ? { init } : {}),
    needsMarkUpdate: persistedContentId !== contentId,
  };
}

function legacyInlineMathContentId(
  blockId: string,
  span: MarkSpan,
): string | undefined {
  const { peerId, counter } = span.clock;
  if (
    typeof peerId !== "string" ||
    peerId.length === 0 ||
    !Number.isSafeInteger(counter) ||
    counter < 0 ||
    span.startCharId.length === 0
  ) {
    return undefined;
  }
  return structuredContentId(
    blockId,
    `mark/math/${peerId}:${counter}/${span.startCharId}`,
  );
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
