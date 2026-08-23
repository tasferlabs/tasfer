/**
 * Undoing a block type morph puts the block back the way it was — including
 * the state that belongs to the type, not just the type name.
 *
 * `block_set type` rebuilds the block from the target type's defaults, so the
 * inverse has to carry back whatever that reset: a list item's `indent`, a
 * todo's `checked`, the block's own style. Restoring the type alone returned an
 * indented bullet at level 0 and a ticked todo unticked — the change looked
 * undone until you noticed the list had flattened.
 *
 * The forward half is pinned here too: fields BOTH types declare survive the
 * morph, so switching bullet → numbered (or re-applying the type an item
 * already has) keeps the item where the user put it.
 */

import { baseSchema } from "../schema";
import type { Block, Page } from "../serlization/loadPage";
import type { CursorState, EditorState, Operation } from "../state-types";
import { createInitialState } from "../state-utils";
import { recordUndoOps, redoState, undoState } from "../sync/crdt-undo";
import {
  convertBlockAtCursor,
  indentListItem,
  insertText,
  toggleTodoChecked,
} from "./actions";
import { describe, expect, it } from "vitest";

function paragraph(text: string): Block {
  return {
    id: "p-1",
    orderKey: "a0",
    deleted: false,
    type: "paragraph",
    charRuns: text ? [{ peerId: "peer", startCounter: 0, text }] : [],
    formats: [],
  } as unknown as Block;
}

function cursorAt(blockIndex: number, textIndex: number): CursorState {
  return { position: { blockIndex, textIndex }, lastUpdate: 0 };
}

function stateWith(page: Page, cursor: CursorState): EditorState {
  const base = createInitialState(page, { schema: baseSchema.data });
  return { ...base, document: { ...base.document, cursor } };
}

/** Run an action and record it to the undo stack, as `executeAction` does. */
function act(
  state: EditorState,
  action: (s: EditorState) => { state: EditorState; ops: Operation[] },
): EditorState {
  const result = action(state);
  if (result.ops.length === 0) return result.state;
  return recordUndoOps(
    state,
    result.state,
    result.ops,
    state.CRDTbinding.getPeerId(),
  );
}

function type(state: EditorState, input: string): EditorState {
  let s = state;
  for (const ch of input) s = act(s, (st) => insertText(st, ch));
  return s;
}

function convert(state: EditorState, to: string): EditorState {
  return act(state, (s) =>
    convertBlockAtCursor(s, { type: to as Block["type"] }),
  );
}

function block(s: EditorState): Block & Record<string, unknown> {
  return s.document.page.blocks[0] as Block & Record<string, unknown>;
}

/** A bullet item at `indent`, built the way a user builds one. */
function bulletAt(indent: number): EditorState {
  let s = type(
    stateWith(
      { id: "page-1", title: "t", blocks: [paragraph("")] },
      cursorAt(0, 0),
    ),
    "- hi",
  );
  for (let i = 0; i < indent; i++) s = act(s, indentListItem);
  expect(block(s).indent).toBe(indent);
  return s;
}

describe("undoing a morph away from a list", () => {
  it("restores the item's indent level", () => {
    const indented = bulletAt(2);
    const flattened = convert(indented, "paragraph");
    expect(block(flattened).type).toBe("paragraph");

    const undone = undoState(flattened).state;
    expect(block(undone).type).toBe("bullet_list");
    expect(block(undone).indent).toBe(2);
  });

  it("restores indent through a non-list target too", () => {
    const heading = convert(bulletAt(3), "heading1");
    expect(block(heading).type).toBe("heading1");

    const undone = undoState(heading).state;
    expect(block(undone).type).toBe("bullet_list");
    expect(block(undone).indent).toBe(3);
  });

  it("restores a todo's checked state", () => {
    let s = type(
      stateWith(
        { id: "page-1", title: "t", blocks: [paragraph("- [ ]")] },
        cursorAt(0, 5),
      ),
      " task",
    );
    s = act(s, (st) => toggleTodoChecked(st, 0));
    expect(block(s).type).toBe("todo_list");
    expect(block(s).checked).toBe(true);

    const undone = undoState(convert(s, "paragraph")).state;
    expect(block(undone).type).toBe("todo_list");
    expect(block(undone).checked).toBe(true);
  });

  it("restores the block's own style", () => {
    const styled = bulletAt(1);
    const withStyle: EditorState = {
      ...styled,
      document: {
        ...styled.document,
        page: {
          ...styled.document.page,
          blocks: [{ ...block(styled), style: { fontSize: 24 } } as Block],
        },
      },
    };

    const undone = undoState(convert(withStyle, "paragraph")).state;
    expect(block(undone).style).toEqual({ fontSize: 24 });
  });

  it("redo re-applies the morph", () => {
    const flattened = convert(bulletAt(2), "paragraph");
    const undone = undoState(flattened).state;
    const redone = redoState(undone).state;
    expect(block(redone).type).toBe("paragraph");
  });

  it("round-trips indent through undo → redo → undo", () => {
    const flattened = convert(bulletAt(2), "paragraph");
    const again = undoState(redoState(undoState(flattened).state).state).state;
    expect(block(again).type).toBe("bullet_list");
    expect(block(again).indent).toBe(2);
  });
});

describe("morphing between types that share a field", () => {
  it("keeps the indent when switching list type", () => {
    const numbered = convert(bulletAt(2), "numbered_list");
    expect(block(numbered).type).toBe("numbered_list");
    expect(block(numbered).indent).toBe(2);
  });

  it("keeps the indent when re-applying the type it already has", () => {
    const same = convert(bulletAt(2), "bullet_list");
    expect(block(same).indent).toBe(2);
  });

  it("leaves a field only the target declares at its default", () => {
    const todo = convert(bulletAt(2), "todo_list");
    expect(block(todo).indent).toBe(2);
    expect(block(todo).checked).toBe(false);
  });

  it("undo still returns the source type and its indent", () => {
    const numbered = convert(bulletAt(2), "numbered_list");
    const undone = undoState(numbered).state;
    expect(block(undone).type).toBe("bullet_list");
    expect(block(undone).indent).toBe(2);
  });
});
