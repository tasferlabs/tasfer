/**
 * A structured mark whose attachment reference outlived the block that owned it.
 *
 * A merge clones the source's attachments onto the target and re-addresses the
 * covering marks. When the source block had (locally) lost an attachment its
 * mark still referenced, the clone found nothing to clone and the re-addressing
 * kept the source-scoped content id — a reference the same transaction
 * tombstoned along with the source block. Every later reload then resolved the
 * mark, found no attachment, and painted a blank chip.
 */
import { createMathTestState, loadMathPage } from "../__testutils__/math";
import { resolveMarkRuns } from "../inline-math-spans";
import { moveCursorToPosition } from "../selection";
import { parseMathDocumentInit } from "../math/structured";
import type { Block } from "../serlization/loadPage";
import type { EditorState } from "../state-types";
import { applyOps, rebuildState } from "../sync/reducer";
import { convertToList, mergeBlocksOps } from "./actions";
import { createFeatureMarkInRange } from "./structured-marks";
import { describe, expect, it } from "vitest";

/** Turn `[from, to)` of `blockIndex` into an inline math chip. */
function attachChip(
  state: EditorState,
  blockIndex: number,
  from: number,
  to: number,
): EditorState {
  const block = state.document.page.blocks[blockIndex];
  const result = createFeatureMarkInRange(
    state.document.page,
    block.id,
    from,
    to,
    { type: "math" },
    state.CRDTbinding,
    state.schema,
  );
  return {
    ...state,
    document: { ...state.document, page: result.newPage },
  } satisfies EditorState;
}

/** Every content id the block's marks point at. */
function markContentIds(block: Block): string[] {
  return resolveMarkRuns(block)
    .map((run) => run.attrs.contentId)
    .filter((id): id is string => typeof id === "string");
}

/**
 * Move `from`'s attachments onto `to`, leaving `from`'s chars and marks intact —
 * the state an earlier merge/paste leaves behind when it re-addresses nothing.
 */
function donateAttachments(
  state: EditorState,
  from: number,
  to: number,
): EditorState {
  const blocks = [...state.document.page.blocks];
  const { structuredContent: donated, ...rest } = blocks[from];
  blocks[from] = rest as Block;
  blocks[to] = {
    ...blocks[to],
    structuredContent: { ...(blocks[to].structuredContent ?? {}), ...donated },
  };
  return {
    ...state,
    document: {
      ...state.document,
      page: { ...state.document.page, blocks },
    },
  } satisfies EditorState;
}

describe("structured mark attachment healing", () => {
  it("re-adopts a dropped attachment when merging instead of stranding it", () => {
    let state = createMathTestState(loadMathPage("ab\n\nX"));
    state = attachChip(state, 2, 0, 1);

    const sourceIndex = 2;
    const contentId = markContentIds(state.document.page.blocks[sourceIndex])[0];
    expect(typeof contentId).toBe("string");

    // The failure precondition: the chip's mark was already fossilized by an
    // earlier transaction — it references an attachment a DIFFERENT block owns.
    // Merging such a block used to carry the stale id forward untouched.
    state = donateAttachments(state, sourceIndex, 1);
    expect(
      state.document.page.blocks[sourceIndex].structuredContent,
    ).toBeUndefined();
    expect(
      state.document.page.blocks[1].structuredContent?.[contentId],
    ).toBeDefined();

    const merged = mergeBlocksOps(
      state.document.page,
      state.document.page.blocks[sourceIndex],
      state.document.page.blocks[0],
      state.CRDTbinding,
      state.schema,
    );

    const joined = merged.newPage.blocks.find(
      (block) => block.id === state.document.page.blocks[0].id && !block.deleted,
    );
    expect(joined).toBeDefined();
    if (!joined) return;

    // The surviving mark must reference an attachment the SURVIVING block owns.
    const joinedContentIds = markContentIds(joined);
    expect(joinedContentIds).toHaveLength(1);
    expect(joinedContentIds[0]).not.toBe(contentId);
    expect(joined.structuredContent?.[joinedContentIds[0]]?.rootId).toBe(
      joinedContentIds[0],
    );

    // And the op log says the same thing — this is what a reload replays.
    const replayed = applyOps(
      state.document.page,
      [...merged.ops],
      state.schema,
    );
    const replayedJoined = replayed.blocks.find(
      (block) => block.id === joined.id && !block.deleted,
    );
    const replayedContentIds = replayedJoined
      ? markContentIds(replayedJoined)
      : [];
    expect(replayedContentIds).toEqual(joinedContentIds);
    expect(
      replayedJoined?.structuredContent?.[replayedContentIds[0]]?.rootId,
    ).toBe(replayedContentIds[0]);
  });

  it("heals a mark_set that already fossilized a cross-block reference", () => {
    // Hand-built oplog matching the shape found in a real export: the anchor
    // and mark move to the target block, the attachment never does, and the
    // donor block is tombstoned in the same transaction.
    const pageId = "p";
    const ops = [
      {
        op: "block_insert",
        id: "peer:1",
        clock: { counter: 1, peerId: "peer" },
        pageId,
        orderKey: "a0",
        blockId: "target",
        blockType: "paragraph",
      },
      {
        op: "block_insert",
        id: "peer:2",
        clock: { counter: 2, peerId: "peer" },
        pageId,
        orderKey: "a1",
        blockId: "donor",
        blockType: "paragraph",
      },
      {
        op: "content_edit",
        id: "peer:3",
        clock: { counter: 3, peerId: "peer" },
        pageId,
        blockId: "donor",
        contentId: "peer:4",
        edit: parseMathDocumentInit("x", {
          contentId: "peer:4",
          authority: "supplemental",
        }),
      },
      {
        op: "text_insert",
        id: "peer:5",
        clock: { counter: 5, peerId: "peer" },
        pageId,
        blockId: "target",
        afterCharId: null,
        charRuns: [{ peerId: "peer", startCounter: 10, text: "￼" }],
      },
      // The fossil: the mark lands on `target` still pointing at the donor's
      // attachment, and the donor is deleted immediately after.
      {
        op: "mark_set",
        id: "peer:6",
        clock: { counter: 6, peerId: "peer" },
        pageId,
        blockId: "target",
        charIds: ["peer:10"],
        format: { type: "math", attrs: { contentId: "peer:4" } },
        value: true,
      },
      {
        op: "block_delete",
        id: "peer:7",
        clock: { counter: 7, peerId: "peer" },
        pageId,
        blockId: "donor",
      },
    ];

    const schema = createMathTestState(loadMathPage("x")).schema;
    const page = rebuildState(pageId, ops as never, schema);
    const target = page.blocks.find((block) => block.id === "target");
    expect(target).toBeDefined();
    if (!target) return;

    // The mark resolves against an attachment the host block now owns.
    expect(markContentIds(target)).toEqual(["peer:4"]);
    expect(target.structuredContent?.["peer:4"]?.rootId).toBe("peer:4");
  });

  it("keeps attachments when converting a block to a list", () => {
    let state = createMathTestState(loadMathPage("abX"));
    state = attachChip(state, 0, 2, 3);

    state = moveCursorToPosition(state, 0, 0);
    const result = convertToList(state, "bullet_list");

    const local = result.state.document.page.blocks[0];
    const replayed = applyOps(
      state.document.page,
      [...result.ops],
      state.schema,
    ).blocks[0];

    // The local view and what every replica computes from the ops must agree.
    expect(Object.keys(local.structuredContent ?? {})).toEqual(
      Object.keys(replayed.structuredContent ?? {}),
    );
    const contentId = markContentIds(local)[0];
    expect(local.structuredContent?.[contentId]?.rootId).toBe(contentId);
  });
});
