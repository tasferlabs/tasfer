/**
 * What a copy puts on the clipboard as `text/plain`: the markdown source, so a
 * paste into a plain-text app keeps `**bold**`, bullets and headings. A range
 * inside one code block is raw code, and a range inside one block drops that
 * block's prefix — a word copied out of a bullet is not "- word".
 */

import { baseSchema } from "../schema";
import { loadPage } from "../serlization/loadPage";
import type { EditorState, Position } from "../state-types";
import { createInitialState } from "../state-utils";
import { buildClipboardPayload } from "./clipboard";
import { describe, expect, it } from "vitest";

function select(md: string, anchor: Position, focus: Position): EditorState {
  const page = loadPage(md, baseSchema.data);
  const base = createInitialState(page, { schema: baseSchema.data });
  return {
    ...base,
    document: {
      ...base.document,
      cursor: { position: focus, lastUpdate: 0 },
      selection: {
        anchor,
        focus,
        isForward: true,
        isCollapsed: false,
        lastUpdate: 0,
      },
    },
  };
}

function at(blockIndex: number, textIndex: number): Position {
  return {
    blockIndex,
    textIndex,
  };
}

describe("the text/plain flavor of a copy", () => {
  it("is markdown across blocks", () => {
    const state = select(
      "# Title\n\n- one **bold**\n- two",
      at(0, 0),
      at(2, 3),
    );
    const payload = buildClipboardPayload(state)!;
    expect(payload.text).toBe("# Title\n- one **bold**\n- two");
    expect(payload.text).toBe(payload.markdown);
    // The stripped text is still there for callers that want it.
    expect(payload.plainText).not.toContain("**");
  });

  it("keeps a whole block's prefix", () => {
    const state = select("- one **bold**", at(0, 0), at(0, 8));
    expect(buildClipboardPayload(state)!.text).toBe("- one **bold**");
  });

  it("drops the block prefix for part of one block", () => {
    const state = select("- one **bold** end", at(0, 4), at(0, 8));
    expect(buildClipboardPayload(state)!.text).toBe("**bold**");
  });

  it("is the raw source inside a code block", () => {
    const state = select("```js\nconst a = 1;\n```", at(0, 0), at(0, 5));
    expect(buildClipboardPayload(state)!.text).toBe("const");
  });
});
