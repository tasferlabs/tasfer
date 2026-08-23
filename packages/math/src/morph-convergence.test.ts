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

import { mathTestSchema, mathTestStateOptions } from "./__testutils__/math";
import { convertBlockAtCursor } from "@tasfer/editor/actions/actions";
import type { Paragraph } from "@tasfer/editor/nodes/TextNode";
import type {
  Block,
  MarkSpan,
  Page,
} from "@tasfer/editor/serlization/loadPage";
import type {
  BlockSet,
  EditorState,
  Operation,
} from "@tasfer/editor/state-types";
import { createInitialState } from "@tasfer/editor/state-utils";
import { getVisibleTextFromRuns } from "@tasfer/editor/sync/char-runs";
import { invertOperation } from "@tasfer/editor/sync/inverse";
import { applyOp } from "@tasfer/editor/sync/reducer";
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

function textOf(block: Page["blocks"][number]): string {
  return getVisibleTextFromRuns((block as Paragraph).charRuns);
}

function caretAtEnd(page: Page): EditorState {
  const base = createInitialState(page, mathTestStateOptions());
  return {
    ...base,
    document: {
      ...base.document,
      cursor: { position: { blockIndex: 0, textIndex: 5 }, lastUpdate: 0 },
    },
  };
}

describe.each(["math", "code"])(
  "formatted paragraph → %s converges across peers",
  (target) => {
    it("drops inline marks on both the originating and remote peers", () => {
      // Originating peer: convert via the action.
      const originator = caretAtEnd(pageWith(formattedParagraph()));
      const { state: localState, ops } = convertBlockAtCursor(originator, {
        // "math" sits outside the closed core Block["type"] union; cast at the
        // feature boundary as the defineNode idiom does.
        type: target as Block["type"],
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

/**
 * Convergence regression: a paragraph → code convert KEEPS the block's text —
 * locally, on a peer replaying the ops, and on undo.
 *
 * `convertBlockAtCursor` emits only `block_set type=code` (+ the target type's
 * own fields) and carries the char runs locally. The reducer used to carry them
 * only for types sharing a `morphGroup`, which paragraph and code do not: the
 * originator saw "hello" in a code block while every remote peer — and the
 * local undo, which replays inverses through the same reducer — rebuilt it
 * empty.
 */
describe("paragraph → code keeps its text across peers", () => {
  it("replays the text onto a remote peer and restores it on undo", () => {
    const originator = caretAtEnd(pageWith(formattedParagraph()));
    const { state: localState, ops } = convertBlockAtCursor(originator, {
      type: "code",
    });
    expect(localState.document.page.blocks[0].type).toBe("code");
    expect(textOf(localState.document.page.blocks[0])).toBe("hello");

    // Remote peer: same starting paragraph, replays only the emitted ops. Each
    // inverse is computed against the page as it stood BEFORE its own op, which
    // is exactly how the local undo stack builds them.
    let remotePage = pageWith(formattedParagraph());
    const inverses: Operation[] = [];
    for (const op of ops) {
      inverses.push(
        ...invertOperation(
          op,
          remotePage,
          originator.CRDTbinding,
          mathTestSchema.data,
        ),
      );
      remotePage = applyOp(remotePage, op, mathTestSchema.data);
    }
    expect(remotePage.blocks[0].type).toBe("code");
    expect(textOf(remotePage.blocks[0])).toBe("hello");

    // Undo: the inverses run newest-first and land back on the bold paragraph.
    let undonePage = remotePage;
    for (const inverse of [...inverses].reverse()) {
      undonePage = applyOp(undonePage, inverse, mathTestSchema.data);
    }
    expect(undonePage.blocks[0].type).toBe("paragraph");
    expect(textOf(undonePage.blocks[0])).toBe("hello");
    expect(formatsOf(undonePage.blocks[0]).map((s) => s.format.type)).toEqual([
      "bold",
    ]);
  });
});
