import type { Block, ContentSelection } from "@tasfer/editor";
import { describe, expect, it } from "vitest";
import {
  cursorPresenceToDecorations,
  selectionToCursorPresence,
  type CursorDocument,
  type CursorUser,
} from "./cursors";

const user: CursorUser = { peerId: "peer-1", name: "Ada" };

describe("flat cursor presence", () => {
  it("publishes offsets as character-identity gaps", () => {
    const run = { peerId: "author", startCounter: 10, text: "hello" };
    const block = {
      id: "block-1",
      deleted: false,
      charRuns: [run],
    } as unknown as Block;
    const doc = {
      getRawBlocks: () => [block],
    } satisfies CursorDocument;

    const presence = selectionToCursorPresence(
      { block: block.id, offset: 3 },
      user,
      null,
      doc,
    );

    expect(presence).toMatchObject({
      caret: {
        blockId: block.id,
        afterCharId: `${run.peerId}:${run.startCounter + 2}`,
      },
      selection: null,
    });
    expect(cursorPresenceToDecorations("peer-1", presence)).toMatchObject([
      {
        kind: "caret",
        point: {
          blockId: block.id,
          afterCharId: `${run.peerId}:${run.startCounter + 2}`,
        },
      },
    ]);

    const rangePresence = selectionToCursorPresence(
      {
        from: { block: block.id, offset: 1 },
        to: { block: block.id, offset: 4 },
      },
      user,
      null,
      doc,
    );
    expect(rangePresence.selection).toEqual({
      from: {
        blockId: block.id,
        afterCharId: `${run.peerId}:${run.startCounter}`,
      },
      to: {
        blockId: block.id,
        afterCharId: `${run.peerId}:${run.startCounter + 3}`,
      },
    });
  });
});

function contentSelection(
  afterAnchor: string | null,
  afterFocus: string | null,
) {
  return {
    anchor: {
      kind: "text",
      blockId: "math-block",
      contentId: "math-block/math",
      nodeId: "row-1",
      field: "text",
      afterCharId: afterAnchor,
      affinity: "forward",
    },
    focus: {
      kind: "text",
      blockId: "math-block",
      contentId: "math-block/math",
      nodeId: "row-1",
      field: "text",
      afterCharId: afterFocus,
      affinity: "forward",
    },
  } satisfies ContentSelection;
}

describe("structured cursor presence", () => {
  it("publishes a nested math range as a range decoration", () => {
    const selection = contentSelection("char-1", "char-3");
    const presence = selectionToCursorPresence(null, user, selection);

    expect(presence).toMatchObject({
      caret: null,
      selection: { from: selection.anchor, to: selection.focus },
    });
    expect(cursorPresenceToDecorations("peer-1", presence)).toMatchObject([
      {
        kind: "range",
        range: { from: selection.anchor, to: selection.focus },
      },
    ]);
  });

  it("publishes a collapsed nested math selection as a caret decoration", () => {
    const selection = contentSelection("char-1", "char-1");
    const presence = selectionToCursorPresence(null, user, selection);

    expect(presence).toMatchObject({ caret: selection.focus, selection: null });
    expect(cursorPresenceToDecorations("peer-1", presence)).toMatchObject([
      { kind: "caret", point: selection.focus },
    ]);
  });
});
