/**
 * Markdown auto-format inside a cell, and taking it back.
 *
 * The shortcuts are opt-in, so both halves matter: that they fire when the host
 * asked for them, and that a table installed the old way still keeps `*` as `*`.
 */

import { registerTableInputActions } from "./input";
import { cellText, getTableDocument, readTable } from "./structured";
import { tableExtension } from "./table-extension";
import { createNodeRegistry } from "@tasfer/editor";
import { createActionBus } from "@tasfer/editor/action-bus";
import { insertText } from "@tasfer/editor/actions/actions";
import {
  DELETE_BACKWARD,
  REVERT_INPUT_RULE,
} from "@tasfer/editor/actions/edit-actions";
import { baseSchema } from "@tasfer/editor/schema";
import { loadPage } from "@tasfer/editor/serlization/loadPage";
import { serializeToMarkdown } from "@tasfer/editor/serlization/serializer";
import type { EditorState, Operation } from "@tasfer/editor/state-types";
import { createInitialState } from "@tasfer/editor/state-utils";
import { updateContentSelection } from "@tasfer/editor/structured-selection";
import { applyOps } from "@tasfer/editor/sync/reducer";
import { describe, expect, it } from "vitest";

const shortcuts = baseSchema.use(tableExtension({ markdownShortcuts: true }));
const literal = baseSchema.use(tableExtension());

const TABLE = ["| A | B |", "| --- | --- |", "| one | two |"].join("\n");

function stateOf(schema: typeof shortcuts): EditorState {
  const bus = createActionBus();
  registerTableInputActions(bus);
  const state = createInitialState(loadPage(TABLE, schema.data), {
    schema: schema.data,
    nodes: createNodeRegistry(schema.nodes),
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

/** Put the caret at `offset` in the cell at row-major index `at`. */
function caretIn(state: EditorState, at: number, offset: number): EditorState {
  const block = state.document.page.blocks[0];
  const document = getTableDocument(block)!;
  const ids = cells(state);
  const runs = [...document.nodes[ids[at]].textFields.text];
  let seen = 0;
  let afterCharId: string | null = null;
  for (const run of runs) {
    for (let index = 0; index < run.text.length; index++) {
      if (seen === offset) break;
      seen++;
      afterCharId = `${run.peerId}:${run.startCounter + index}`;
    }
  }
  const point = {
    kind: "text" as const,
    blockId: block.id,
    contentId: document.rootId,
    nodeId: ids[at],
    field: "text",
    afterCharId: offset === 0 ? null : afterCharId,
    affinity: "forward" as const,
  };
  return updateContentSelection(state, { anchor: point, focus: point });
}

/**
 * Type `text` one character at a time.
 *
 * The rule fires on the keystroke that closes a delimiter, exactly as the
 * engine's flat path does, so a wrap only appears when it was actually typed —
 * pasting `**x**` into a cell leaves the syntax alone.
 */
function type(
  state: EditorState,
  text: string,
): { state: EditorState; ops: Operation[] } {
  const ops: Operation[] = [];
  for (const char of text) {
    const result = insertText(state, char);
    state = result.state;
    ops.push(...result.ops);
  }
  return { state, ops };
}

/** Every cell's text, row by row. */
function grid(state: EditorState): string[][] {
  const document = getTableDocument(state.document.page.blocks[0])!;
  return readTable(document).rows.map((row) =>
    row.cells.map((cell) => (cell ? cellText(document, cell) : "")),
  );
}

/** The page as GFM — the only view that shows a cell's marks. */
function markdown(state: EditorState, schema: typeof shortcuts): string {
  return serializeToMarkdown(state.document.page.blocks, undefined, {
    schema: schema.data,
  });
}

/** Type into the empty-ish second row's first cell, replacing "one". */
function typeInCell(text: string, schema = shortcuts) {
  const state = caretIn(stateOf(schema), 2, 3); // end of "one"
  return type(state, text);
}

describe("markdown shortcuts in a cell", () => {
  it("wraps the text and drops the delimiters", () => {
    const { state } = typeInCell("**bold**");

    expect(grid(state)[1][0]).toBe("onebold");
    expect(markdown(state, shortcuts)).toBe(
      ["| A | B |", "| --- | --- |", "| one**bold** | two |"].join("\n"),
    );
  });

  it("recognizes every shortcut the engine does", () => {
    for (const [typed, printed] of [
      ["*it*", "*it*"],
      ["~~no~~", "~~no~~"],
      ["`fn`", "`fn`"],
    ]) {
      const state = caretIn(stateOf(shortcuts), 0, 1); // end of "A"
      expect(markdown(type(state, typed).state, shortcuts)).toBe(
        [`| A${printed} | B |`, "| --- | --- |", "| one | two |"].join("\n"),
      );
    }
  });

  it("leaves the caret after the text it wrapped", () => {
    const wrapped = typeInCell("**bold**").state;
    // Typing on continues outside the mark's run, not inside the eaten syntax.
    expect(grid(type(wrapped, "!").state)[1][0]).toBe("onebold!");
  });

  it("carries the wrap in the operations it emits", () => {
    const { state, ops } = typeInCell("**bold**");
    const replayed = applyOps(
      loadPage(TABLE, shortcuts.data),
      ops,
      shortcuts.data,
    );

    expect(getTableDocument(replayed.blocks[0])).toEqual(
      getTableDocument(state.document.page.blocks[0]),
    );
  });

  it("keeps the syntax literal when the host did not ask for shortcuts", () => {
    const { state } = typeInCell("**bold**", literal);

    expect(grid(state)[1][0]).toBe("one**bold**");
  });

  it("does not fire on a delimiter that closes nothing", () => {
    expect(grid(typeInCell("*").state)[1][0]).toBe("one*");
    expect(grid(typeInCell("**").state)[1][0]).toBe("one**");
  });

  it("never touches a cell the caret is not in", () => {
    expect(grid(typeInCell("`x`").state)[1][1]).toBe("two");
  });
});

describe("taking a cell's auto-format back", () => {
  it("restores the literal syntax on the Backspace right after", () => {
    const wrapped = typeInCell("**bold**").state;
    const reverted = wrapped.actionBus.dispatchState(
      REVERT_INPUT_RULE,
      wrapped,
    );

    expect(grid(reverted.state)[1][0]).toBe("one**bold**");
    // The text is literal again, and carries no mark — the wrap is gone, not
    // just hidden. (`escapeCell` does not escape `*`, so what prints here is
    // the same syntax; that round-trip gap is the serializer's, not the
    // revert's.)
    expect(markdown(reverted.state, shortcuts)).toBe(
      ["| A | B |", "| --- | --- |", "| one**bold** | two |"].join("\n"),
    );
  });

  it("leaves the restored syntax alone instead of wrapping it again", () => {
    const wrapped = typeInCell("**bold**").state;
    const reverted = wrapped.actionBus.dispatchState(
      REVERT_INPUT_RULE,
      wrapped,
    ).state;

    // The caret sits after the restored closing `**`; deleting is once again
    // what Backspace means there.
    const deleted = reverted.actionBus.dispatchState(DELETE_BACKWARD, reverted);
    expect(grid(deleted.state)[1][0]).toBe("one**bold*");
  });

  it("emits nothing when no auto-format is armed", () => {
    const state = caretIn(stateOf(shortcuts), 2, 3);

    expect(state.actionBus.dispatchState(REVERT_INPUT_RULE, state).ops).toEqual(
      [],
    );
  });

  it("disarms once the caret leaves the spot the wrap left it", () => {
    const wrapped = typeInCell("**bold**").state;
    const moved = caretIn(wrapped, 3, 0); // into the next cell

    expect(moved.ui.revertibleInputRule).toBeNull();
    expect(moved.actionBus.dispatchState(REVERT_INPUT_RULE, moved).ops).toEqual(
      [],
    );
  });

  it("disarms after the next character is typed", () => {
    const typedOn = type(typeInCell("**bold**").state, "!").state;

    expect(typedOn.ui.revertibleInputRule).toBeNull();
  });

  it("carries the restoration in the operations it emits", () => {
    const { state, ops } = typeInCell("**bold**");
    const reverted = state.actionBus.dispatchState(REVERT_INPUT_RULE, state);
    const replayed = applyOps(
      loadPage(TABLE, shortcuts.data),
      [...ops, ...reverted.ops],
      shortcuts.data,
    );

    expect(getTableDocument(replayed.blocks[0])).toEqual(
      getTableDocument(reverted.state.document.page.blocks[0]),
    );
  });
});
