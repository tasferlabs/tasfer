/**
 * Run the paragraph's own text code on a text field inside structured content.
 *
 * A feature that keeps prose inside a structured attachment (a table's cells)
 * has to type, delete, format and move a caret exactly the way a paragraph
 * does. Re-implementing each of those behaviours for the field is how the two
 * drift apart. This module instead lends the field to the paragraph code:
 *
 *   1. The field's characters and marks are dressed up as a lone paragraph on
 *      a one-block page — the same single-block surface a title editor is (no
 *      split, no merge, no block conversion) — with the field's caret as the
 *      paragraph's caret.
 *   2. The caller's action (any flat-text action: `insertText`, Backspace, a
 *      mark toggle, an arrow key, …) runs on that state, unmodified.
 *   3. The text ops it produced are re-addressed to the field and committed as
 *      `content_edit` operations; its caret and typing state are carried back.
 *
 * Both stores keep the same character CRDT and the same mark-span algebra, so
 * the ops translate one-for-one: a `text_insert`/`text_delete`/`mark_set`
 * against the stand-in block becomes the same edit against the field, with the
 * same character ids. Nothing about the stored format changes.
 *
 * A structured mark in the field (an inline formula) points at an attachment
 * the field's block holds beside the field's own document. The stand-in
 * borrows each attachment the field's marks point at, the way a paragraph
 * holds them on itself, so the paragraph code can also put a caret INSIDE one
 * and edit it (a formula's tree) — the caret goes in and comes back as a
 * nested selection on the field's block.
 *
 * Two guards keep that translation from ever losing data:
 *
 *   - The paragraph code may only touch the stand-in's text, the attachments
 *     it borrowed, and new attachments for a structured mark it puts on that
 *     text (a typed `$x$` formula); those are written onto the field's block,
 *     where a paragraph would hold them on itself. Any other op (a block
 *     insert, a type change, an edit to an attachment the field does not
 *     point at) means the action did something a text field cannot hold, and
 *     the whole run is refused, as is a structured mark with no attachment
 *     behind it.
 *   - After translating, the field is rebuilt from the translated edits and
 *     compared with the stand-in the paragraph code left behind — every
 *     character id, tombstone and resolved mark — and so is every attachment
 *     the run wrote. A mismatch refuses the run. A refused run changes
 *     nothing; it never commits a guess.
 *
 * The module is node- and mark-agnostic: it addresses a field by ids and never
 * names a feature.
 */

import type { StateResult } from "./action-bus";
import { resolveMarkRunsFromChars } from "./mark-runs";
import type {
  Block,
  CharRun,
  MarkRange,
  MarkSpan,
} from "./serlization/loadPage";
import type {
  ContentEdit,
  EditorState,
  HLC,
  Operation,
  Position,
  RevertibleInputRule,
  UIState,
} from "./state-types";
import {
  type ContentPoint,
  type ContentSelection,
  type ContentTextPoint,
  updateContentSelection,
} from "./structured-selection";
import {
  getCharIdAtVisiblePosition,
  getVisibleOffsetAfterChar,
  iterateAllChars,
} from "./sync/char-runs";
import { applyOp } from "./sync/reducer";
import type { DataSchema } from "./sync/schema";
import {
  applyStructuredEdits,
  canonicalizeStructuredDocument,
  type StructuredContentMap,
  type StructuredDocument,
  type StructuredEdit,
} from "./sync/structured-content";

/** One prose field inside a block's structured attachment. */
export interface TextFieldAddress {
  /** The block that owns the attachment. */
  readonly blockId: string;
  /** The attachment's content id (its structured document's root id). */
  readonly contentId: string;
  readonly nodeId: string;
  readonly field: string;
}

/** A caret (`anchor === focus`) or range, as visible offsets into the field. */
export interface FieldRange {
  readonly anchor: number;
  readonly focus: number;
  /**
   * A caret or range INSIDE an attachment one of the field's structured marks
   * points at (the caret in an inline formula), addressed on the field's
   * block. When set it is the selection; `anchor` and `focus` then name the
   * mark's start in the field, where the formula sits in the text.
   */
  readonly content?: ContentSelection;
}

/** What running an action on a field as a paragraph came to. */
export type FieldRun =
  | {
      readonly kind: "applied";
      /** The editor state with the edits committed and the caret placed. */
      readonly state: EditorState;
      readonly ops: Operation[];
      /** Where the paragraph code left the caret, in field offsets. */
      readonly range: FieldRange;
      /** Whether the field's characters or marks changed. */
      readonly edited: boolean;
      /** Whether the caret or the range moved. */
      readonly moved: boolean;
    }
  | {
      /**
       * The action reached past the field (a block-level op), or its edits did
       * not reproduce on the field. Nothing was changed.
       */
      readonly kind: "refused";
      /**
       * `missing`: the field is not there. `outside`: the action produced an
       * op that is not a text edit of the field. `no-caret`: it left no caret
       * in the field. `mismatch`: the translated edits did not rebuild what the
       * paragraph code produced.
       */
      readonly reason: "missing" | "outside" | "no-caret" | "mismatch";
    };

/** The revert record's rule id while a field's auto-format is armed. */
export const FIELD_PARAGRAPH_REVERT = "text-field.paragraph";

/** The paragraph's own revert record, parked in core's opaque feature slot. */
interface ParkedRevert {
  readonly address: TextFieldAddress;
  readonly record: RevertibleInputRule;
}

/**
 * Spans in a field carry no HLC (structured edits fold in op-log order); a
 * block's do. The stand-in's spans get a clock no real op can carry — the
 * block reducer only compares clocks to skip an op it already applied.
 */
const STAND_IN_CLOCK: HLC = { counter: 0, peerId: "" };

/** The stand-in paragraph's id: never a real block's, and stable per field. */
function standInId(address: TextFieldAddress): string {
  return `text-field:${address.blockId}/${address.contentId}/${address.nodeId}/${address.field}`;
}

/**
 * The schema the paragraph code runs under: paragraphs only, so a typed `# `
 * stays text instead of asking for a heading the field cannot become, with
 * every mark the host allows. That includes structured marks (an inline
 * formula): the attachment one points at sits beside the field's document on
 * the block, so a rule that creates one (a typed `$x$`) writes it there — see
 * {@link translate}. Memoized per schema instance; a schema is immutable, so
 * this is a pure cache.
 */
const fieldSchemas = new WeakMap<DataSchema, DataSchema>();

function fieldSchema(schema: DataSchema): DataSchema {
  const cached = fieldSchemas.get(schema);
  if (cached) return cached;
  const marks = schema
    .markSpecs()
    .map((spec) => spec.type)
    .filter((type) => schema.isMarkAllowed(type));
  let restricted: DataSchema;
  try {
    restricted = schema.restrict({ blocks: ["paragraph"], marks });
  } catch {
    // A host content expression that names other block types cannot hold for
    // a paragraph-only schema; the stand-in page is exactly one paragraph.
    restricted = schema.restrict({
      blocks: ["paragraph"],
      marks,
      content: "paragraph",
    });
  }
  fieldSchemas.set(schema, restricted);
  return restricted;
}

/**
 * The attachments the field's structured marks point at — what the stand-in
 * borrows, so the paragraph code finds them on its block the way it would on a
 * paragraph of its own.
 */
function lentAttachments(
  schema: DataSchema,
  spans: readonly MarkRange[],
  held: StructuredContentMap,
  ownContentId: string,
): StructuredContentMap {
  const lent: Record<string, StructuredDocument> = {};
  for (const span of spans) {
    if (!schema.structuredMark(span.format.type)) continue;
    for (const id of schema.structuredMarkReferences(span.format.type, {
      mark: span.format,
      attachments: held,
    })) {
      if (id !== ownContentId && held[id]) lent[id] = held[id];
    }
  }
  return lent;
}

/** `point` re-addressed to `blockId`, everything else kept. */
function retargetPoint(point: ContentPoint, blockId: string): ContentPoint {
  return point.blockId === blockId ? point : { ...point, blockId };
}

/** Every point of `selection` re-addressed to `blockId`. */
function retarget(
  selection: ContentSelection,
  blockId: string,
): ContentSelection {
  return {
    ...selection,
    anchor: retargetPoint(selection.anchor, blockId),
    focus: retargetPoint(selection.focus, blockId),
    ...(selection.initialBoundary
      ? {
          initialBoundary: {
            start: retargetPoint(selection.initialBoundary.start, blockId),
            end: retargetPoint(selection.initialBoundary.end, blockId),
          },
        }
      : {}),
    ...(selection.unsnapped
      ? {
          unsnapped: {
            anchor: retargetPoint(selection.unsnapped.anchor, blockId),
            focus: retargetPoint(selection.unsnapped.focus, blockId),
          },
        }
      : {}),
  };
}

function cloneRuns(runs: readonly CharRun[]): CharRun[] {
  return runs.map((run) =>
    run.deletedMask
      ? { ...run, deletedMask: [...run.deletedMask] }
      : { ...run },
  );
}

/** The field's text and marks as a paragraph block. */
function standInBlock(
  address: TextFieldAddress,
  runs: readonly CharRun[],
  spans: readonly MarkRange[],
  lent: StructuredContentMap,
): Block {
  const formats: MarkSpan[] = spans.map((span) => ({
    startCharId: span.startCharId,
    endCharId: span.endCharId,
    format: span.format.attrs
      ? { type: span.format.type, attrs: { ...span.format.attrs } }
      : { type: span.format.type },
    clock: STAND_IN_CLOCK,
  }));
  return {
    id: standInId(address),
    type: "paragraph",
    orderKey: "a0",
    charRuns: cloneRuns(runs),
    formats,
    ...(Object.keys(lent).length > 0 ? { structuredContent: { ...lent } } : {}),
  } as Block;
}

function fieldOf(document: StructuredDocument, address: TextFieldAddress) {
  const node = document.nodes[address.nodeId];
  if (!node || node.deleted) return undefined;
  const runs = node.textFields[address.field];
  if (!runs) return undefined;
  return { runs, spans: node.markFields?.[address.field] ?? [] };
}

function attachmentOf(state: EditorState, address: TextFieldAddress) {
  const page = state.document.page;
  const blockIndex = page.blocks.findIndex(
    (block) => block.id === address.blockId,
  );
  const block = page.blocks[blockIndex];
  const document = block?.structuredContent?.[address.contentId];
  if (!block || block.deleted || !document) return undefined;
  return { block, blockIndex, document };
}

function position(textIndex: number): Position {
  return { blockIndex: 0, textIndex };
}

function unpark(
  record: RevertibleInputRule | null,
  address: TextFieldAddress,
): RevertibleInputRule | null {
  if (record?.kind !== "feature" || record.ruleId !== FIELD_PARAGRAPH_REVERT) {
    return null;
  }
  const parked = record.data as ParkedRevert;
  return sameAddress(parked.address, address) ? parked.record : null;
}

function sameAddress(a: TextFieldAddress, b: TextFieldAddress): boolean {
  return (
    a.blockId === b.blockId &&
    a.contentId === b.contentId &&
    a.nodeId === b.nodeId &&
    a.field === b.field
  );
}

function isFieldPoint(
  point: unknown,
  address: TextFieldAddress,
): point is ContentTextPoint {
  const candidate = point as Partial<ContentTextPoint> | null;
  return (
    candidate?.kind === "text" &&
    candidate.blockId === address.blockId &&
    candidate.contentId === address.contentId &&
    candidate.nodeId === address.nodeId &&
    candidate.field === address.field
  );
}

function fieldPoint(
  address: TextFieldAddress,
  runs: readonly CharRun[],
  offset: number,
): ContentTextPoint {
  return {
    kind: "text",
    blockId: address.blockId,
    contentId: address.contentId,
    nodeId: address.nodeId,
    field: address.field,
    afterCharId: getCharIdAtVisiblePosition([...runs], offset),
    affinity: "forward",
  };
}

/** The paragraph-shaped state the action runs on. */
function standInState(
  state: EditorState,
  address: TextFieldAddress,
  block: Block,
  range: FieldRange,
  runs: readonly CharRun[],
): EditorState {
  const now = Date.now();
  const composition = state.ui.composition;
  let standInComposition = composition;
  if (composition && isFieldPoint(composition.startPosition, address)) {
    const offset = getVisibleOffsetAfterChar(
      [...runs],
      composition.startPosition.afterCharId,
    );
    standInComposition =
      offset === null
        ? composition
        : { ...composition, startPosition: position(offset) };
  }
  const suppressed = state.ui.suppressedInputRule;
  // A caret inside a borrowed attachment is the stand-in's nested caret, as
  // it would be in a paragraph: it clears the flat cursor and range.
  const nested = range.content ? retarget(range.content, block.id) : null;
  return {
    ...state,
    schema: fieldSchema(state.schema),
    document: {
      page: { ...state.document.page, blocks: [block] },
      cursor: nested
        ? null
        : { position: position(range.focus), lastUpdate: now },
      selection:
        nested || range.anchor === range.focus
          ? null
          : {
              anchor: position(range.anchor),
              focus: position(range.focus),
              isForward: range.anchor <= range.focus,
              isCollapsed: false,
              lastUpdate: now,
            },
      contentSelection: nested,
    },
    ui: {
      ...state.ui,
      composition: standInComposition,
      revertibleInputRule: unpark(state.ui.revertibleInputRule, address),
      suppressedInputRule: suppressed?.blockId === block.id ? suppressed : null,
      caretScratch: null,
      selectionExpansion: null,
      // Hover names real page blocks by index; on the one-block stand-in,
      // index 0 is the field, so a hover over the page's first block would
      // read as a hover over the field. The real hover is kept (see carryUi).
      inlineMathHover: null,
      hoveredMathBlockIndex: null,
    },
    view: {
      ...state.view,
      visibleBlocks: [{ ...block, originalIndex: 0 }],
      window: { select: () => new Set([0]), singleBlock: true },
    },
  };
}

/** An edit the paragraph code made to an attachment beside the field. */
interface AttachmentEdit {
  readonly contentId: string;
  readonly edit: ContentEdit["edit"];
}

/**
 * The stand-in's ops as edits on the field, plus the edits it made to the
 * attachments beside it, for the field's block — or `null` for any other op.
 *
 * Two kinds of attachment edit are taken. A `document_init` for a content id
 * nothing on the block uses yet is a NEW attachment (a typed formula's
 * document); it goes to `created`, written before anything else. Any edit to
 * an attachment the stand-in borrowed, or to one this run created, is an edit
 * inside it (typing in a formula's tree), kept in order. Anything else written
 * into an attachment means the action reached past the field.
 */
function translate(
  ops: readonly Operation[],
  standIn: string,
  address: TextFieldAddress,
  existing: Readonly<Record<string, unknown>>,
  lent: StructuredContentMap,
): {
  edits: StructuredEdit[];
  created: AttachmentEdit[];
  inside: AttachmentEdit[];
} | null {
  const edits: StructuredEdit[] = [];
  const created: AttachmentEdit[] = [];
  const inside: AttachmentEdit[] = [];
  const { nodeId, field } = address;
  for (const op of ops) {
    if (
      op.op === "content_edit" &&
      op.blockId === standIn &&
      op.edit.kind === "document_init" &&
      op.contentId !== address.contentId &&
      !(op.contentId in existing) &&
      !created.some((entry) => entry.contentId === op.contentId)
    ) {
      created.push({ contentId: op.contentId, edit: op.edit });
    } else if (
      op.op === "content_edit" &&
      op.blockId === standIn &&
      op.contentId !== address.contentId &&
      (op.contentId in lent ||
        created.some((entry) => entry.contentId === op.contentId))
    ) {
      inside.push({ contentId: op.contentId, edit: op.edit });
    } else if (op.op === "text_insert" && op.blockId === standIn) {
      edits.push({
        kind: "text_insert",
        nodeId,
        field,
        afterCharId: op.afterCharId,
        charRuns: op.charRuns,
      });
    } else if (op.op === "text_delete" && op.blockId === standIn) {
      edits.push({ kind: "text_delete", nodeId, field, charIds: op.charIds });
    } else if (op.op === "mark_set" && op.blockId === standIn) {
      edits.push({
        kind: "mark_set",
        nodeId,
        field,
        charIds: op.charIds,
        mark: op.format,
        value: op.value,
      });
    } else {
      return null;
    }
  }
  return { edits, created, inside };
}

/**
 * Every character (id, text, tombstone), and the marks each visible character
 * carries. Marks are compared per character rather than per span: a block
 * keeps two touching spans of one mark where a field's store merges them, and
 * both mean the same text.
 */
function fingerprint(runs: readonly CharRun[], spans: readonly MarkRange[]) {
  const chars = [...iterateAllChars([...runs])].map(
    (char) => `${char.id}|${char.char}|${char.deleted ? 1 : 0}`,
  );
  const visible = chars.filter((char) => char.endsWith("|0")).length;
  const marks: string[][] = Array.from({ length: visible }, () => []);
  for (const run of resolveMarkRunsFromChars(
    iterateAllChars([...runs]),
    spans,
  )) {
    const key = `${run.name}|${JSON.stringify(run.attrs)}`;
    for (let at = run.startIndex; at < run.endIndex; at++) {
      marks[at]?.push(key);
    }
  }
  return JSON.stringify([
    chars,
    marks.map((keys) => [...new Set(keys)].sort()),
  ]);
}

/**
 * Where the paragraph code left the caret: a flat caret or range, or a nested
 * selection inside one of the stand-in's attachments — given back on the
 * field's block, with the flat ends at the start of the mark pointing at it.
 */
function rangeOf(
  state: EditorState,
  standIn: Block,
  address: TextFieldAddress,
): FieldRange | null {
  const { cursor, selection, contentSelection } = state.document;
  if (contentSelection) {
    if (contentSelection.focus.blockId !== standIn.id) return null;
    const at = structuredMarkStart(state.schema, standIn, contentSelection);
    if (at === null) return null;
    return {
      anchor: at,
      focus: at,
      content: retarget(contentSelection, address.blockId),
    };
  }
  if (selection && !selection.isCollapsed) {
    if (selection.anchor.blockIndex !== 0 || selection.focus.blockIndex !== 0) {
      return null;
    }
    return {
      anchor: selection.anchor.textIndex,
      focus: selection.focus.textIndex,
    };
  }
  if (!cursor || cursor.position.blockIndex !== 0) return null;
  return {
    anchor: cursor.position.textIndex,
    focus: cursor.position.textIndex,
  };
}

/** The visible start of the stand-in mark pointing at the selection's attachment. */
function structuredMarkStart(
  schema: DataSchema,
  block: Block,
  selection: ContentSelection,
): number | null {
  const { charRuns, formats } = block as {
    charRuns?: CharRun[];
    formats?: MarkSpan[];
  };
  if (!charRuns || !formats) return null;
  for (const run of resolveMarkRunsFromChars(
    iterateAllChars([...charRuns]),
    formats,
  )) {
    if (!schema.structuredMark(run.name)) continue;
    const mark = { type: run.name, attrs: run.attrs };
    const references = schema.structuredMarkReferences(run.name, {
      mark,
      attachments: block.structuredContent,
    });
    if (references.includes(selection.focus.contentId)) return run.startIndex;
  }
  return null;
}

/** Same document, compared by content (node order aside). */
function sameDocument(
  a: StructuredDocument | undefined,
  b: StructuredDocument | undefined,
): boolean {
  if (!a || !b) return a === b;
  return (
    JSON.stringify(canonicalizeStructuredDocument(a)) ===
    JSON.stringify(canonicalizeStructuredDocument(b))
  );
}

/** Two field ranges at the same place (a nested caret's timestamp aside). */
function sameRange(a: FieldRange, b: FieldRange): boolean {
  if (a.anchor !== b.anchor || a.focus !== b.focus) return false;
  if (!a.content || !b.content) return !a.content && !b.content;
  const points = (selection: ContentSelection) =>
    JSON.stringify([selection.anchor, selection.focus]);
  return points(a.content) === points(b.content);
}

/**
 * Carry the typing state the paragraph code left behind onto the real editor.
 *
 * `placed` is the editor after its nested caret was placed; `original` is the
 * editor before the action. A slot the action left untouched keeps the
 * original's value (placing the caret clears some of them, and the paragraph
 * code did not ask for that); a slot it changed comes back re-addressed to the
 * field.
 */
function carryUi(
  original: UIState,
  placed: UIState,
  before: UIState,
  after: UIState,
  address: TextFieldAddress,
  runs: readonly CharRun[],
): UIState {
  let composition = original.composition;
  if (after.composition !== before.composition) {
    const start = after.composition?.startPosition as Position | undefined;
    composition =
      after.composition && start && "textIndex" in start
        ? {
            ...after.composition,
            startPosition: fieldPoint(address, runs, start.textIndex),
          }
        : after.composition;
  }
  let revertibleInputRule = original.revertibleInputRule;
  if (after.revertibleInputRule !== before.revertibleInputRule) {
    revertibleInputRule = after.revertibleInputRule
      ? {
          kind: "feature",
          ruleId: FIELD_PARAGRAPH_REVERT,
          data: {
            address,
            record: after.revertibleInputRule,
          } satisfies ParkedRevert,
        }
      : null;
  }
  return {
    ...placed,
    mode: after.mode,
    activeMarksMode: after.activeMarksMode,
    composition,
    revertibleInputRule,
    suppressedInputRule:
      after.suppressedInputRule !== before.suppressedInputRule
        ? after.suppressedInputRule
        : original.suppressedInputRule,
  };
}

/**
 * Run `action` on the field at `address` as if the field were a lone
 * paragraph whose caret (or range) is `range`, and commit what it did.
 *
 * `action` receives a complete editor state — the same bus, registries and
 * typing state, with the field as the page's only block — and returns what any
 * flat-text action returns. Dispatching through `state.actionBus` is fine:
 * the stand-in has no nested caret, so feature handlers that own nested
 * carets stand down and the paragraph's own handlers answer.
 */
export function runFieldAsParagraph(
  state: EditorState,
  address: TextFieldAddress,
  range: FieldRange,
  action: (paragraph: EditorState) => StateResult,
): FieldRun {
  const attachment = attachmentOf(state, address);
  const field = attachment && fieldOf(attachment.document, address);
  if (!attachment || !field) return { kind: "refused", reason: "missing" };

  const held = attachment.block.structuredContent ?? {};
  const lent = lentAttachments(
    state.schema,
    field.spans,
    held,
    address.contentId,
  );
  // A nested caret can only be lent along with the attachment it sits in.
  if (range.content) {
    const { anchor, focus } = range.content;
    if (
      anchor.blockId !== address.blockId ||
      focus.blockId !== address.blockId ||
      anchor.contentId !== focus.contentId ||
      !(focus.contentId in lent)
    ) {
      return { kind: "refused", reason: "missing" };
    }
  }
  const block = standInBlock(address, field.runs, field.spans, lent);
  const before = standInState(state, address, block, range, field.runs);
  const result = action(before);

  const translated = translate(result.ops, block.id, address, held, lent);
  if (!translated) return { kind: "refused", reason: "outside" };
  const { edits, created, inside } = translated;

  // Rebuild the field from the translated edits and hold it to the stand-in
  // the paragraph code produced.
  const document = applyStructuredEdits(attachment.document, edits);
  const rebuilt = fieldOf(document, address);
  const after = result.state.document.page.blocks;
  const standIn = after.length === 1 ? after[0] : undefined;
  if (
    !rebuilt ||
    !standIn ||
    standIn.id !== block.id ||
    standIn.type !== "paragraph" ||
    standIn.deleted ||
    fingerprint(rebuilt.runs, rebuilt.spans) !==
      fingerprint(
        (standIn as { charRuns: CharRun[] }).charRuns,
        (standIn as { formats: MarkSpan[] }).formats,
      )
  ) {
    return { kind: "refused", reason: "mismatch" };
  }
  const landed = rangeOf(result.state, standIn, address);
  if (!landed) return { kind: "refused", reason: "no-caret" };
  // A structured mark this run puts on must point at an attachment the block
  // will hold — one already there, or one this run creates. A bare mark with
  // nothing behind it would serialize to syntax that reloads as literal text.
  const createdIds = new Set(created.map((entry) => entry.contentId));
  for (const edit of edits) {
    if (edit.kind !== "mark_set" || !edit.value) continue;
    if (!state.schema.structuredMark(edit.mark.type)) continue;
    const references = state.schema.structuredMarkReferences(edit.mark.type, {
      mark: edit.mark,
      attachments: standIn.structuredContent ?? held,
    });
    if (
      references.length === 0 ||
      references.some((id) => !(id in held) && !createdIds.has(id))
    ) {
      return { kind: "refused", reason: "mismatch" };
    }
  }

  // Commit: one content_edit per edit, through the reducer every peer runs.
  // New attachments go first, so no mark ever points at an attachment the log
  // has not created yet, and an undo (replayed in reverse) removes the mark
  // before its attachment. Edits inside an attachment keep their order.
  let page = state.document.page;
  const ops: Operation[] = [];
  const commit = (contentId: string, edit: ContentEdit["edit"]) => {
    const op: ContentEdit = {
      op: "content_edit",
      id: state.CRDTbinding.nextId(),
      clock: state.CRDTbinding.getClock(),
      pageId: state.CRDTbinding.pageId,
      blockId: address.blockId,
      contentId,
      edit,
    };
    page = applyOp(page, op, state.schema);
    ops.push(op);
  };
  // An attachment the run removes (Backspace over a formula) goes LAST, after
  // the field edits that drop the mark pointing at it, the way a paragraph
  // orders it — so no mark ever points at an attachment already gone, and an
  // undo brings the attachment back before the mark that needs it.
  const removedLast = new Set(
    inside.filter(
      (entry, at) =>
        entry.edit.kind === "document_delete" &&
        !inside
          .slice(at + 1)
          .some((later) => later.contentId === entry.contentId),
    ),
  );
  for (const entry of created) commit(entry.contentId, entry.edit);
  for (const entry of inside) {
    if (!removedLast.has(entry)) commit(entry.contentId, entry.edit);
  }
  for (const edit of edits) commit(address.contentId, edit);
  for (const entry of removedLast) commit(entry.contentId, entry.edit);
  const committedBlock = page.blocks.find(
    (candidate) => candidate.id === address.blockId,
  );
  // Every attachment the run wrote must now read on the block exactly as the
  // paragraph code left it on the stand-in.
  for (const contentId of new Set([
    ...createdIds,
    ...inside.map((entry) => entry.contentId),
  ])) {
    if (
      !sameDocument(
        committedBlock?.structuredContent?.[contentId],
        standIn.structuredContent?.[contentId],
      )
    ) {
      return { kind: "refused", reason: "mismatch" };
    }
  }
  const edited = ops.length > 0;
  // The block's memoized layout was computed for the old content.
  if (edited && committedBlock) committedBlock.cachedLayout = undefined;

  const runs = rebuilt.runs;
  let next: EditorState = { ...state, document: { ...state.document, page } };
  next = updateContentSelection(
    {
      ...next,
      document: { ...next.document, cursor: null, selection: null },
    },
    landed.content
      ? { ...landed.content, lastUpdate: Date.now() }
      : {
          anchor: fieldPoint(address, runs, landed.anchor),
          focus: fieldPoint(address, runs, landed.focus),
          lastUpdate: Date.now(),
        },
  );
  // Placing the nested caret resets the typing state a caret move resets; the
  // paragraph code already decided what that state is after this action.
  next = {
    ...next,
    ui: carryUi(state.ui, next.ui, before.ui, result.state.ui, address, runs),
  };

  return {
    kind: "applied",
    state: next,
    ops,
    range: landed,
    edited,
    moved: !sameRange(landed, range),
  };
}

/**
 * The paragraph auto-format armed on this field, if any — what a take-back
 * (Backspace, or the first undo) would revert. The record is the paragraph
 * code's own; {@link runFieldAsParagraph} hands it back to that code.
 */
export function armedFieldRevert(
  state: EditorState,
): TextFieldAddress | undefined {
  const record = state.ui.revertibleInputRule;
  if (record?.kind !== "feature" || record.ruleId !== FIELD_PARAGRAPH_REVERT) {
    return undefined;
  }
  return (record.data as ParkedRevert).address;
}
