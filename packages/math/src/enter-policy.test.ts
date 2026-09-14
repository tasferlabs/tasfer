/**
 * The Enter / Shift+Enter policy table in `dev-docs/enter-key.md`, for the
 * blocks this package can assemble: prose (paragraph, heading, list, quote) and
 * the display equation. Code blocks and table cells are covered in their own
 * packages. Each case drives the action the key handler dispatches —
 * SPLIT_BLOCK for Enter, EXIT_BLOCK for Shift+Enter — over fabricated state.
 */
import { mathExtension } from "./math-extension";
import { getStructuredMathSource } from "./structured";
import { EXIT_BLOCK, SPLIT_BLOCK } from "@tasfer/editor/actions/edit-actions";
import { handleKeyDown } from "@tasfer/editor/events/keysEvents";
import { createMarkRegistry } from "@tasfer/editor/rendering/marks";
import { createNodeRegistry } from "@tasfer/editor/rendering/nodes";
import { baseSchema } from "@tasfer/editor/schema";
import { moveCursorToPosition, updateFocus } from "@tasfer/editor/selection";
import { loadPage } from "@tasfer/editor/serlization/loadPage";
import type { EditorState, ViewportState } from "@tasfer/editor/state-types";
import { createInitialState } from "@tasfer/editor/state-utils";
import { getVisibleTextFromRuns } from "@tasfer/editor/sync/char-runs";
import { describe, expect, it } from "vitest";

const schema = baseSchema.use(mathExtension());

function stateOf(markdown: string): EditorState {
  return createInitialState(loadPage(markdown, schema.data), {
    schema: schema.data,
    nodes: createNodeRegistry(schema.nodes),
    marks: createMarkRegistry(schema.marks),
  });
}

function caret(state: EditorState, blockIndex: number, textIndex: number) {
  return moveCursorToPosition(state, blockIndex, textIndex);
}

/** Live blocks as `type:"text"` (display math shows its LaTeX source). */
function blocks(state: EditorState): string[] {
  return state.document.page.blocks
    .filter((block) => !block.deleted)
    .map((block) => {
      const text =
        (block.type as string) === "math"
          ? (getStructuredMathSource(block) ?? "")
          : "charRuns" in block
            ? getVisibleTextFromRuns(block.charRuns)
            : "";
      return `${block.type}:${JSON.stringify(text)}`;
    });
}

function live(state: EditorState, blockIndex: number): number {
  const id = state.document.page.blocks[blockIndex]?.id;
  return state.document.page.blocks
    .filter((block) => !block.deleted)
    .findIndex((block) => block.id === id);
}

function enter(state: EditorState) {
  return state.actionBus.dispatchState(SPLIT_BLOCK, state);
}
function shiftEnter(state: EditorState) {
  return state.actionBus.dispatchState(EXIT_BLOCK, state);
}

describe("Enter over a selected text range", () => {
  it("deletes the range, then splits at the caret", () => {
    let state = caret(stateOf("hello world"), 0, 5);
    state = {
      ...state,
      document: {
        ...state.document,
        selection: {
          anchor: { blockIndex: 0, textIndex: 0 },
          focus: { blockIndex: 0, textIndex: 5 },
          isForward: true,
          isCollapsed: false,
          lastUpdate: 0,
        },
      },
    };

    const result = enter(state);

    expect(blocks(result.state)).toEqual([
      'paragraph:""',
      'paragraph:" world"',
    ]);
    expect(result.state.document.selection?.isCollapsed ?? true).toBe(true);
    expect(result.state.document.cursor?.position).toEqual({
      blockIndex: 1,
      textIndex: 0,
    });
  });
});

describe("Enter in prose blocks", () => {
  it("turns an empty heading into a paragraph in place", () => {
    const state = caret(stateOf("# Title\n\n## "), 1, 0);
    const before = blocks(state);
    expect(before[1]).toBe('heading2:""');

    const result = enter(state);

    expect(blocks(result.state)).toEqual([before[0], 'paragraph:""']);
    expect(
      live(result.state, result.state.document.cursor!.position.blockIndex),
    ).toBe(1);
  });

  it("keeps the heading split rules for non-empty headings", () => {
    expect(blocks(enter(caret(stateOf("# Title"), 0, 0)).state)).toEqual([
      'paragraph:""',
      'heading1:"Title"',
    ]);
    expect(blocks(enter(caret(stateOf("# Title"), 0, 2)).state)).toEqual([
      'heading1:"Ti"',
      'heading1:"tle"',
    ]);
    expect(blocks(enter(caret(stateOf("# Title"), 0, 5)).state)).toEqual([
      'heading1:"Title"',
      'paragraph:""',
    ]);
  });

  it("leaves a quote at its end and on an empty quote, splits it in the middle", () => {
    expect(blocks(enter(caret(stateOf("> abc"), 0, 3)).state)).toEqual([
      'quote:"abc"',
      'paragraph:""',
    ]);
    expect(blocks(enter(caret(stateOf("> abc"), 0, 1)).state)).toEqual([
      'quote:"a"',
      'quote:"bc"',
    ]);
  });

  it("Shift+Enter in prose is the ordinary split", () => {
    expect(blocks(shiftEnter(caret(stateOf("hello"), 0, 2)).state)).toEqual([
      'paragraph:"he"',
      'paragraph:"llo"',
    ]);
    expect(blocks(shiftEnter(caret(stateOf("- abc"), 0, 3)).state)).toEqual([
      'bullet_list:"abc"',
      'bullet_list:""',
    ]);
  });
});

describe("Shift+Enter key routing", () => {
  const viewport: ViewportState = {
    width: 800,
    height: 600,
    scrollY: 0,
    documentHeight: 2_000,
  };

  function key(shiftKey: boolean): Event {
    return {
      key: "Enter",
      code: "Enter",
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      shiftKey,
      repeat: false,
      isComposing: false,
      isTrusted: false,
      preventDefault() {},
      stopPropagation() {},
    } as unknown as Event;
  }

  it("dispatches EXIT_BLOCK with Shift held and SPLIT_BLOCK without", () => {
    const state = updateFocus(caret(stateOf("hello"), 0, 5), true);
    const seen: string[] = [];
    state.actionBus.registerState(SPLIT_BLOCK, () => void seen.push("split"));
    state.actionBus.registerState(EXIT_BLOCK, () => void seen.push("exit"));

    handleKeyDown(state, viewport, key(false));
    handleKeyDown(state, viewport, key(true));

    expect(seen).toEqual(["split", "exit"]);
  });
});
