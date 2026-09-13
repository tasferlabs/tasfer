/**
 * Shared fixtures for the text data-safety suite.
 *
 * The suite drives the same edits through two surfaces — a plain paragraph and
 * a table cell — and reads back what each one actually stored: the visible
 * characters, the marks over them, and where the caret sits. Everything is read
 * from the document, never from layout, so a test here fails only when stored
 * data (or the place the next edit will land) changes.
 */

import { registerTableActions } from "../actions";
import { registerTableInputActions } from "../input";
import { CELL_TEXT_FIELD, getTableDocument, readTable } from "../structured";
import { tableExtension } from "../table-extension";
import { createNodeRegistry } from "@tasfer/editor";
import { createActionBus } from "@tasfer/editor/action-bus";
import { resolveMarkRunsFromChars } from "@tasfer/editor/mark-runs";
import { createMarkRegistry } from "@tasfer/editor/rendering/marks";
import { baseSchema } from "@tasfer/editor/schema";
import {
  moveCursorToPosition,
  updateSelection,
} from "@tasfer/editor/selection";
import type {
  Block,
  CharRun,
  MarkRange,
} from "@tasfer/editor/serlization/loadPage";
import type { Page } from "@tasfer/editor/serlization/loadPage";
import { loadPage } from "@tasfer/editor/serlization/loadPage";
import { serializeToMarkdown } from "@tasfer/editor/serlization/serializer";
import type { EditorState } from "@tasfer/editor/state-types";
import { createInitialState } from "@tasfer/editor/state-utils";
import { updateContentSelection } from "@tasfer/editor/structured-selection";
import {
  getCharIdAtVisiblePosition,
  getVisibleOffsetAfterChar,
  getVisibleTextFromRuns,
  iterateAllChars,
} from "@tasfer/editor/sync/char-runs";
import { blocksToOps } from "@tasfer/editor/sync/snapshot-diff";
import {
  createCRDTbinding,
  createSyncEngine,
  type Operation,
} from "@tasfer/editor/sync/sync";

export const schema = baseSchema.use(tableExtension());

export function markdownOf(state: EditorState): string {
  return serializeToMarkdown(state.document.page.blocks, undefined, {
    schema: schema.data,
  });
}

/** A fresh editor over `source`, stamping ops as `peerId`. */
export function editorOf(source: string, peerId = "local"): EditorState {
  const bus = createActionBus();
  registerTableInputActions(bus);
  // Caret moves (the arrow keys), as a mounted table registers them.
  registerTableActions(bus);
  const page = loadPage(source, schema.data);
  const state = createInitialState(page, {
    schema: schema.data,
    nodes: createNodeRegistry(schema.nodes),
    marks: createMarkRegistry(schema.marks),
    crdtBinding: createCRDTbinding(page.id, peerId),
  });
  return { ...state, actionBus: bus };
}

/**
 * Text plus marks as a flat, comparable value: runs of equally marked text.
 * `[["one", []], ["two", ["strong"]]]` reads "one**two**".
 */
export type RichText = readonly (readonly [string, readonly string[]])[];

export function richText(
  runs: readonly CharRun[] | undefined,
  marks: readonly MarkRange[] | undefined,
): RichText {
  const chars = [...iterateAllChars(runs ? [...runs] : [])];
  const visible = getVisibleTextFromRuns(runs ? [...runs] : []);
  const perChar: string[][] = Array.from({ length: visible.length }, () => []);
  for (const run of resolveMarkRunsFromChars(chars, marks ?? [])) {
    const key = Object.keys(run.attrs).length
      ? `${run.name}${JSON.stringify(run.attrs)}`
      : run.name;
    for (let i = run.startIndex; i < run.endIndex; i++) {
      if (!perChar[i].includes(key)) perChar[i].push(key);
    }
  }
  const out: [string, string[]][] = [];
  for (let i = 0; i < visible.length; i++) {
    const keys = perChar[i].sort();
    const last = out[out.length - 1];
    if (last && last[1].join() === keys.join()) last[0] += visible[i];
    else out.push([visible[i], keys]);
  }
  return out;
}

/** Caret or selection as visible offsets within the surface's text. */
export interface Offsets {
  readonly anchor: number;
  readonly focus: number;
}

/**
 * One editable run of text. A paragraph and a table cell each implement it, so
 * a script can run against both and the results can be compared directly.
 */
export interface TextSurface {
  readonly name: string;
  /** A fresh editor whose surface holds `text` (letters and spaces only). */
  create(text: string, peerId?: string): EditorState;
  select(state: EditorState, anchor: number, focus: number): EditorState;
  read(state: EditorState): RichText;
  selection(state: EditorState): Offsets | null;
}

// ─── Paragraph ───────────────────────────────────────────────────────────────

function paragraphBlock(state: EditorState): Block & {
  charRuns: CharRun[];
  formats: MarkRange[];
} {
  const block = state.document.page.blocks.find((b) => !b.deleted);
  if (!block || block.type !== "paragraph") {
    throw new Error("paragraph surface lost its paragraph");
  }
  return block as never;
}

export const paragraphSurface: TextSurface = {
  name: "paragraph",
  create: (text, peerId) => editorOf(text, peerId),
  select(state, anchor, focus) {
    // The cursor always rests on the focus; a range is a selection on top.
    state = moveCursorToPosition(updateSelection(state, null), 0, focus);
    if (anchor === focus) return state;
    return updateSelection(state, {
      anchor: { blockIndex: 0, textIndex: anchor },
      focus: { blockIndex: 0, textIndex: focus },
    });
  },
  read(state) {
    const block = paragraphBlock(state);
    return richText(block.charRuns, block.formats);
  },
  selection(state) {
    const selection = state.document.selection;
    if (selection) {
      return {
        anchor: selection.anchor.textIndex,
        focus: selection.focus.textIndex,
      };
    }
    const cursor = state.document.cursor;
    if (!cursor) return null;
    return {
      anchor: cursor.position.textIndex,
      focus: cursor.position.textIndex,
    };
  },
};

// ─── Table cell ──────────────────────────────────────────────────────────────

/**
 * The fixture table. The surface is the first body cell; its three neighbours
 * hold fixed text so a test can prove an edit never reaches past its cell.
 */
export function tableSource(cellText: string): string {
  return [
    "| head A | head B |",
    "| --- | --- |",
    `| ${cellText} | side |`,
  ].join("\n");
}

export const NEIGHBOURS = { headA: "head A", headB: "head B", side: "side" };

export function tableDocument(state: EditorState) {
  const block = state.document.page.blocks.find((b) => !b.deleted);
  const document = block && getTableDocument(block);
  if (!block || !document) throw new Error("table surface lost its table");
  return { block, document };
}

/** Cell ids in row-major order. */
export function cellIds(state: EditorState): string[] {
  const { document } = tableDocument(state);
  return readTable(document).rows.flatMap((row) =>
    row.cells.flatMap((cell) => (cell ? [cell.id] : [])),
  );
}

/** Every cell's rich text, row-major. */
export function allCells(state: EditorState): RichText[] {
  const { document } = tableDocument(state);
  return cellIds(state).map((id) =>
    richText(
      document.nodes[id].textFields[CELL_TEXT_FIELD],
      document.nodes[id].markFields?.[CELL_TEXT_FIELD],
    ),
  );
}

/** A caret/selection inside the cell at row-major `cell`. */
export function selectInCell(
  state: EditorState,
  cell: number,
  anchor: number,
  focus: number,
  focusCell = cell,
): EditorState {
  const { block, document } = tableDocument(state);
  const ids = cellIds(state);
  const point = (index: number, offset: number) => ({
    kind: "text" as const,
    blockId: block.id,
    contentId: document.rootId,
    nodeId: ids[index],
    field: CELL_TEXT_FIELD,
    afterCharId: getCharIdAtVisiblePosition(
      [...document.nodes[ids[index]].textFields[CELL_TEXT_FIELD]],
      offset,
    ),
    affinity: "forward" as const,
  });
  return updateContentSelection(state, {
    anchor: point(cell, anchor),
    focus: point(focusCell, focus),
  });
}

const SURFACE_CELL = 2;

export const cellSurface: TextSurface = {
  name: "table cell",
  create: (text, peerId) => editorOf(tableSource(text), peerId),
  select: (state, anchor, focus) =>
    selectInCell(state, SURFACE_CELL, anchor, focus),
  read: (state) => allCells(state)[SURFACE_CELL],
  selection(state) {
    const selection = state.document.contentSelection;
    if (!selection) return null;
    const { document } = tableDocument(state);
    const id = cellIds(state)[SURFACE_CELL];
    const runs = [...document.nodes[id].textFields[CELL_TEXT_FIELD]];
    const offset = (point: typeof selection.anchor) => {
      if (point.kind !== "text" || point.nodeId !== id) return -1;
      return getVisibleOffsetAfterChar(runs, point.afterCharId) ?? -1;
    };
    return { anchor: offset(selection.anchor), focus: offset(selection.focus) };
  },
};

// ─── Replicas ────────────────────────────────────────────────────────────────

const PAGE_ID = "text-safety";

/**
 * A page as the sync layer sees it: the ops that import `source`, and a way to
 * open an editor on it as any peer or to rebuild it from any set of ops. Unlike
 * {@link editorOf}, every character here is backed by an op, so a replica built
 * from the log can be compared with the editor that wrote it.
 */
export function replicated(source: string) {
  const importer = createCRDTbinding(PAGE_ID, "importer");
  const importOps = blocksToOps(loadPage(source, schema.data).blocks, {
    pageId: PAGE_ID,
    peerId: importer.getPeerId(),
    nextId: importer.nextId,
    getClock: importer.getClock,
    schema: schema.data,
  });

  /** The page after `batches` arrive, in that order, on a fresh replica. */
  function replay(...batches: Operation[][]): Page {
    const engine = createSyncEngine(
      createCRDTbinding(PAGE_ID, "observer"),
      schema.data,
    );
    engine.loadOperations(importOps);
    for (const batch of batches) engine.apply(batch);
    return engine.getState();
  }

  /** An editor on the imported page, stamping ops as `peerId`. */
  function open(peerId: string): EditorState {
    const binding = createCRDTbinding(PAGE_ID, peerId);
    // A live replica has observed every op it loaded; without this its first
    // edit would sort before the import and land on a table that is not there.
    for (const op of importOps) binding.advanceClock(op.clock);
    const bus = createActionBus();
    registerTableInputActions(bus);
    const state = createInitialState(replay(), {
      schema: schema.data,
      nodes: createNodeRegistry(schema.nodes),
      marks: createMarkRegistry(schema.marks),
      crdtBinding: binding,
    });
    return { ...state, actionBus: bus };
  }

  return { importOps, replay, open };
}

/** The table document on a page, for whole-document comparison. */
export function tableOn(page: Page) {
  const block = page.blocks.find((b) => !b.deleted);
  return block && getTableDocument(block);
}

/** Plain text of a {@link RichText}. */
export function plain(text: RichText): string {
  return text.map(([chunk]) => chunk).join("");
}

/** A small seeded PRNG (mulberry32), so random tests replay exactly. */
export function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
