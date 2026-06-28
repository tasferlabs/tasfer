/**
 * Pins `atomicBlockInsertOps` — the descriptor-driven replacement for the old
 * per-type `createImageBlockOps` / `createLineBlockOps` / `createMathBlockOps`
 * paste closures. Asserts it emits exactly the block_insert + block_set ops the
 * hand-written versions did, so the generic field-driven path can't silently
 * drift from per-type behavior.
 */

import { moveCursorToPosition } from "../selection";
import type { Block } from "../serlization/loadPage";
import { loadPage } from "../serlization/loadPage";
import type { BlockSet } from "../state-types";
import { createInitialState } from "../state-utils";
import { getVisibleTextFromRuns } from "../sync/char-runs";
import { applyOps, getVisibleBlocks } from "../sync/reducer";
import { createCRDTbinding } from "../sync/sync";
import {
  atomicBlockInsertOps,
  getSelectionPlainText,
  pasteFromClipboardEvent,
} from "./clipboard";
import { describe, expect, it } from "vitest";

function setFields(block: Block): Record<string, unknown> {
  const binding = createCRDTbinding("page-1", "peer-a");
  const ops = atomicBlockInsertOps(block, "new-block", "after-block", binding);

  // First op is always the block_insert for the type.
  expect(ops[0]).toMatchObject({
    op: "block_insert",
    blockId: "new-block",
    orderKey: "after-block",
    blockType: block.type,
  });

  // The rest are block_sets; collapse to a field→value map for assertions.
  const fields: Record<string, unknown> = {};
  for (const op of ops.slice(1)) {
    expect(op.op).toBe("block_set");
    const set = op as BlockSet;
    expect(set.blockId).toBe("new-block");
    fields[set.field] = set.value;
  }
  return fields;
}

describe("atomicBlockInsertOps", () => {
  it("emits every set image property (url/alt/width/height/objectFit)", () => {
    const image = {
      id: "i1",
      orderKey: "a0",
      type: "image",
      url: "https://example.com/a.png",
      alt: "alt text",
      width: 200,
      height: 100,
      objectFit: "cover",
    } as unknown as Block;

    expect(setFields(image)).toEqual({
      url: "https://example.com/a.png",
      alt: "alt text",
      width: 200,
      height: 100,
      objectFit: "cover",
    });
  });

  it("omits unset image properties (only url present)", () => {
    const image = {
      id: "i2",
      orderKey: "a0",
      type: "image",
      url: "https://example.com/b.png",
    } as unknown as Block;

    // alt/width/height/objectFit are undefined → no block_set for them.
    expect(setFields(image)).toEqual({
      url: "https://example.com/b.png",
    });
  });

  // (Math is no longer atomic — it's a textual block whose char-run text IS the
  // LaTeX, so it copies through the textual char-run path, not
  // atomicBlockInsertOps.)

  it("emits only a block_insert for a line (no fields)", () => {
    const line = {
      id: "l1",
      orderKey: "a0",
      type: "line",
    } as unknown as Block;

    expect(setFields(line)).toEqual({});
  });
});

describe("multi-block paste — ordering & convergence", () => {
  const order = (p: { blocks: Block[] }) =>
    getVisibleBlocks(p as never).map((b) => b.id);

  it("local page matches replaying the emitted ops, with ascending keys", () => {
    const state = moveCursorToPosition(
      createInitialState(loadPage("Start\n")),
      0,
      5, // end of "Start"
    );
    const prevPage = state.document.page;

    const result = pasteFromClipboardEvent(state, {} as ClipboardEvent, {
      html: "<p>Alpha</p><p>Bravo</p><p>Charlie</p>",
      text: "",
      imageFile: null,
    });
    expect(result).not.toBeNull();

    // Convergence: a remote peer replaying the ops (or a rebuild from the log)
    // computes the SAME block order the local editor rendered — the historical
    // "pasted block teleported" bug class.
    const replayed = applyOps(prevPage, result!.ops);
    expect(order(result!.state.document.page)).toEqual(order(replayed));

    // More blocks than we started with, and every orderKey is strictly
    // ascending (no collisions that would scramble order).
    const blocks = getVisibleBlocks(result!.state.document.page);
    expect(blocks.length).toBeGreaterThan(1);
    const keys = blocks.map((b) => b.orderKey ?? "");
    for (let i = 1; i < keys.length; i++) {
      expect(keys[i - 1] < keys[i]).toBe(true);
    }
  });
});

describe("getSelectionPlainText", () => {
  // Select the whole document, mirroring how the engine extends a selection.
  function selectAll(markdown: string) {
    const page = loadPage(markdown);
    const state = createInitialState(page);
    const lastIndex = page.blocks.length - 1;
    const last = page.blocks[lastIndex];
    const lastLen =
      "charRuns" in last ? getVisibleTextFromRuns(last.charRuns).length : 0;
    return {
      ...state,
      document: {
        ...state.document,
        selection: {
          anchor: { blockIndex: 0, textIndex: 0 },
          focus: { blockIndex: lastIndex, textIndex: lastLen },
          isForward: true,
          isCollapsed: false,
        },
      },
    };
  }

  it("returns the empty string when nothing is selected", () => {
    expect(getSelectionPlainText(createInitialState(loadPage("Hello\n")))).toBe(
      "",
    );
  });

  it("projects a multi-block selection to plain text, stripping marks", () => {
    // Bold/italic markers must not survive into the plain-text mirror — it is
    // what a plain copy yields, and is produced without extracting formats.
    const text = getSelectionPlainText(
      selectAll("# Title\n\nA **bold** and *italic* line\n"),
    );
    expect(text).toContain("Title");
    expect(text).toContain("A bold and italic line");
    expect(text).not.toContain("**");
    expect(text).not.toContain("*italic*");
  });
});
