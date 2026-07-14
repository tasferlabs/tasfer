/**
 * Convergence regression: morphing a *formatted* paragraph into a non-formattable
 * textual type (math, code) must drop its inline mark spans identically on every
 * peer.
 *
 * The originating peer runs `convertBlockAtCursor`, which clears marks when the
 * target can't hold them (`canHaveFormats(type) ? formats : []`). Remote peers
 * never see that action — they only replay the emitted `block_set type` op
 * through the reducer. If the reducer preserved `formats` unconditionally, the
 * originator would show no marks while remote peers kept them: a permanent
 * divergence. This pins both sides to the same empty `formats`.
 */

import { mathTestSchema, mathTestStateOptions } from "../__testutils__/math";
import { convertBlockAtCursor } from "../actions/actions";
import type { Paragraph } from "../nodes/TextNode";
import type { MarkSpan, Page } from "../serlization/loadPage";
import type { BlockSet, EditorState } from "../state-types";
import { createInitialState } from "../state-utils";
import { applyOp } from "./reducer";
import { describe, expect, it } from "vitest";

// "hello" laid out as a single run → char ids "peer:0".."peer:4".
const boldSpan: MarkSpan = {
  startCharId: "peer:0",
  endCharId: "peer:4",
  format: { type: "bold" },
  clock: { counter: 1, peerId: "peer" },
};

function formattedParagraph(): Paragraph {
  return {
    id: "p-1",
    orderKey: "a0",
    deleted: false,
    type: "paragraph",
    charRuns: [{ peerId: "peer", startCounter: 0, text: "hello" }],
    formats: [boldSpan],
  };
}

function pageWith(...blocks: Page["blocks"]): Page {
  return { id: "page-1", title: "t", blocks };
}

function formatsOf(block: Page["blocks"][number]): MarkSpan[] {
  return (block as Paragraph).formats;
}

describe.each(["math", "code"])(
  "formatted paragraph → %s converges across peers",
  (target) => {
    it("drops inline marks on both the originating and remote peers", () => {
      // Originating peer: convert via the action.
      const base: EditorState = createInitialState(
        pageWith(formattedParagraph()),
        mathTestStateOptions(),
      );
      const originator: EditorState = {
        ...base,
        document: {
          ...base.document,
          cursor: { position: { blockIndex: 0, textIndex: 5 }, lastUpdate: 0 },
        },
      };
      const { state: localState, ops } = convertBlockAtCursor(originator, {
        type: target,
      });
      const localBlock = localState.document.page.blocks[0];
      expect(localBlock.type).toBe(target);
      expect(formatsOf(localBlock)).toEqual([]);

      // Remote peer: same starting paragraph, replays only the emitted ops.
      let remotePage = pageWith(formattedParagraph());
      for (const op of ops) {
        remotePage = applyOp(remotePage, op, mathTestSchema.data);
      }
      const remoteBlock = remotePage.blocks[0];
      expect(remoteBlock.type).toBe(target);

      // The bug: the reducer used to keep `formats` unconditionally, so this was
      // `[boldSpan]` on the remote while the originator had `[]`.
      expect(formatsOf(remoteBlock)).toEqual(formatsOf(localBlock));
      expect(formatsOf(remoteBlock)).toEqual([]);

      // Sanity: the type op alone (no formats op is ever emitted) is what drives
      // the remote convergence.
      const typeOps = ops.filter(
        (o): o is BlockSet => o.op === "block_set" && o.field === "type",
      );
      expect(typeOps.map((o) => o.value)).toEqual([target]);
    });
  },
);
