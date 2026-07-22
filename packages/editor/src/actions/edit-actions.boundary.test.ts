import type { Block, Page } from "../serlization/loadPage";
import type { EditorState } from "../state-types";
import { createInitialState } from "../state-utils";
import { DELETE_BACKWARD, JOIN_WITH_PREVIOUS_BLOCK } from "./edit-actions";
import { describe, expect, it, vi } from "vitest";

function paragraph(id: string, orderKey: string, text: string): Block {
  return {
    id,
    orderKey,
    type: "paragraph",
    charRuns: text
      ? [{ peerId: "seed", startCounter: id === "first" ? 1 : 100, text }]
      : [],
    formats: [],
  };
}

function boundaryState(): EditorState {
  const page: Page = {
    id: "page-1",
    title: "",
    blocks: [paragraph("first", "a0", "one"), paragraph("second", "a1", "two")],
  };
  const state = createInitialState(page);
  return {
    ...state,
    document: {
      ...state.document,
      cursor: {
        position: { blockIndex: 1, textIndex: 0 },
        lastUpdate: 0,
      },
    },
  };
}

describe("DELETE_BACKWARD block-boundary extensibility", () => {
  it("lets a handler claim the join before the default merge", () => {
    const state = boundaryState();
    const handler = vi.fn(() => ({
      state,
      ops: [],
      handled: true as const,
    }));
    state.actionBus.registerState(JOIN_WITH_PREVIOUS_BLOCK, handler, 100);

    const result = state.actionBus.dispatchState(DELETE_BACKWARD, state);

    expect(handler).toHaveBeenCalledWith(state, {
      currentBlockId: "second",
      currentBlockIndex: 1,
      previousBlockId: "first",
      previousBlockIndex: 0,
    });
    expect(
      result.state.document.page.blocks.filter((block) => !block.deleted),
    ).toHaveLength(2);
  });

  it("uses the normal merge when no handler claims the join", () => {
    const state = boundaryState();
    const result = state.actionBus.dispatchState(DELETE_BACKWARD, state);

    expect(
      result.state.document.page.blocks.filter((block) => !block.deleted),
    ).toHaveLength(1);
    expect(result.state.document.cursor?.position).toEqual({
      blockIndex: 0,
      textIndex: 3,
    });
  });

  it("ignores a stale directly-dispatched boundary", () => {
    const state = boundaryState();
    const result = state.actionBus.dispatchState(
      JOIN_WITH_PREVIOUS_BLOCK,
      state,
      {
        currentBlockId: "stale",
        currentBlockIndex: 1,
        previousBlockId: "first",
        previousBlockIndex: 0,
      },
    );

    expect(result.state).toBe(state);
    expect(result.ops).toEqual([]);
  });
});
