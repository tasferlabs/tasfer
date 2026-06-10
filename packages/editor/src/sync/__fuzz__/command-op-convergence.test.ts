/**
 * Regression: every editor command must keep the LOCAL page consistent with
 * its EMITTED ops.
 *
 * The invariant: for any command,
 *
 *   visibleBlockOrder(command(state).page)
 *     === visibleBlockOrder(applyOps(state.page, command(state).ops))
 *
 * i.e. a remote peer replaying the ops (or a reload rebuilding from the
 * oplog) computes the same block order the local editor rendered. Historical
 * bug class: command code hand-spliced new/replacement blocks into
 * `page.blocks` without setting `afterId` (or dropped the old block's
 * `afterId` when rebuilding it for a type change). The local array looked
 * right until the next block_insert ran resolveBlockOrder — then the
 * mis-anchored block teleported (no afterId → top of document; an alien
 * clipboard-parser afterId → end of document).
 */

import {
  convertBlockType,
  insertText,
  splitBlock,
} from "../../actions/commands";
import { moveCursorToPosition } from "../../selection";
import type { Block, Page } from "../../serlization/loadPage";
import { loadPage } from "../../serlization/loadPage";
import type { EditorState, Operation } from "../../state-types";
import { createInitialState } from "../../state-utils";
import { isTextualBlock } from "../block-registry";
import { getVisibleTextFromRuns } from "../char-runs";
import { applyOps, getVisibleBlocks } from "../reducer";
import { describe, expect, it } from "vitest";

interface CommandResult {
  state: EditorState;
  ops: Operation[];
}

function orderOf(p: Page): string[] {
  return getVisibleBlocks(p).map((b) => b.id);
}

/**
 * Assert the command's local page matches replaying its ops on the
 * pre-command page — the convergence invariant.
 */
function expectConvergence(prevPage: Page, result: CommandResult): void {
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

describe("command/op convergence", () => {
  it("convertBlockType preserves afterId and converges", () => {
    const s = moveCursorToPosition(fresh(), 2, 0);
    const conv = convertBlockType(s, "heading1");
    expectConvergence(s.document.page, conv);

    const hb = conv.state.document.page.blocks[2];
    expect(hb.afterId).toBe("block-1");
  });

  it("Enter after a type change does not reorder the document", () => {
    const s = moveCursorToPosition(fresh(), 2, 0);
    const conv = convertBlockType(s, "heading1");

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
    const conv = convertBlockType(s, "line");
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
    expect(pb!.afterId).not.toBeNull();
    expect(pb!.afterId).toBeDefined();
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
