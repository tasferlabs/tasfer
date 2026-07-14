import {
  mathContentSelectionFromSourceOffset,
  mathMatrixContext,
} from "@cypherkit/editor/math";
import { parseMathDocumentInit } from "@cypherkit/editor/math/data";
import { describe, expect, it } from "vitest";
import type { AppEditor } from "../editorSchema";
import { treeMathAtAnchor, treeMathAtFocus } from "./treeMath";

describe("treeMathAtFocus", () => {
  it.each(["math", "paragraph"])(
    "resolves the focus of a held matrix selection in a %s surface",
    (type) => {
      const blockId = `${type}-block`;
      const contentId = `${blockId}/math`;
      const latex = String.raw`\frac{a}{b}\begin{bmatrix}a&b\\c&d\end{bmatrix}`;
      const document = parseMathDocumentInit(latex, {
        contentId,
        authority: type === "math" ? "block" : "supplemental",
      }).document;
      const anchorOffset = latex.indexOf("\\begin");
      const anchor = mathContentSelectionFromSourceOffset(
        blockId,
        contentId,
        document,
        anchorOffset,
      );
      const focusOffset = latex.length;
      const focus = mathContentSelectionFromSourceOffset(
        blockId,
        contentId,
        document,
        focusOffset,
      );
      if (!anchor || !focus) throw new Error("expected matrix selections");

      const editor = {
        state: {
          contentSelection: {
            anchor: anchor.focus,
            focus: focus.focus,
          },
        },
        query: {
          block: () => ({ id: blockId, type }),
          content: () => document,
        },
      } as unknown as AppEditor;

      const active = treeMathAtFocus(editor);
      expect(active).toMatchObject({
        blockId,
        contentId,
        source: latex,
        sourceOffset: focusOffset,
      });
      expect(
        active && mathMatrixContext(active.source, active.sourceOffset),
      ).toBeNull();
      const anchored = treeMathAtAnchor(editor);
      expect(
        anchored && mathMatrixContext(anchored.source, anchored.sourceOffset),
      ).toMatchObject({ env: "bmatrix", rows: 2, cols: 2 });
    },
  );
});
