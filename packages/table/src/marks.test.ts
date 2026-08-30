/**
 * Inline formatting inside a cell: the toggle's route from the bus to a
 * `mark_set` edit, and what a marked cell serializes back to.
 */

import { registerTableInputActions } from "./input";
import { getTableDocument, readTable } from "./structured";
import { tableExtension } from "./table-extension";
import { createNodeRegistry, defineMark } from "@tasfer/editor";
import { createActionBus } from "@tasfer/editor/action-bus";
import { insertText } from "@tasfer/editor/actions/actions";
import {
  createMarkRegistry,
  Mark,
  type MarkStyle,
  TOGGLE_EMPHASIS,
  TOGGLE_MARK,
  TOGGLE_STRONG,
} from "@tasfer/editor/rendering/marks";
import { baseSchema } from "@tasfer/editor/schema";
import { loadPage } from "@tasfer/editor/serlization/loadPage";
import { serializeToMarkdown } from "@tasfer/editor/serlization/serializer";
import type { EditorState } from "@tasfer/editor/state-types";
import { createInitialState } from "@tasfer/editor/state-utils";
import { updateContentSelection } from "@tasfer/editor/structured-selection";
import { applyOps } from "@tasfer/editor/sync/reducer";
import { describe, expect, it } from "vitest";

const schema = baseSchema.use(tableExtension());
const TABLE = ["| A | B |", "| --- | --- |", "| one | two |"].join("\n");

/**
 * A stand-in for inline math: togglable (so the toggle reaches the structured
 * check rather than stopping before it), and structured — its content would
 * live in an attachment rather than in the characters the mark covers.
 * Declared here rather than importing `@tasfer/math`, so what is under test is
 * "any structured mark", not the one feature that happens to ship one.
 */
class ChipMark extends Mark {
  readonly type = "chip";
  style(): MarkStyle {
    return {};
  }
}
const structuredSchema = baseSchema
  .extend({
    marks: [defineMark("chip", { structured: {}, render: new ChipMark() })],
  })
  .use(tableExtension());

function stateOf(source = TABLE, use = schema): EditorState {
  const bus = createActionBus();
  registerTableInputActions(bus);
  const state = createInitialState(loadPage(source, use.data), {
    schema: use.data,
    nodes: createNodeRegistry(use.nodes),
    // The default registry carries only the built-in marks, so a schema-level
    // mark has to be registered here too or the toggle stops on `togglable`
    // before it ever reaches the structured check.
    marks: createMarkRegistry(use.marks),
  });
  return { ...state, actionBus: bus };
}

/** Cell ids in row-major order. */
function cells(state: EditorState): string[] {
  const document = getTableDocument(state.document.page.blocks[0])!;
  return readTable(document).rows.flatMap((row) =>
    row.cells.filter((cell) => cell !== undefined).map((cell) => cell.id),
  );
}

/** Select from (cell, offset) to (cell, offset), by row-major cell index. */
function select(
  state: EditorState,
  anchorCell: number,
  anchorOffset: number,
  focusCell: number,
  focusOffset: number,
): EditorState {
  const block = state.document.page.blocks[0];
  const document = getTableDocument(block)!;
  const ids = cells(state);
  const point = (cellIndex: number, offset: number) => {
    const runs = [...document.nodes[ids[cellIndex]].textFields.text];
    let seen = 0;
    let afterCharId: string | null = null;
    for (const run of runs) {
      for (let index = 0; index < run.text.length; index++) {
        if (seen === offset) break;
        seen++;
        afterCharId = `${run.peerId}:${run.startCounter + index}`;
      }
    }
    return {
      kind: "text" as const,
      blockId: block.id,
      contentId: document.rootId,
      nodeId: ids[cellIndex],
      field: "text",
      afterCharId: offset === 0 ? null : afterCharId,
      affinity: "forward" as const,
    };
  };
  return updateContentSelection(state, {
    anchor: point(anchorCell, anchorOffset),
    focus: point(focusCell, focusOffset),
  });
}

function markdown(state: EditorState): string {
  return serializeToMarkdown(state.document.page.blocks, undefined, {
    schema: schema.data,
  });
}

describe("formatting a cell", () => {
  it("bolds a selected range inside a cell", () => {
    const state = select(stateOf(), 2, 0, 2, 3); // "one"
    const result = state.actionBus.dispatchState(TOGGLE_STRONG, state);

    expect(markdown(result.state)).toContain("| **one** | two |");
  });

  it("clears the mark when the whole range already carries it", () => {
    let state = select(stateOf(), 2, 0, 2, 3);
    state = state.actionBus.dispatchState(TOGGLE_STRONG, state).state;
    state = select(state, 2, 0, 2, 3);
    state = state.actionBus.dispatchState(TOGGLE_STRONG, state).state;

    expect(markdown(state)).toContain("| one | two |");
  });

  it("marks the rest when only part of the range carries it", () => {
    // Prose behaviour: a partly bold selection bolds the remainder rather than
    // clearing what is already bold.
    let state = select(stateOf(), 2, 0, 2, 1); // "o"
    state = state.actionBus.dispatchState(TOGGLE_STRONG, state).state;
    state = select(state, 2, 0, 2, 3); // "one"
    state = state.actionBus.dispatchState(TOGGLE_STRONG, state).state;

    expect(markdown(state)).toContain("| **one** | two |");
  });

  it("marks every covered cell whole across a multi-cell range", () => {
    const state = select(stateOf(), 2, 1, 3, 1);
    const result = state.actionBus.dispatchState(TOGGLE_STRONG, state);

    expect(markdown(result.state)).toContain("| **one** | **two** |");
  });

  it("emits operations a second peer replays to the same marks", () => {
    const state = select(stateOf(), 2, 0, 2, 3);
    const result = state.actionBus.dispatchState(TOGGLE_STRONG, state);

    const peer = applyOps(
      loadPage(TABLE, schema.data),
      result.ops,
      schema.data,
    );
    expect(
      serializeToMarkdown(peer.blocks, undefined, { schema: schema.data }),
    ).toContain("| **one** | two |");
  });

  it("leaves the toggle alone when the caret is outside a table", () => {
    const state = stateOf();
    const result = state.actionBus.dispatchState(TOGGLE_MARK, state, {
      name: "strong",
    });

    expect(result.ops).toEqual([]);
  });

  it("does not collapse the selection it formatted", () => {
    const state = select(stateOf(), 2, 0, 2, 3);
    const result = state.actionBus.dispatchState(TOGGLE_STRONG, state);

    const anchor = result.state.document.contentSelection?.anchor;
    const focus = result.state.document.contentSelection?.focus;
    expect(anchor?.kind).toBe("text");
    expect(focus?.kind).toBe("text");
    if (anchor?.kind !== "text" || focus?.kind !== "text") return;
    expect(anchor.nodeId).toBe(focus.nodeId);
    expect(anchor.afterCharId).not.toBe(focus.afterCharId);
  });
});

describe("a mark toggled at a collapsed caret", () => {
  it("applies to the next characters typed", () => {
    let state = select(stateOf(), 2, 3, 2, 3); // end of "one"
    state = state.actionBus.dispatchState(TOGGLE_STRONG, state).state;
    state = insertText(state, "X").state;

    expect(markdown(state)).toContain("| one**X** | two |");
  });

  it("writes no operation on its own", () => {
    const state = select(stateOf(), 2, 3, 2, 3);
    const result = state.actionBus.dispatchState(TOGGLE_STRONG, state);

    expect(result.ops).toEqual([]);
    expect(result.state.ui.activeMarksMode).toEqual({
      type: "explicit",
      formats: [{ type: "strong" }],
    });
  });

  it("turns the pending mark back off when toggled twice", () => {
    let state = select(stateOf(), 2, 3, 2, 3);
    state = state.actionBus.dispatchState(TOGGLE_STRONG, state).state;
    state = state.actionBus.dispatchState(TOGGLE_STRONG, state).state;
    state = insertText(state, "X").state;

    expect(markdown(state)).toContain("| oneX | two |");
  });

  it("carries more than one pending mark onto the typed text", () => {
    let state = select(stateOf(), 2, 3, 2, 3);
    state = state.actionBus.dispatchState(TOGGLE_STRONG, state).state;
    state = state.actionBus.dispatchState(TOGGLE_EMPHASIS, state).state;
    state = insertText(state, "X").state;

    // Bold + italic together is Markdown's triple marker.
    expect(markdown(state)).toContain("| one***X*** | two |");
  });
});

describe("marks a cell cannot carry", () => {
  it("refuses a structured mark, whose content is not in the characters", () => {
    const state = select(stateOf(TABLE, structuredSchema), 2, 0, 2, 3);
    const result = state.actionBus.dispatchState(TOGGLE_MARK, state, {
      name: "chip",
    });

    // Nothing written, and nothing pending either: a bare `mark_set` would
    // leave a mark with no attachment behind it, which serializes to syntax
    // that reloads as literal text.
    expect(result.ops).toEqual([]);
    expect(
      getTableDocument(result.state.document.page.blocks[0])!.nodes[
        cells(result.state)[2]
      ].markFields ?? null,
    ).toBeNull();
  });

  it("refuses it at a collapsed caret too, rather than arming it as pending", () => {
    const state = select(stateOf(TABLE, structuredSchema), 2, 3, 2, 3);
    const result = state.actionBus.dispatchState(TOGGLE_MARK, state, {
      name: "chip",
    });

    expect(result.state.ui.activeMarksMode).toEqual(state.ui.activeMarksMode);
  });

  it("still applies a plain mark in the same schema", () => {
    // The control: the refusal above is the structured check, not a harness
    // that cannot toggle anything at all.
    const state = select(stateOf(TABLE, structuredSchema), 2, 0, 2, 3);
    const result = state.actionBus.dispatchState(TOGGLE_STRONG, state);

    expect(result.ops).toHaveLength(1);
  });
});
