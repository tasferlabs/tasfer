/**
 * Generic structured-content CRDT value and reducer.
 *
 * This module deliberately knows nothing about blocks, marks, schemas, or
 * maths.  A feature adapter normalizes its nested public model into this flat
 * store, and the editor operation envelope supplies the containing block and
 * content ids.  Keeping the mutation payload independent of that envelope
 * lets block nodes and inline atoms share the same tree CRDT.
 *
 * Operation ordering is owned by the page op-log.  As with `block_set`, this
 * reducer expects edits to be folded in canonical HLC order; attributes and
 * placements are therefore LWW registers without clocks duplicated in the
 * materialized snapshot.
 */

import type { Char, CharRun, Mark, MarkRange } from "../serlization/loadPage";
import {
  charRunsToChars,
  charsToRuns,
  deleteFromRuns,
  getVisibleTextFromRuns,
  insertIntoRuns,
  iterateAllChars,
} from "./char-runs";
import {
  applyMarkToRange,
  areMarksEqual,
  markKey,
  removeMarkFromRange,
} from "./mark-spans";
import type { IdentityAllocator } from "@shared/identity";

/** A JSON-safe value accepted in a structured node's attribute bag. */
export type StructuredValue =
  | null
  | boolean
  | number
  | string
  | readonly StructuredValue[]
  | { readonly [key: string]: StructuredValue };

/**
 * The complete structural address of a node.
 *
 * `slot` names a child collection on the parent (for example `children`,
 * `numerator`, or `cells`).  The core treats every slot as an ordered list;
 * adapters may impose cardinality such as exactly one child.  Sibling order is
 * `(orderKey, id)`, so equal keys from concurrent inserts remain deterministic.
 */
export interface StructuredPlacement {
  readonly parentId: string | null;
  readonly slot: string;
  readonly orderKey: string;
}

/** One normalized identity-bearing node in a structured document. */
export interface StructuredNode {
  readonly id: string;
  readonly type: string;
  readonly placement: StructuredPlacement;
  readonly attrs: Readonly<Record<string, StructuredValue>>;
  /** Character-CRDT fields (`text`, `latex`, `name`, ...), keyed by adapter. */
  readonly textFields: Readonly<Record<string, readonly CharRun[]>>;
  /**
   * Inline marks over {@link textFields}, keyed by the SAME field name — so a
   * nested text field can carry bold/link/… exactly as block text does, and
   * resolves through the same `resolveMarkRunsFromChars`. Anchored to char
   * identities, so a mark survives concurrent edits inside its range.
   *
   * Unlike a block's `formats`, the spans carry no HLC: structured edits fold in
   * canonical op-log order, so the last applied write already wins. Absent (not
   * an empty object) when a node carries no marks, which keeps documents that
   * never use them byte-identical to before this field existed.
   */
  readonly markFields?: Readonly<Record<string, readonly MarkRange[]>>;
  /** Node tombstone. Descendants remain in the store and become visible again. */
  readonly deleted?: boolean;
}

/** The insertion payload for one node. Children are inserted separately. */
export interface StructuredNodeSeed {
  readonly id: string;
  readonly type: string;
  readonly placement: StructuredPlacement;
  readonly attrs?: Readonly<Record<string, StructuredValue>>;
  readonly textFields?: Readonly<Record<string, readonly CharRun[]>>;
  readonly markFields?: Readonly<Record<string, readonly MarkRange[]>>;
}

/**
 * A normalized structured document. `rootId` is immutable and doubles as the
 * stable content id at the editor operation boundary.
 */
export interface StructuredDocument {
  readonly version: 1;
  /** Extension-owned adapter key (for example `math`), never interpreted here. */
  readonly kind: string;
  /**
   * `block` means this tree, rather than the block's compatibility char runs,
   * owns the block's editable content. Generic flat-text APIs must not mutate
   * those shadow runs. Omit for supplemental structured attachments.
   */
  readonly authority?: "block";
  readonly rootId: string;
  readonly nodes: Readonly<Record<string, StructuredNode>>;
}

/** Optional attachments a block can carry; keyed by stable content id. */
export type StructuredContentMap = Readonly<Record<string, StructuredDocument>>;

/**
 * Deterministically address one extension-owned attachment on a block.
 *
 * Attachment addressing is not identity allocation: the block identity and a
 * schema-stable slot name fully determine it. Every structured feature uses
 * this core convention instead of publishing a `featureContentIdForBlock`
 * scheme of its own. Slot encoding keeps future names containing `/` distinct.
 */
export function structuredContentId(blockId: string, slot: string): string {
  if (blockId.length === 0 || slot.length === 0) {
    throw new Error("Structured content requires a block id and slot");
  }
  return `${blockId}/${encodeURIComponent(slot)}`;
}

/** Whether a block carries any structured attachment, authoritative or supplemental. */
export function hasStructuredContent(block: {
  readonly structuredContent?: StructuredContentMap;
}): boolean {
  return Object.keys(block.structuredContent ?? {}).length > 0;
}

/** Whether any attachment owns this block's editable content surface. */
export function hasStructuredBlockAuthority(block: {
  readonly structuredContent?: StructuredContentMap;
}): boolean {
  return Object.values(block.structuredContent ?? {}).some(
    (document) => document.authority === "block",
  );
}

/**
 * Whether a generic type morph may carry a block's supplemental attachments,
 * or must leave the conversion to the feature that owns them.
 *
 * Attachments are reachable through the marks that reference them, so a target
 * that keeps the block's text and marks keeps them reachable — a paragraph
 * holding an inline formula becomes a list, heading, or quote unchanged. A
 * target that clears the text (a void block) or drops marks (code) would strand
 * the documents behind an unreferenced anchor char, so those conversions stay
 * refused until a feature claims them.
 */
export function canMorphCarryAttachments(
  block: { readonly structuredContent?: StructuredContentMap },
  target: { readonly textual: boolean; readonly retainsMarks: boolean },
): boolean {
  if (!hasStructuredContent(block)) return true;
  return target.textual && target.retainsMarks;
}

/**
 * Carry a block's attachments onto the block that replaces it in a local type
 * morph, so a reconstructed-from-defaults block keeps what the `block_set type`
 * reducer keeps. Attachment identities are scoped to the block id, which the
 * morph preserves, so the copy stays addressable; without it the local view
 * would drop documents that every remote replica retains.
 */
export function carryStructuredContent<Target>(
  target: Target,
  source: { readonly structuredContent?: StructuredContentMap },
): Target {
  if (!source.structuredContent) return target;
  return { ...target, structuredContent: source.structuredContent };
}

/**
 * Documents for `contentIds` that are missing on `host` but present on another
 * block of the page — tombstoned donors included, since a block merge deletes
 * the donor in the same transaction that re-marks the moved anchor.
 *
 * This is the read-side repair for marks whose attachment reference points at
 * a block that no longer owns it (a merge or paste that could not clone kept
 * the old content id). The documents are copied, not moved: the donor keeps
 * its entry, which nothing renders once every referencing mark is healed.
 * Returns undefined when there is nothing to adopt.
 */
export function adoptAttachmentsFromPage(
  page: {
    readonly blocks: ReadonlyArray<{
      readonly id: string;
      readonly structuredContent?: StructuredContentMap;
    }>;
  },
  host: {
    readonly id: string;
    readonly structuredContent?: StructuredContentMap;
  },
  contentIds: readonly string[],
): StructuredContentMap | undefined {
  let adopted: Record<string, StructuredDocument> | undefined;
  for (const contentId of contentIds) {
    if (host.structuredContent?.[contentId]) continue;
    for (const donor of page.blocks) {
      if (donor.id === host.id) continue;
      const document = donor.structuredContent?.[contentId];
      if (document) {
        (adopted ??= {})[contentId] = document;
        break;
      }
    }
  }
  return adopted;
}

/** One schema-independent mutation inside a structured document. */
export type StructuredEdit =
  | {
      readonly kind: "node_insert";
      readonly node: StructuredNodeSeed;
    }
  | {
      readonly kind: "node_delete";
      readonly nodeId: string;
    }
  | {
      readonly kind: "node_move";
      readonly nodeId: string;
      readonly placement: StructuredPlacement;
    }
  | {
      readonly kind: "node_attr_set";
      readonly nodeId: string;
      readonly key: string;
      /** `null` is a real value; deletion has its own mutation kind. */
      readonly value: StructuredValue;
    }
  | {
      readonly kind: "node_attr_delete";
      readonly nodeId: string;
      readonly key: string;
    }
  | {
      readonly kind: "text_insert";
      readonly nodeId: string;
      readonly field: string;
      readonly afterCharId: string | null;
      readonly charRuns: readonly CharRun[];
    }
  | {
      readonly kind: "text_delete";
      readonly nodeId: string;
      readonly field: string;
      readonly charIds: readonly string[];
    }
  | {
      /** Apply or remove one inline mark over a range of a text field. */
      readonly kind: "mark_set";
      readonly nodeId: string;
      readonly field: string;
      /** A contiguous document-order run of the field's character ids. */
      readonly charIds: readonly string[];
      readonly mark: Mark;
      /** `true` marks the range, `false` clears this mark type from it. */
      readonly value: boolean;
    };

/** Page-op payload: atomically initialize an attachment or edit it thereafter. */
export type StructuredMutation =
  | {
      readonly kind: "document_init";
      readonly document: StructuredDocument;
    }
  | {
      /** Remove one whole attachment through an explicit lifecycle action. */
      readonly kind: "document_delete";
    }
  | StructuredEdit;

/** Create an empty store. The root node itself arrives as a `node_insert`. */
export function createStructuredDocument(
  kind: string,
  rootId: string,
): StructuredDocument {
  return { version: 1, kind, rootId, nodes: {} };
}

/** Read one node, including tombstones. */
export function getStructuredNode(
  document: StructuredDocument,
  nodeId: string,
): StructuredNode | undefined {
  return document.nodes[nodeId];
}

/**
 * The inline marks over one text field, in canonical order.
 *
 * Pair with `iterateAllChars` over the same field and hand both to
 * `resolveMarkRunsFromChars` to get the field's mark runs at caret-edge
 * offsets — the identical resolution block text uses.
 */
export function getStructuredMarks(
  document: StructuredDocument,
  nodeId: string,
  field: string,
): readonly MarkRange[] {
  return document.nodes[nodeId]?.markFields?.[field] ?? [];
}

/** Read the visible value of one character-CRDT field. */
export function getStructuredText(
  document: StructuredDocument,
  nodeId: string,
  field: string,
): string {
  const runs = document.nodes[nodeId]?.textFields[field];
  return getVisibleTextFromRuns(runs ? [...runs] : undefined);
}

/** Group key for one parent's children in one slot. */
function childGroupKey(parentId: string, slot: string): string {
  // NUL-separated so no (id, slot) pair can collide with another — the same
  // composite-key convention the op-log replay uses.
  return `${parentId}\u0000${slot}`;
}

/**
 * Every parent/slot's children, resolved once for a whole document.
 *
 * {@link getStructuredChildren} answers one question by scanning every node, so
 * a caller that walks a whole tree is quadratic in the node count. That is
 * nothing for the small trees a formula is, and it is the wrong shape for a
 * grid: a 100-row table asks 100 times, a spreadsheet-sized document far more.
 *
 * Build one of these before such a walk and pass it back in. It is a value
 * derived from — and only valid for — the exact `document` it was built from;
 * it is deliberately NOT a cache hidden inside this module, so two editors on
 * one page can never share or invalidate each other's.
 */
export interface StructuredChildIndex {
  readonly groups: ReadonlyMap<string, readonly StructuredNode[]>;
}

/** Index one document's children by parent and slot, in document order. */
export function buildStructuredChildIndex(
  document: StructuredDocument,
): StructuredChildIndex {
  const groups = new Map<string, StructuredNode[]>();
  for (const node of Object.values(document.nodes)) {
    const { parentId, slot } = node.placement;
    if (parentId === null) continue;
    const key = childGroupKey(parentId, slot);
    const group = groups.get(key);
    if (group) group.push(node);
    else groups.set(key, [node]);
  }
  for (const group of groups.values()) group.sort(compareStructuredSiblings);
  return { groups };
}

/**
 * Resolve direct children in deterministic document order.
 *
 * Orphans are retained by the reducer but do not appear until their parent is
 * present. A deleted parent is not traversable; callers naturally hide its
 * whole subtree by never asking for its children.
 *
 * Pass `index` (see {@link buildStructuredChildIndex}) when walking a whole
 * tree; without it every call scans the document's nodes. The two paths return
 * the same nodes in the same order.
 */
export function getStructuredChildren(
  document: StructuredDocument,
  parentId: string,
  slot: string,
  options: {
    readonly includeDeleted?: boolean;
    readonly index?: StructuredChildIndex;
  } = {},
): StructuredNode[] {
  const parent = document.nodes[parentId];
  if (!parent || (parent.deleted && !options.includeDeleted)) return [];

  if (options.index) {
    const group = options.index.groups.get(childGroupKey(parentId, slot)) ?? [];
    return options.includeDeleted
      ? [...group]
      : group.filter((node) => !node.deleted);
  }

  return Object.values(document.nodes)
    .filter(
      (node) =>
        node.placement.parentId === parentId &&
        node.placement.slot === slot &&
        (options.includeDeleted || !node.deleted),
    )
    .sort(compareStructuredSiblings);
}

/** Apply one mutation. Malformed or inapplicable edits are deterministic no-ops. */
export function applyStructuredEdit(
  document: StructuredDocument,
  edit: StructuredEdit,
): StructuredDocument {
  switch (edit.kind) {
    case "node_insert":
      return applyNodeInsert(document, edit.node);
    case "node_delete":
      return applyNodeDelete(document, edit.nodeId);
    case "node_move":
      return applyNodeMove(document, edit.nodeId, edit.placement);
    case "node_attr_set":
      return applyNodeAttrSet(document, edit.nodeId, edit.key, edit.value);
    case "node_attr_delete":
      return applyNodeAttrDelete(document, edit.nodeId, edit.key);
    case "text_insert":
      return applyTextInsert(document, edit);
    case "text_delete":
      return applyTextDelete(document, edit);
    case "mark_set":
      return applyMarkSet(document, edit);
  }
}

/** Apply an already-canonically-ordered batch. */
export function applyStructuredEdits(
  document: StructuredDocument,
  edits: readonly StructuredEdit[],
): StructuredDocument {
  let next = document;
  for (const edit of edits) next = applyStructuredEdit(next, edit);
  return next;
}

/**
 * Apply the payload carried by a generic page-level `content_edit` operation.
 * Initialization is first-writer-wins in canonical op-log order; later init
 * payloads are deterministic no-ops. Edits received before initialization are
 * retained in the op log and become meaningful if canonical replay orders a
 * valid initializer first.
 */
export function applyStructuredMutation(
  document: StructuredDocument | undefined,
  contentId: string,
  mutation: StructuredMutation,
): StructuredDocument | undefined {
  if (mutation.kind === "document_delete") return undefined;
  if (mutation.kind === "document_init") {
    if (document) return document;
    if (mutation.document.rootId !== contentId) return undefined;
    return validateStructuredDocument(mutation.document);
  }
  return document ? applyStructuredEdit(document, mutation) : undefined;
}

/**
 * Compute emit-time inverses against the pre-edit value.
 *
 * Text deletion may restore several runs but still needs only one insert: all
 * characters remain as tombstones, so the insertion path simply clears their
 * deletion bits. The returned array shape matches page-operation inversion and
 * leaves room for future edits that need multiple inverses.
 */
export function invertStructuredEdit(
  edit: StructuredEdit,
  documentBefore: StructuredDocument,
): StructuredEdit[] {
  const documentAfter = applyStructuredEdit(documentBefore, edit);
  if (documentAfter === documentBefore) return [];

  switch (edit.kind) {
    case "node_insert":
      // The root is the attachment's permanent identity/anchor. Document init
      // is monotonic infrastructure and is not undone as a whole-tree delete.
      return edit.node.id === documentBefore.rootId
        ? []
        : [{ kind: "node_delete", nodeId: edit.node.id }];

    case "node_delete": {
      const node = documentBefore.nodes[edit.nodeId];
      return node ? [{ kind: "node_insert", node: seedFromNode(node) }] : [];
    }

    case "node_move": {
      const node = documentBefore.nodes[edit.nodeId];
      return node
        ? [
            {
              kind: "node_move",
              nodeId: edit.nodeId,
              placement: node.placement,
            },
          ]
        : [];
    }

    case "node_attr_set":
    case "node_attr_delete": {
      const node = documentBefore.nodes[edit.nodeId];
      if (!node) return [];
      return Object.prototype.hasOwnProperty.call(node.attrs, edit.key)
        ? [
            {
              kind: "node_attr_set",
              nodeId: edit.nodeId,
              key: edit.key,
              value: node.attrs[edit.key],
            },
          ]
        : [
            {
              kind: "node_attr_delete",
              nodeId: edit.nodeId,
              key: edit.key,
            },
          ];
    }

    case "text_insert": {
      const before = textField(documentBefore, edit.nodeId, edit.field);
      const after = textField(documentAfter, edit.nodeId, edit.field);
      const beforeVisible = visibleCharIds(before);
      const restoredOrInserted: string[] = [];
      for (const id of visibleCharIds(after)) {
        if (!beforeVisible.has(id)) restoredOrInserted.push(id);
      }
      return restoredOrInserted.length > 0
        ? [
            {
              kind: "text_delete",
              nodeId: edit.nodeId,
              field: edit.field,
              charIds: restoredOrInserted,
            },
          ]
        : [];
    }

    case "text_delete": {
      const runs = textField(documentBefore, edit.nodeId, edit.field);
      const requested = new Set(edit.charIds);
      const chars: Char[] = [];
      let afterCharId: string | null = null;
      let foundFirst = false;
      let previousId: string | null = null;
      for (const { id, char, deleted } of iterateAllChars([...runs])) {
        if (requested.has(id) && !deleted) {
          if (!foundFirst) {
            afterCharId = previousId;
            foundFirst = true;
          }
          chars.push({ id, char });
        }
        previousId = id;
      }
      return chars.length > 0
        ? [
            {
              kind: "text_insert",
              nodeId: edit.nodeId,
              field: edit.field,
              afterCharId,
              charRuns: charsToRuns(chars),
            },
          ]
        : [];
    }

    case "mark_set": {
      // Mirrors the block-level `mark_set` inverse: restore what each character
      // carried *before* the edit, grouped into runs of identical prior state,
      // rather than blindly toggling the mark back. That keeps the inverse
      // concurrency-safe — it never replaces a whole field's spans, so a remote
      // mark made meanwhile survives the undo.
      const node = documentBefore.nodes[edit.nodeId];
      const runs = node?.textFields[edit.field];
      if (!node || !runs) return [];
      const spans = node.markFields?.[edit.field] ?? [];

      const ordinal = new Map<string, number>();
      let position = 0;
      for (const { id } of iterateAllChars([...runs])) {
        ordinal.set(id, position++);
      }
      // At most one same-type span can cover a character: the apply side unions
      // overlapping same-type spans into one.
      const priorMark = (charId: string): Mark | null => {
        const at = ordinal.get(charId);
        if (at === undefined) return null;
        for (const span of spans) {
          if (span.format.type !== edit.mark.type) continue;
          const start = ordinal.get(span.startCharId);
          const end = ordinal.get(span.endCharId);
          if (start === undefined || end === undefined) continue;
          if (at >= start && at <= end) return span.format;
        }
        return null;
      };
      const samePrior = (a: Mark | null, b: Mark | null): boolean =>
        a === null || b === null ? a === b : areMarksEqual(a, b);

      const inverses: StructuredEdit[] = [];
      let index = 0;
      while (index < edit.charIds.length) {
        const prior = priorMark(edit.charIds[index]);
        let last = index;
        while (
          last + 1 < edit.charIds.length &&
          samePrior(priorMark(edit.charIds[last + 1]), prior)
        ) {
          last++;
        }
        inverses.push({
          kind: "mark_set",
          nodeId: edit.nodeId,
          field: edit.field,
          charIds: edit.charIds.slice(index, last + 1),
          mark: prior ?? edit.mark,
          value: prior !== null,
        });
        index = last + 1;
      }
      return inverses;
    }
  }
}

/**
 * Return a JSON-stable snapshot (sorted node/attribute/text-field keys).
 * Tombstones and character deletion masks are intentionally preserved.
 */
export function canonicalizeStructuredDocument(
  document: StructuredDocument,
): StructuredDocument {
  const nodes: Record<string, StructuredNode> = {};
  for (const id of Object.keys(document.nodes).sort()) {
    const node = document.nodes[id];
    const attrs: Record<string, StructuredValue> = {};
    for (const key of Object.keys(node.attrs).sort()) {
      attrs[key] = cloneStructuredValue(node.attrs[key]);
    }
    const textFields: Record<string, readonly CharRun[]> = {};
    for (const field of Object.keys(node.textFields).sort()) {
      textFields[field] = node.textFields[field].map(cloneCharRun);
    }
    const markFields: Record<string, readonly MarkRange[]> = {};
    for (const field of Object.keys(node.markFields ?? {}).sort()) {
      const spans = normalizeMarkSpans(node.markFields![field]);
      if (spans.length > 0) markFields[field] = spans;
    }
    const { markFields: _previous, ...rest } = node;
    nodes[id] = {
      ...rest,
      placement: { ...node.placement },
      attrs,
      textFields,
      ...(Object.keys(markFields).length > 0 ? { markFields } : {}),
    };
  }
  return {
    version: 1,
    kind: document.kind,
    ...(document.authority === undefined
      ? {}
      : { authority: document.authority }),
    rootId: document.rootId,
    nodes,
  };
}

/**
 * Clone a normalized document into a fresh identity domain.
 *
 * The caller chooses the new root/content id; every other node and every text
 * character is allocated from the same persisted allocator. Placements and mark
 * anchors are rewritten generically.
 *
 * Feature-defined attrs are copied verbatim, because core cannot know which of
 * them are identities. A kind that stores a node reference in an attr — a table
 * cell naming its column, say — passes {@link CloneStructuredOptions.rewriteAttrs}
 * to re-point it; without that the copy would still reference the source's
 * identities and resolve to nothing.
 */
export interface CloneStructuredOptions {
  /**
   * Rewrite one node's attrs for the clone. `resolveId` maps a source node id
   * to its counterpart, or `undefined` for an id this document never held (a
   * dangling reference, which the feature decides how to treat).
   */
  readonly rewriteAttrs?: (
    attrs: Readonly<Record<string, StructuredValue>>,
    resolveId: (sourceId: string) => string | undefined,
  ) => Readonly<Record<string, StructuredValue>>;
}

export function cloneStructuredDocumentWithFreshIdentities(
  document: StructuredDocument,
  targetRootId: string,
  identities: IdentityAllocator,
  options: CloneStructuredOptions = {},
): StructuredDocument {
  const source = canonicalizeStructuredDocument(document);
  const nodeIds = new Map<string, string>([[source.rootId, targetRootId]]);
  const reserved = new Set<string>([targetRootId]);

  for (const sourceId of Object.keys(source.nodes).sort()) {
    if (sourceId === source.rootId) continue;
    const targetId = identities.nextId();
    if (reserved.has(targetId)) {
      throw new Error(
        "Structured clone allocator returned a duplicate identity",
      );
    }
    reserved.add(targetId);
    nodeIds.set(sourceId, targetId);
  }

  const nodes: Record<string, StructuredNode> = {};
  for (const sourceId of Object.keys(source.nodes).sort()) {
    const sourceNode = source.nodes[sourceId];
    const targetId = nodeIds.get(sourceId);
    if (!targetId) throw new Error("Structured clone lost a node identity");
    const parentId = sourceNode.placement.parentId;
    const targetParentId = parentId === null ? null : nodeIds.get(parentId);
    if (parentId !== null && !targetParentId) {
      throw new Error("Structured clone found an unknown parent identity");
    }

    const textFields: Record<string, readonly CharRun[]> = {};
    const charIds = new Map<string, string>();
    for (const field of Object.keys(sourceNode.textFields).sort()) {
      const chars: Char[] = [];
      for (const entry of iterateAllChars([...sourceNode.textFields[field]])) {
        const id = identities.nextId();
        if (reserved.has(id)) {
          throw new Error(
            "Structured clone allocator returned a duplicate identity",
          );
        }
        reserved.add(id);
        charIds.set(entry.id, id);
        chars.push({
          id,
          char: entry.char,
          ...(entry.deleted ? { deleted: true } : {}),
        });
      }
      textFields[field] = charsToRuns(chars);
    }

    // Mark spans anchor to character identities, so they are re-addressed with
    // the characters they cover. A span whose anchor did not survive the copy
    // (it named a char this field never had) is dropped rather than left
    // pointing into the source's identity domain.
    const markFields: Record<string, readonly MarkRange[]> = {};
    for (const field of Object.keys(sourceNode.markFields ?? {}).sort()) {
      const spans: MarkRange[] = [];
      for (const span of sourceNode.markFields![field]) {
        const startCharId = charIds.get(span.startCharId);
        const endCharId = charIds.get(span.endCharId);
        if (!startCharId || !endCharId) continue;
        spans.push(cloneMarkSpan({ ...span, startCharId, endCharId }));
      }
      const normalized = normalizeMarkSpans(spans);
      if (normalized.length > 0) markFields[field] = normalized;
    }

    const attrs = options.rewriteAttrs
      ? options.rewriteAttrs(sourceNode.attrs, (sourceId) =>
          nodeIds.get(sourceId),
        )
      : sourceNode.attrs;

    const { markFields: _previous, ...rest } = sourceNode;
    nodes[targetId] = {
      ...rest,
      id: targetId,
      placement: {
        ...sourceNode.placement,
        parentId: targetParentId ?? null,
      },
      attrs: { ...attrs },
      textFields,
      ...(Object.keys(markFields).length > 0 ? { markFields } : {}),
    };
  }

  const cloned = validateStructuredDocument({
    ...source,
    rootId: targetRootId,
    nodes,
  });
  if (!cloned) throw new Error("Structured clone produced an invalid document");
  return cloned;
}

/** Validate and defensively clone a structured attachment received on the wire. */
export function validateStructuredDocument(
  value: StructuredDocument,
): StructuredDocument | undefined {
  try {
    return validateStructuredDocumentUnsafe(value);
  } catch {
    return undefined;
  }
}

function validateStructuredDocumentUnsafe(
  value: StructuredDocument,
): StructuredDocument | undefined {
  if (
    value?.version !== 1 ||
    typeof value.kind !== "string" ||
    value.kind.length === 0 ||
    (value.authority !== undefined && value.authority !== "block") ||
    typeof value.rootId !== "string" ||
    value.rootId.length === 0 ||
    value.nodes === null ||
    typeof value.nodes !== "object" ||
    Array.isArray(value.nodes)
  ) {
    return undefined;
  }

  let document: StructuredDocument = {
    ...createStructuredDocument(value.kind, value.rootId),
    ...(value.authority === undefined ? {} : { authority: value.authority }),
  };
  const deleted: string[] = [];
  const entries = Object.entries(value.nodes).sort(([a], [b]) => {
    if (a === value.rootId) return -1;
    if (b === value.rootId) return 1;
    return a.localeCompare(b);
  });
  for (const [key, node] of entries) {
    if (!node || key !== node.id) return undefined;
    const next = applyNodeInsert(document, seedFromNode(node));
    if (next === document) return undefined;
    document = next;
    if (node.deleted) deleted.push(node.id);
  }
  if (!document.nodes[value.rootId]) return undefined;
  for (const id of deleted) {
    if (id === value.rootId) return undefined;
    document = applyNodeDelete(document, id);
  }
  return canonicalizeStructuredDocument(document);
}

function applyNodeInsert(
  document: StructuredDocument,
  seed: StructuredNodeSeed,
): StructuredDocument {
  if (!isValidNodeSeed(document, seed)) return document;

  const existing = document.nodes[seed.id];
  if (existing) {
    // Re-inserting a tombstoned identity is restoration (used by undo). Its
    // original type/data/placement are immutable through the insert operation.
    if (!existing.deleted) return document;
    const { deleted: _deleted, ...restored } = existing;
    return replaceNode(document, restored);
  }

  const seedAttrs = seed.attrs ?? {};
  const attrs: Record<string, StructuredValue> = {};
  for (const [key, value] of Object.entries(seedAttrs)) {
    if (!isStructuredValue(value)) return document;
    attrs[key] = cloneStructuredValue(value);
  }

  const textFields: Record<string, readonly CharRun[]> = {};
  for (const [field, runs] of Object.entries(seed.textFields ?? {})) {
    if (field.length === 0 || !areValidCharRuns(runs)) return document;
    textFields[field] = runs.map(cloneCharRun);
  }

  // Marks are only meaningful over a field the seed actually carries; a span
  // over a missing field would anchor to characters that do not exist here.
  const markFields: Record<string, readonly MarkRange[]> = {};
  for (const [field, spans] of Object.entries(seed.markFields ?? {})) {
    if (field.length === 0 || !areValidMarkSpans(spans)) return document;
    if (!textFields[field]) return document;
    const normalized = normalizeMarkSpans(spans);
    if (normalized.length > 0) markFields[field] = normalized;
  }

  return replaceNode(document, {
    id: seed.id,
    type: seed.type,
    placement: { ...seed.placement },
    attrs,
    textFields,
    ...(Object.keys(markFields).length > 0 ? { markFields } : {}),
  });
}

function applyNodeDelete(
  document: StructuredDocument,
  nodeId: string,
): StructuredDocument {
  // A structured document always keeps its root as a stable editing anchor.
  if (nodeId === document.rootId) return document;
  const node = document.nodes[nodeId];
  if (!node || node.deleted) return document;
  return replaceNode(document, { ...node, deleted: true });
}

function applyNodeMove(
  document: StructuredDocument,
  nodeId: string,
  placement: StructuredPlacement,
): StructuredDocument {
  const node = document.nodes[nodeId];
  if (!node || nodeId === document.rootId) return document;
  if (!isValidChildPlacement(placement)) return document;
  if (wouldCreateCycle(document, nodeId, placement.parentId)) return document;
  if (placementsEqual(node.placement, placement)) return document;
  return replaceNode(document, { ...node, placement: { ...placement } });
}

function applyNodeAttrSet(
  document: StructuredDocument,
  nodeId: string,
  key: string,
  value: StructuredValue,
): StructuredDocument {
  const node = document.nodes[nodeId];
  if (!node || key.length === 0 || !isStructuredValue(value)) return document;
  if (Object.prototype.hasOwnProperty.call(node.attrs, key)) {
    const current = node.attrs[key];
    if (structuredValuesEqual(current, value)) return document;
  }
  return replaceNode(document, {
    ...node,
    attrs: { ...node.attrs, [key]: cloneStructuredValue(value) },
  });
}

function applyNodeAttrDelete(
  document: StructuredDocument,
  nodeId: string,
  key: string,
): StructuredDocument {
  const node = document.nodes[nodeId];
  if (!node || !Object.prototype.hasOwnProperty.call(node.attrs, key)) {
    return document;
  }
  const attrs = { ...node.attrs };
  delete attrs[key];
  return replaceNode(document, { ...node, attrs });
}

function applyTextInsert(
  document: StructuredDocument,
  edit: Extract<StructuredEdit, { kind: "text_insert" }>,
): StructuredDocument {
  const node = document.nodes[edit.nodeId];
  if (!node || edit.field.length === 0 || !areValidCharRuns(edit.charRuns)) {
    return document;
  }

  const current = [...(node.textFields[edit.field] ?? [])];
  const chars = charRunsToChars(edit.charRuns.map(cloneCharRun));
  if (chars.length === 0) return document;

  const existing = new Map<string, { deleted: boolean }>();
  for (const { id, deleted } of iterateAllChars(current)) {
    existing.set(id, { deleted });
  }

  const idsToRestore = new Set(
    chars
      .filter((char) => existing.get(char.id)?.deleted)
      .map((char) => char.id),
  );
  const charsToInsert = chars.filter((char) => !existing.has(char.id));

  let runs =
    idsToRestore.size > 0 ? restoreChars(current, idsToRestore) : current;
  if (charsToInsert.length > 0) {
    runs = insertIntoRuns(runs, edit.afterCharId, charsToInsert);
  }
  if (runs === current) return document;

  return replaceNode(document, {
    ...node,
    textFields: { ...node.textFields, [edit.field]: runs },
  });
}

function applyTextDelete(
  document: StructuredDocument,
  edit: Extract<StructuredEdit, { kind: "text_delete" }>,
): StructuredDocument {
  const node = document.nodes[edit.nodeId];
  if (!node || edit.field.length === 0 || edit.charIds.length === 0) {
    return document;
  }
  const current = node.textFields[edit.field] ?? [];
  const runs = deleteFromRuns([...current], [...edit.charIds]);
  if (sameCharRuns(current, runs)) return document;
  return replaceNode(document, {
    ...node,
    textFields: { ...node.textFields, [edit.field]: runs },
  });
}

/**
 * Apply or clear one inline mark over a range of a node's text field.
 *
 * The span algebra is shared with the block-level `mark_set` reducer (see
 * `mark-spans`); what differs here is only that the stored spans carry no clock.
 * Marks live only over a field that actually exists, so a mark can never
 * resurrect or invent text.
 */
function applyMarkSet(
  document: StructuredDocument,
  edit: Extract<StructuredEdit, { kind: "mark_set" }>,
): StructuredDocument {
  const node = document.nodes[edit.nodeId];
  if (!node || edit.field.length === 0 || edit.charIds.length === 0) {
    return document;
  }
  if (!isValidMark(edit.mark)) return document;
  const runs = node.textFields[edit.field];
  if (!runs) return document;

  const current = node.markFields?.[edit.field] ?? [];
  const next = edit.value
    ? applyMarkToRange(
        iterateAllChars([...runs]),
        current,
        edit.charIds,
        edit.mark,
        (range) => range,
      )
    : removeMarkFromRange(
        iterateAllChars([...runs]),
        current,
        edit.charIds,
        edit.mark.type,
        (range) => range,
      );
  if (!next) return document;

  const normalized = normalizeMarkSpans(next);
  if (sameMarkSpans(current, normalized)) return document;
  return replaceNode(document, withMarkField(node, edit.field, normalized));
}

/**
 * Replace one field's spans on a node, dropping the whole `markFields` map when
 * nothing is left — a node that carries no marks must not grow an empty object,
 * or documents that never use marks stop being byte-identical across peers that
 * did and did not touch one.
 */
function withMarkField(
  node: StructuredNode,
  field: string,
  spans: readonly MarkRange[],
): StructuredNode {
  const fields: Record<string, readonly MarkRange[]> = {
    ...(node.markFields ?? {}),
  };
  if (spans.length > 0) fields[field] = spans;
  else delete fields[field];
  const { markFields: _previous, ...rest } = node;
  return Object.keys(fields).length > 0
    ? { ...rest, markFields: fields }
    : rest;
}

/**
 * Canonical span order: sorted by anchor then mark identity, exact duplicates
 * collapsed. Applied on every write AND on every insert, so a document rebuilt
 * from an op log and the same document loaded from a snapshot are byte-equal.
 */
function normalizeMarkSpans(spans: readonly MarkRange[]): MarkRange[] {
  const sorted = [...spans].sort((a, b) => {
    if (a.startCharId !== b.startCharId) {
      return a.startCharId < b.startCharId ? -1 : 1;
    }
    if (a.endCharId !== b.endCharId) {
      return a.endCharId < b.endCharId ? -1 : 1;
    }
    const left = markKey(a.format);
    const right = markKey(b.format);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const unique: MarkRange[] = [];
  for (const span of sorted) {
    const previous = unique[unique.length - 1];
    if (
      previous &&
      previous.startCharId === span.startCharId &&
      previous.endCharId === span.endCharId &&
      areMarksEqual(previous.format, span.format)
    ) {
      continue;
    }
    unique.push(cloneMarkSpan(span));
  }
  return unique;
}

function cloneMarkSpan(span: MarkRange): MarkRange {
  return {
    startCharId: span.startCharId,
    endCharId: span.endCharId,
    format: span.format.attrs
      ? { type: span.format.type, attrs: { ...span.format.attrs } }
      : { type: span.format.type },
  };
}

function sameMarkSpans(
  left: readonly MarkRange[],
  right: readonly MarkRange[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every(
    (span, index) =>
      span.startCharId === right[index].startCharId &&
      span.endCharId === right[index].endCharId &&
      areMarksEqual(span.format, right[index].format),
  );
}

function isValidMark(mark: Mark): boolean {
  return (
    mark !== null &&
    typeof mark === "object" &&
    typeof mark.type === "string" &&
    mark.type.length > 0 &&
    (mark.attrs === undefined || isStructuredValue(mark.attrs))
  );
}

function areValidMarkSpans(spans: readonly MarkRange[]): boolean {
  return (
    Array.isArray(spans) &&
    spans.every(
      (span) =>
        span !== null &&
        typeof span === "object" &&
        typeof span.startCharId === "string" &&
        span.startCharId.length > 0 &&
        typeof span.endCharId === "string" &&
        span.endCharId.length > 0 &&
        isValidMark(span.format),
    )
  );
}

function replaceNode(
  document: StructuredDocument,
  node: StructuredNode,
): StructuredDocument {
  return { ...document, nodes: { ...document.nodes, [node.id]: node } };
}

function seedFromNode(node: StructuredNode): StructuredNodeSeed {
  return {
    id: node.id,
    type: node.type,
    placement: node.placement,
    attrs: node.attrs,
    textFields: node.textFields,
    ...(node.markFields ? { markFields: node.markFields } : {}),
  };
}

function textField(
  document: StructuredDocument,
  nodeId: string,
  field: string,
): readonly CharRun[] {
  return document.nodes[nodeId]?.textFields[field] ?? [];
}

function visibleCharIds(runs: readonly CharRun[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const { id, deleted } of iterateAllChars([...runs])) {
    if (!deleted) ids.add(id);
  }
  return ids;
}

function restoreChars(
  runs: readonly CharRun[],
  ids: ReadonlySet<string>,
): CharRun[] {
  return runs.map((run) => {
    if (!run.deletedMask) return run;
    const mask = [...run.deletedMask];
    let changed = false;
    for (let i = 0; i < run.text.length; i++) {
      if (!ids.has(`${run.peerId}:${run.startCounter + i}`)) continue;
      const byte = Math.floor(i / 8);
      const bit = i % 8;
      if (byte < mask.length && (mask[byte] & (1 << bit)) !== 0) {
        mask[byte] &= ~(1 << bit);
        changed = true;
      }
    }
    if (!changed) return run;
    const hasDeleted = mask.some((byte) => byte !== 0);
    return { ...run, deletedMask: hasDeleted ? mask : undefined };
  });
}

function isValidNodeSeed(
  document: StructuredDocument,
  seed: StructuredNodeSeed,
): boolean {
  if (seed.id.length === 0 || seed.type.length === 0) return false;
  if (seed.id === document.rootId) {
    return (
      seed.placement.parentId === null &&
      seed.placement.slot === "" &&
      seed.placement.orderKey === ""
    );
  }
  return (
    isValidChildPlacement(seed.placement) &&
    !wouldCreateCycle(document, seed.id, seed.placement.parentId)
  );
}

function isValidChildPlacement(placement: StructuredPlacement): boolean {
  return (
    typeof placement.parentId === "string" &&
    placement.parentId.length > 0 &&
    placement.slot.length > 0 &&
    placement.orderKey.length > 0
  );
}

function wouldCreateCycle(
  document: StructuredDocument,
  nodeId: string,
  parentId: string | null,
): boolean {
  const visited = new Set<string>();
  let current = parentId;
  while (current !== null) {
    if (current === nodeId) return true;
    if (visited.has(current)) return true;
    visited.add(current);
    current = document.nodes[current]?.placement.parentId ?? null;
  }
  return false;
}

function compareStructuredSiblings(
  a: StructuredNode,
  b: StructuredNode,
): number {
  if (a.placement.orderKey < b.placement.orderKey) return -1;
  if (a.placement.orderKey > b.placement.orderKey) return 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function placementsEqual(
  a: StructuredPlacement,
  b: StructuredPlacement,
): boolean {
  return (
    a.parentId === b.parentId && a.slot === b.slot && a.orderKey === b.orderKey
  );
}

const MAX_STRUCTURED_VALUE_DEPTH = 64;

function isStructuredValue(value: unknown): value is StructuredValue {
  return isStructuredValueAt(value, 0, new Set<object>());
}

function isStructuredValueAt(
  value: unknown,
  depth: number,
  ancestors: Set<object>,
): value is StructuredValue {
  if (depth > MAX_STRUCTURED_VALUE_DEPTH) return false;
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (ancestors.has(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (
    !Array.isArray(value) &&
    prototype !== Object.prototype &&
    prototype !== null
  ) {
    return false;
  }

  ancestors.add(value);
  const children = Array.isArray(value)
    ? value
    : Object.values(value as Record<string, unknown>);
  const valid = children.every((child) =>
    isStructuredValueAt(child, depth + 1, ancestors),
  );
  ancestors.delete(value);
  return valid;
}

function cloneStructuredValue(value: StructuredValue): StructuredValue {
  if (Array.isArray(value)) return value.map(cloneStructuredValue);
  if (value !== null && typeof value === "object") {
    const clone: Record<string, StructuredValue> = {};
    for (const [key, child] of Object.entries(value)) {
      clone[key] = cloneStructuredValue(child);
    }
    return clone;
  }
  return value;
}

function structuredValuesEqual(
  a: StructuredValue,
  b: StructuredValue,
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function areValidCharRuns(runs: readonly CharRun[]): boolean {
  return runs.every(
    (run) =>
      typeof run.peerId === "string" &&
      run.peerId.length > 0 &&
      Number.isSafeInteger(run.startCounter) &&
      run.startCounter >= 0 &&
      typeof run.text === "string" &&
      (run.deletedMask === undefined ||
        run.deletedMask.every(
          (byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255,
        )),
  );
}

function cloneCharRun(run: CharRun): CharRun {
  return {
    ...run,
    deletedMask: run.deletedMask ? [...run.deletedMask] : undefined,
  };
}

function sameCharRuns(
  left: readonly CharRun[],
  right: readonly CharRun[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
