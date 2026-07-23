import type { ContentSelection } from "@tasfer/editor";
import { describe, expect, it } from "vitest";
import {
  cursorPresenceToDecorations,
  selectionToCursorPresence,
  type CursorUser,
} from "./cursors";

const user: CursorUser = { peerId: "peer-1", name: "Ada" };

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
