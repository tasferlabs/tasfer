/**
 * Shift+key extends from where the caret IS, not from a collapsed selection
 * the caret has since left.
 *
 * Walking a Shift range back onto its anchor leaves a collapsed selection
 * behind, and typing moves the caret without touching it. Extending from that
 * leftover selected the text just typed — from a spot the user had already
 * left — instead of starting at the caret.
 */

import { baseSchema } from "../schema";
import type { Block, Page } from "../serlization/loadPage";
import type { EditorState } from "../state-types";
import { createInitialState } from "../state-utils";
import { insertText } from "./actions";
import {
  EXTEND_SELECTION_LEFT,
  EXTEND_SELECTION_RIGHT,
  EXTEND_SELECTION_WORD_RIGHT,
} from "./keyboard-actions";
import { describe, expect, it } from "vitest";

function paragraph(text: string): EditorState {
  const block = {
    id: "p-1",
    orderKey: "a0",
    deleted: false,
    type: "paragraph",
    charRuns: [{ peerId: "peer", startCounter: 0, text }],
    formats: [],
  } as unknown as Block;
  const page: Page = { id: "page-1", title: "t", blocks: [block] };
  const base = createInitialState(page, { schema: baseSchema.data });
  return {
    ...base,
    document: {
      ...base.document,
      cursor: { position: { blockIndex: 0, textIndex: 2 }, lastUpdate: 0 },
    },
  };
}

function press(state: EditorState, action: typeof EXTEND_SELECTION_LEFT) {
  return state.actionBus.dispatchState(action, state).state;
}

describe("Shift+key after the caret left a collapsed selection", () => {
  it("starts the new range at the caret", () => {
    let state = paragraph("one two");
    state = press(state, EXTEND_SELECTION_RIGHT);
    state = press(state, EXTEND_SELECTION_LEFT);
    // The range is back on its anchor: a collapsed selection at 2.
    expect(state.document.selection?.isCollapsed).toBe(true);
    state = insertText(state, "ab").state;
    expect(state.document.cursor?.position.textIndex).toBe(4);

    state = press(state, EXTEND_SELECTION_RIGHT);
    expect(state.document.selection).toMatchObject({
      anchor: { blockIndex: 0, textIndex: 4 },
      focus: { blockIndex: 0, textIndex: 5 },
    });
  });

  it("a word extension too", () => {
    let state = paragraph("one two three");
    state = press(state, EXTEND_SELECTION_RIGHT);
    state = press(state, EXTEND_SELECTION_LEFT);
    state = insertText(state, "X").state;
    state = press(state, EXTEND_SELECTION_WORD_RIGHT);
    expect(state.document.selection?.anchor).toEqual({
      blockIndex: 0,
      textIndex: 3,
    });
  });

  it("a collapsed selection still at the caret keeps extending from there", () => {
    let state = paragraph("one two");
    state = press(state, EXTEND_SELECTION_RIGHT);
    state = press(state, EXTEND_SELECTION_LEFT);
    state = press(state, EXTEND_SELECTION_LEFT);
    expect(state.document.selection).toMatchObject({
      anchor: { blockIndex: 0, textIndex: 2 },
      focus: { blockIndex: 0, textIndex: 1 },
    });
  });
});
