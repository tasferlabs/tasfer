/**
 * What a copy puts on the clipboard as `text/plain`: the markdown source, so a
 * paste into a plain-text app keeps `**bold**`, bullets and headings. A range
 * inside one code block is raw code, and a range inside one block drops that
 * block's prefix — a word copied out of a bullet is not "- word".
 */

import { type DragTransfer, readTextDrop } from "../events/dragEvents";
import { baseSchema } from "../schema";
import { moveCursorToPosition } from "../selection";
import type { Block, CharRun } from "../serlization/loadPage";
import { loadPage } from "../serlization/loadPage";
import type { EditorState, Position } from "../state-types";
import { createInitialState } from "../state-utils";
import { getVisibleTextFromRuns } from "../sync/char-runs";
import { getVisibleBlocks } from "../sync/reducer";
import {
  buildClipboardPayload,
  type ClipboardPayload,
  insertClipboardPayload,
  pasteFromClipboardEvent,
  pasteFromClipboardEventAsPlainText,
} from "./clipboard";
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

/**
 * Inside Tasfer, a paste that inserts text as-is still gets the plain words: the
 * copy records them in its html next to the markdown.
 */
describe("pasting a Tasfer copy as-is", () => {
  const copied = () =>
    buildClipboardPayload(select("- one **bold**", at(0, 0), at(0, 8)))!;

  function texts(state: EditorState) {
    return getVisibleBlocks(state.document.page).map((b) =>
      getVisibleTextFromRuns((b as { charRuns: CharRun[] }).charRuns),
    );
  }

  function codeBlock(): EditorState {
    const state = createInitialState(loadPage("```js\n\n```"), {
      schema: baseSchema.data,
    });
    return moveCursorToPosition(state, 0, 0);
  }

  function paragraph(): EditorState {
    const state = createInitialState(loadPage("\n"), {
      schema: baseSchema.data,
    });
    return moveCursorToPosition(state, 0, 0);
  }

  function clipboardEvent(payload: ClipboardPayload): ClipboardEvent {
    const data: Record<string, string> = {
      "text/plain": payload.text,
      "text/html": payload.html,
    };
    return {
      clipboardData: { getData: (type: string) => data[type] ?? "" },
    } as unknown as ClipboardEvent;
  }

  it("still puts markdown on text/plain for other apps", () => {
    expect(copied().text).toBe("- one **bold**");
    expect(copied().plainText).not.toContain("**");
  });

  it("pastes the plain words into a code block", () => {
    const payload = copied();
    const result = pasteFromClipboardEvent(codeBlock(), {} as ClipboardEvent, {
      text: payload.text,
      html: payload.html,
      imageFile: null,
    });
    expect(texts(result!.state)).toEqual([payload.plainText]);
  });

  it("pastes the plain words on a plain-text paste", async () => {
    const payload = copied();
    const result = await pasteFromClipboardEventAsPlainText(
      paragraph(),
      clipboardEvent(payload),
    );
    const blocks = getVisibleBlocks(result!.state.document.page);
    expect(texts(result!.state).join("")).not.toContain("**");
    expect(
      blocks.flatMap(
        (b) => (b as Block & { formats?: unknown[] }).formats ?? [],
      ),
    ).toEqual([]);
  });

  it("drops the plain words into a code block", () => {
    const payload = copied();
    const data: Record<string, string> = {
      "text/plain": payload.text,
      "text/html": payload.html,
    };
    const dropped = readTextDrop({
      getData: (type: string) => data[type] ?? "",
    } as unknown as DragTransfer)!;
    expect(dropped.plainText).toBe(payload.plainText);
    const result = insertClipboardPayload(codeBlock(), dropped);
    expect(texts(result!.state)).toEqual([payload.plainText]);
  });

  it("adds no extra marker when the text is already plain", () => {
    const payload = buildClipboardPayload(select("plain", at(0, 0), at(0, 5)))!;
    expect(payload.html).not.toContain("tasfer-clipboard-text");
  });
});
