/**
 * What a cell edit puts on the wire, and whether every peer ends up with it.
 *
 * Tasfer is peer-to-peer, so a peer on an older build will receive the ops a
 * newer build writes. The shape of those ops is therefore a contract: moving
 * cells onto shared text code must not change it. The first block pins that
 * shape; the rest prove that the ops alone rebuild the author's document and
 * that concurrent edits in a cell converge without dropping anyone's text.
 */

import {
  allCells,
  cellIds,
  plain,
  replicated,
  selectInCell,
  tableOn,
  tableSource,
} from "./harness";
import { insertText } from "@tasfer/editor/actions/actions";
import {
  DELETE_BACKWARD,
  DELETE_WORD_BACKWARD,
} from "@tasfer/editor/actions/edit-actions";
import {
  COMPOSITION_END,
  COMPOSITION_START,
} from "@tasfer/editor/actions/input-actions";
import { TOGGLE_STRONG } from "@tasfer/editor/rendering/marks";
import type { EditorState } from "@tasfer/editor/state-types";
import type { Operation } from "@tasfer/editor/sync/sync";
import { describe, expect, it } from "vitest";

const CELL = 2;

describe("the ops a cell edit writes", () => {
  const page = replicated(tableSource("one two"));

  /** The keys of an op and of its edit, so a renamed or added field shows. */
  function shape(op: Operation) {
    expect(op.op).toBe("content_edit");
    const edit = (op as Extract<Operation, { op: "content_edit" }>).edit;
    return {
      op: Object.keys(op).sort(),
      edit: Object.keys(edit).sort(),
      kind: edit.kind,
    };
  }

  it("typing writes one text_insert", () => {
    const state = selectInCell(page.open("a"), CELL, 3, 3);
    const { ops } = insertText(state, "X");

    expect(ops.map(shape)).toEqual([
      {
        op: ["blockId", "clock", "contentId", "edit", "id", "op", "pageId"],
        edit: ["afterCharId", "charRuns", "field", "kind", "nodeId"],
        kind: "text_insert",
      },
    ]);
  });

  it("deleting writes one text_delete", () => {
    const state = selectInCell(page.open("a"), CELL, 3, 3);
    const { ops } = state.actionBus.dispatchState(DELETE_BACKWARD, state);

    expect(ops.map(shape)).toEqual([
      {
        op: ["blockId", "clock", "contentId", "edit", "id", "op", "pageId"],
        edit: ["charIds", "field", "kind", "nodeId"],
        kind: "text_delete",
      },
    ]);
  });

  it("replacing a selection writes a delete, then an insert", () => {
    const state = selectInCell(page.open("a"), CELL, 0, 3);
    const { ops } = insertText(state, "X");

    expect(ops.map((op) => shape(op).kind)).toEqual([
      "text_delete",
      "text_insert",
    ]);
  });

  it("formatting writes one mark_set", () => {
    const state = selectInCell(page.open("a"), CELL, 0, 3);
    const { ops } = state.actionBus.dispatchState(TOGGLE_STRONG, state);

    expect(ops.map(shape)).toEqual([
      {
        op: ["blockId", "clock", "contentId", "edit", "id", "op", "pageId"],
        edit: ["charIds", "field", "kind", "mark", "nodeId", "value"],
        kind: "mark_set",
      },
    ]);
  });

  it("an IME session writes nothing until it commits", () => {
    let state = selectInCell(page.open("a"), CELL, 3, 3);
    const start = state.actionBus.dispatchState(COMPOSITION_START, state, {
      data: "ك",
    });
    expect(start.ops).toEqual([]);
    state = start.state;

    const end = state.actionBus.dispatchState(COMPOSITION_END, state, {
      data: "كتب",
    });
    expect(end.ops.map((op) => shape(op).kind)).toEqual(["text_insert"]);
  });

  it("addresses characters by id, never by offset", () => {
    const state = selectInCell(page.open("a"), CELL, 3, 3);
    const [op] = insertText(state, "X").ops as Extract<
      Operation,
      { op: "content_edit" }
    >[];
    const edit = op.edit as { afterCharId: string; nodeId: string };

    expect(edit.nodeId).toBe(cellIds(state)[CELL]);
    expect(edit.afterCharId).toMatch(/:\d+$/);
  });
});

describe("the ops alone rebuild the author's document", () => {
  it("after a long mixed session", () => {
    const page = replicated(tableSource("one two three"));
    let state = page.open("author");
    const sent: Operation[] = [];
    const steps: ((s: EditorState) => {
      state: EditorState;
      ops: Operation[];
    })[] = [
      (s) => insertText(selectInCell(s, CELL, 3, 3), " مرحبا"),
      (s) => {
        const at = selectInCell(s, CELL, 0, 3);
        return at.actionBus.dispatchState(TOGGLE_STRONG, at);
      },
      (s) => insertText(selectInCell(s, CELL, 1, 1), "👨‍👩‍👧"),
      (s) => {
        const at = selectInCell(s, CELL, 5, 5);
        return at.actionBus.dispatchState(DELETE_BACKWARD, at);
      },
      (s) => insertText(selectInCell(s, CELL, 2, 9), "é"),
      (s) => {
        const at = selectInCell(s, CELL, 8, 8);
        return at.actionBus.dispatchState(DELETE_WORD_BACKWARD, at);
      },
      (s) => insertText(selectInCell(s, 3, 0, 0), "side "),
    ];

    for (const step of steps) {
      const result = step(state);
      state = result.state;
      sent.push(...result.ops);
      // A peer holds only what was sent. Anything the author's document has
      // that the ops do not carry is text the peer will never see.
      expect(tableOn(page.replay(sent))).toEqual(tableOn(state.document.page));
    }
  });
});

describe("concurrent edits in one cell", () => {
  /**
   * Two peers edit from the same starting page without seeing each other, then
   * exchange ops. Both arrival orders must produce the same document.
   */
  function concurrently(
    source: string,
    first: (s: EditorState) => { state: EditorState; ops: Operation[] },
    second: (s: EditorState) => { state: EditorState; ops: Operation[] },
  ) {
    const page = replicated(source);
    const a = first(page.open("peer-a"));
    const b = second(page.open("peer-b"));
    const oneWay = page.replay(a.ops, b.ops);
    const otherWay = page.replay(b.ops, a.ops);

    expect(tableOn(oneWay)).toEqual(tableOn(otherWay));
    // Read the merged cells through an editor so marks resolve as they render.
    const merged = {
      ...a.state,
      document: { ...a.state.document, page: oneWay },
    };
    return allCells(merged as EditorState);
  }

  it("both type at the same caret: both strings survive, whole", () => {
    const cells = concurrently(
      tableSource("one"),
      (s) => insertText(selectInCell(s, CELL, 3, 3), "AAA"),
      (s) => insertText(selectInCell(s, CELL, 3, 3), "BBB"),
    );
    expect(["oneAAABBB", "oneBBBAAA"]).toContain(plain(cells[CELL]));
  });

  it("one deletes a range while the other types inside it", () => {
    const cells = concurrently(
      tableSource("one two three"),
      (s) => {
        const at = selectInCell(s, CELL, 4, 7);
        return at.actionBus.dispatchState(DELETE_BACKWARD, at);
      },
      (s) => insertText(selectInCell(s, CELL, 5, 5), "NEW"),
    );
    // The deleter never saw "NEW", so it must not be deleted with the range.
    expect(plain(cells[CELL])).toBe("one NEW three");
  });

  it("one bolds a range while the other types inside it", () => {
    const cells = concurrently(
      tableSource("one two three"),
      (s) => {
        const at = selectInCell(s, CELL, 4, 7);
        return at.actionBus.dispatchState(TOGGLE_STRONG, at);
      },
      (s) => insertText(selectInCell(s, CELL, 5, 5), "NEW"),
    );
    expect(plain(cells[CELL])).toBe("one tNEWwo three");
    // Every character the bolder selected stays bold.
    const bold = cells[CELL].filter(([, marks]) => marks.includes("strong"))
      .map(([chunk]) => chunk)
      .join("");
    expect(bold.replace("NEW", "")).toBe("two");
  });

  it("both delete overlapping ranges: nothing outside either range goes", () => {
    const cells = concurrently(
      tableSource("one two three"),
      (s) => {
        const at = selectInCell(s, CELL, 2, 6);
        return at.actionBus.dispatchState(DELETE_BACKWARD, at);
      },
      (s) => {
        const at = selectInCell(s, CELL, 5, 9);
        return at.actionBus.dispatchState(DELETE_BACKWARD, at);
      },
    );
    expect(plain(cells[CELL])).toBe("onhree");
  });

  it("edits in different cells never touch each other", () => {
    const cells = concurrently(
      tableSource("one"),
      (s) => insertText(selectInCell(s, CELL, 3, 3), "!"),
      (s) => insertText(selectInCell(s, 3, 0, 0), "?"),
    );
    expect(cells.map(plain)).toEqual(["head A", "head B", "one!", "?side"]);
  });
});
