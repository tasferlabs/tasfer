/**
 * Regression: every editor action must keep the LOCAL page consistent with
 * its EMITTED ops.
 *
 * The invariant: for any action,
 *
 *   visibleBlockOrder(action(state).page)
 *     === visibleBlockOrder(applyOps(state.page, action(state).ops))
 *
 * i.e. a remote peer replaying the ops (or a reload rebuilding from the
 * oplog) computes the same block order the local editor rendered. Historical
 * bug class: action code hand-spliced new/replacement blocks into
 * `page.blocks` without setting `afterId` (or dropped the old block's
 * `afterId` when rebuilding it for a type change). The local array looked
 * right until the next block_insert re-sorted by orderKey — then the
 * mis-keyed block teleported (no orderKey → top of document; an alien
 * clipboard-parser key → wherever it sorted).
 */

import {
  convertBlockAtCursor,
  insertText,
  splitBlock,
} from "../../actions/actions";
import { moveCursorToPosition } from "../../selection";
import type { Block, Page } from "../../serlization/loadPage";
import { loadPage } from "../../serlization/loadPage";
import type { EditorState, Operation } from "../../state-types";
import { createInitialState } from "../../state-utils";
import { isTextualBlock } from "../block-registry";
import { getVisibleTextFromRuns } from "../char-runs";
import { applyOps, getVisibleBlocks } from "../reducer";
import { describe, expect, it } from "vitest";

interface ActionResult {
  state: EditorState;
  ops: Operation[];
}

function orderOf(p: Page): string[] {
  return getVisibleBlocks(p).map((b) => b.id);
}

/**
 * Assert the action's local page matches replaying its ops on the
 * pre-action page — the convergence invariant.
 */
function expectConvergence(prevPage: Page, result: ActionResult): void {
  const replayed = applyOps(prevPage, result.ops);
  expect(orderOf(result.state.document.page)).toEqual(orderOf(replayed));
}

const MD = `First line

Second line

- item one
- item two

Third line
`;

function fresh(): EditorState {
  return createInitialState(loadPage(MD));
}

function textOf(block: Block): string {
  return isTextualBlock(block) ? getVisibleTextFromRuns(block.charRuns) : "";
}

describe("action/op convergence", () => {
  it("convertBlockAtCursor preserves orderKey and converges", () => {
    const s = moveCursorToPosition(fresh(), 2, 0);
    const before = s.document.page.blocks[2].orderKey;
    const conv = convertBlockAtCursor(s, { type: "heading1" });
    expectConvergence(s.document.page, conv);

    const hb = conv.state.document.page.blocks[2];
    expect(hb.orderKey).toBe(before);
  });

  it("Enter after a type change does not reorder the document", () => {
    const s = moveCursorToPosition(fresh(), 2, 0);
    const conv = convertBlockAtCursor(s, { type: "heading1" });

    const block0 = conv.state.document.page.blocks[0];
    const len0 = textOf(block0).length;
    const r = splitBlock(moveCursorToPosition(conv.state, 0, len0));
    const visible = r.state.document.page.blocks.filter((b) => !b.deleted);
    // Block 0 split into two, so the heading moves from index 2 to 3 —
    // and nowhere else.
    expect(visible.findIndex((b) => b.type === "heading1")).toBe(3);
    expectConvergence(conv.state.document.page, r);
  });

  it("converting the last block to a visual type converges (trailing paragraph)", () => {
    const st = fresh();
    const lastIdx = st.document.page.blocks.length - 1;
    const s = moveCursorToPosition(st, lastIdx, 0);
    const conv = convertBlockAtCursor(s, { type: "line" });
    expectConvergence(s.document.page, conv);
  });

  it("Enter at end of a list item, then in the empty item, converges", () => {
    const st = fresh();
    const idx = st.document.page.blocks.findIndex(
      (b) => textOf(b) === "item two",
    );
    const itemTwo = st.document.page.blocks[idx];
    const s = moveCursorToPosition(st, idx, textOf(itemTwo).length);

    const r1 = splitBlock(s);
    expectConvergence(s.document.page, r1);

    // Enter in the new empty list item converts it to a paragraph in place.
    const r2 = splitBlock(r1.state);
    expectConvergence(r1.state.document.page, r2);

    const emptyItemId = r1.state.document.page.blocks[idx + 1].id;
    const pb = r2.state.document.page.blocks.find(
      (b) => b.type === "paragraph" && b.id === emptyItemId,
    );
    expect(pb).toBeDefined();
    expect(pb!.orderKey).toBeDefined();
  });

  it("plain mid-paragraph split converges", () => {
    const st = fresh();
    const r = splitBlock(moveCursorToPosition(st, 0, 5));
    expectConvergence(st.document.page, r);
  });

  it("typing mid-block converges", () => {
    const st = fresh();
    const t = insertText(moveCursorToPosition(st, 2, 3), "XYZ");
    expectConvergence(st.document.page, t);
  });
});
