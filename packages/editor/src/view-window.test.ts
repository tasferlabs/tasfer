/**
 * Block VIEW WINDOWS — scoping an editor to a subset of a shared doc's blocks
 * (`ViewWindow`, the `window` option, and the `titleBlockWindow` builder).
 *
 * Four things are pinned here:
 *  1. Title-block identification — the first non-deleted TEXT block, stable even
 *     when empty (unlike the content-derived `extractTitleFromBlocks`).
 *  2. `getVisibleBlocks` windowing — filters to the window while preserving each
 *     survivor's true `originalIndex`, and (the pivotal property) does NOT mutate
 *     the shared block instances, so two editors on one Doc can't clobber each
 *     other. The unwindowed fast path still stamps in place.
 *  3. Single-block authoring gate — a `singleBlock` window makes split / merge /
 *     forward-merge inert, so a TitleEditor can never create, split, or merge a
 *     block. The same actions on the SAME page WITHOUT a window still mutate.
 */

import { deleteForward, deleteText, splitBlock } from "./actions/actions";
import type { Block, Page } from "./serlization/loadPage";
import type { CursorState, EditorState } from "./state-types";
import { createInitialState } from "./state-utils";
import { getVisibleBlocks } from "./sync/reducer";
import {
  blockIdWindow,
  titleBlockIndex,
  titleBlockWindow,
} from "./view-window";
import { describe, expect, it } from "vitest";

// ── fixtures ──────────────────────────────────────────────────────────────

function textual(
  type: Block["type"],
  id: string,
  orderKey: string,
  text: string,
): Block {
  return {
    id,
    orderKey,
    deleted: false,
    type,
    charRuns: text ? [{ peerId: "peer", startCounter: 0, text }] : [],
    formats: [],
  } as unknown as Block;
}

function image(id: string, orderKey: string): Block {
  return {
    id,
    orderKey,
    deleted: false,
    type: "image",
    url: "x",
  } as unknown as Block;
}

function pageWith(...blocks: Block[]): Page {
  return { id: "page-1", title: "t", blocks };
}

function cursorAt(blockIndex: number, textIndex: number): CursorState {
  return { position: { blockIndex, textIndex }, lastUpdate: 0 };
}

/** State scoped to the title block (single-block window), caret at `cursor`. */
function titleStateWith(page: Page, cursor: CursorState): EditorState {
  const base = createInitialState(page, { window: titleBlockWindow() });
  return { ...base, document: { ...base.document, cursor } };
}

/** Same page/caret, but a FULL-document editor (no window) — the contrast. */
function fullStateWith(page: Page, cursor: CursorState): EditorState {
  const base = createInitialState(page);
  return { ...base, document: { ...base.document, cursor } };
}

// ── 1. title-block identification ────────────────────────────────────────────

describe("titleBlockIndex / titleBlockWindow", () => {
  it("is the first non-deleted text block", () => {
    const page = pageWith(
      textual("heading1", "h", "a0", "Title"),
      textual("paragraph", "p", "a1", "Body"),
    );
    expect(titleBlockIndex(page.blocks)).toBe(0);
  });

  it("skips a leading non-text block (image / divider)", () => {
    const page = pageWith(
      image("i", "a0"),
      textual("heading1", "h", "a1", "Title"),
    );
    expect(titleBlockIndex(page.blocks)).toBe(1);
  });

  it("skips tombstoned blocks", () => {
    const deleted = textual("heading1", "d", "a0", "Old");
    (deleted as { deleted: boolean }).deleted = true;
    const page = pageWith(deleted, textual("paragraph", "p", "a1", "Title"));
    expect(titleBlockIndex(page.blocks)).toBe(1);
  });

  it("is -1 when the document has no text block", () => {
    expect(titleBlockIndex(pageWith(image("i", "a0")).blocks)).toBe(-1);
    expect(titleBlockIndex([])).toBe(-1);
  });

  it("titleBlockWindow selects exactly the title index and is single-block", () => {
    const page = pageWith(
      image("i", "a0"),
      textual("heading1", "h", "a1", "Title"),
    );
    const w = titleBlockWindow();
    expect([...w.select(page.blocks)]).toEqual([1]);
    expect(w.singleBlock).toBe(true);
    // Empty document → empty window (nothing rendered), never throws.
    expect(w.select([]).size).toBe(0);
  });

  it("blockIdWindow selects the block by id, or nothing if absent/deleted", () => {
    const page = pageWith(
      textual("paragraph", "p", "a0", "one"),
      textual("paragraph", "q", "a1", "two"),
    );
    expect([...blockIdWindow("q").select(page.blocks)]).toEqual([1]);
    expect(blockIdWindow("missing").select(page.blocks).size).toBe(0);
    (page.blocks[1] as { deleted: boolean }).deleted = true;
    expect(blockIdWindow("q").select(page.blocks).size).toBe(0);
  });
});

// ── 2. getVisibleBlocks windowing ────────────────────────────────────────────

describe("getVisibleBlocks — windowing", () => {
  it("returns only in-window blocks, preserving true originalIndex", () => {
    const page = pageWith(
      image("i", "a0"),
      textual("heading1", "h", "a1", "Title"),
      textual("paragraph", "p", "a2", "Body"),
    );
    const visible = getVisibleBlocks(page, titleBlockWindow());
    expect(visible.map((b) => b.id)).toEqual(["h"]);
    expect(visible[0].originalIndex).toBe(1); // its index in the FULL doc
  });

  it("copy-on-window: does NOT mutate the shared block instances", () => {
    const page = pageWith(
      image("i", "a0"),
      textual("heading1", "h", "a1", "Title"),
    );
    const title = page.blocks[1];
    const visible = getVisibleBlocks(page, titleBlockWindow());
    // The returned shell is a copy, not the shared instance…
    expect(visible[0]).not.toBe(title);
    // …and the shared instance was never stamped with originalIndex/neighbours.
    expect((title as { originalIndex?: number }).originalIndex).toBeUndefined();
    expect((title as { prevType?: string }).prevType).toBeUndefined();
  });

  it("unwindowed fast path still stamps originalIndex in place", () => {
    const page = pageWith(
      textual("heading1", "h", "a0", "Title"),
      textual("paragraph", "p", "a1", "Body"),
    );
    const visible = getVisibleBlocks(page);
    expect(visible[0]).toBe(page.blocks[0]); // same instance (no copy)
    expect((page.blocks[0] as { originalIndex?: number }).originalIndex).toBe(
      0,
    );
    expect((page.blocks[1] as { originalIndex?: number }).originalIndex).toBe(
      1,
    );
  });

  it("two windows over one page don't clobber each other's stamps", () => {
    const page = pageWith(
      textual("heading1", "h", "a0", "Title"),
      textual("paragraph", "p", "a1", "Body"),
    );
    // A title window and a body-block window, as two editors would derive them.
    const titleView = getVisibleBlocks(page, titleBlockWindow());
    const bodyView = getVisibleBlocks(page, blockIdWindow("p"));
    expect(titleView.map((b) => b.id)).toEqual(["h"]);
    expect(bodyView.map((b) => b.id)).toEqual(["p"]);
    // Neither derivation left a stamp on the shared blocks.
    for (const b of page.blocks) {
      expect((b as { originalIndex?: number }).originalIndex).toBeUndefined();
    }
  });
});

// ── 3. single-block authoring gate ───────────────────────────────────────────

describe("single-block window — authoring gate", () => {
  it("Enter (splitBlock) is inert in the title, but splits a full editor", () => {
    const page = pageWith(textual("heading1", "h", "a0", "Title"));
    const cur = cursorAt(0, 2); // caret inside "Ti|tle"

    const gated = splitBlock(titleStateWith(page, cur));
    expect(gated.ops).toEqual([]);

    const ungated = splitBlock(fullStateWith(page, cur));
    expect(ungated.ops.length).toBeGreaterThan(0);
  });

  it("Backspace at offset 0 never merges a windowed block into a prior block", () => {
    // Two paragraphs; a single-block window scoped to the SECOND. A full editor
    // merges the second back into the first on Backspace-at-0; the windowed
    // editor must not touch the block outside its window.
    const page = pageWith(
      textual("paragraph", "a", "a0", "before"),
      textual("paragraph", "b", "a1", "title"),
    );
    const cur = cursorAt(1, 0);
    const base = createInitialState(page, { window: blockIdWindow("b") });
    const windowed: EditorState = {
      ...base,
      document: { ...base.document, cursor: cur },
    };

    expect(deleteText(windowed).ops).toEqual([]);
    expect(deleteText(fullStateWith(page, cur)).ops.length).toBeGreaterThan(0);
  });

  it("Delete at end never merges a following block into the title", () => {
    const page = pageWith(
      textual("heading1", "h", "a0", "Title"),
      textual("paragraph", "p", "a1", "Body"),
    );
    const cur = cursorAt(0, "Title".length);

    expect(deleteForward(titleStateWith(page, cur)).ops).toEqual([]);
    expect(deleteForward(fullStateWith(page, cur)).ops.length).toBeGreaterThan(
      0,
    );
  });

  it("typing inside the title still works (the gate is boundary-only)", () => {
    const page = pageWith(textual("heading1", "h", "a0", "Title"));
    // A character delete in the middle is NOT a boundary op — it must apply.
    const mid = deleteText(titleStateWith(page, cursorAt(0, 3)));
    expect(mid.ops.length).toBeGreaterThan(0);
  });
});
