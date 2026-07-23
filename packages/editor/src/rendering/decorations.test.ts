import { describe, expect, it } from "vitest";
import { loadPage } from "../serlization/loadPage";
import { isTextualBlock } from "../sync/block-registry";
import { resolveDecorationPoint } from "./decorations";

describe("character-anchored decorations", () => {
  it("stays attached to the same character when text is inserted before it", () => {
    const page = loadPage("abcd");
    const block = page.blocks[0];
    if (!block || !isTextualBlock(block) || !block.charRuns[0]) {
      throw new Error("expected a textual block");
    }
    const run = block.charRuns[0];
    const point = {
      blockId: block.id,
      afterCharId: `${run.peerId}:${run.startCounter + 1}`,
    };

    expect(resolveDecorationPoint(point, page)?.textIndex).toBe(2);

    const shiftedPage = {
      ...page,
      blocks: page.blocks.map((candidate) =>
        candidate.id === block.id
          ? {
              ...candidate,
              charRuns: [
                { peerId: "peer", startCounter: 1, text: "x" },
                ...block.charRuns,
              ],
            }
          : candidate,
      ),
    };
    expect(resolveDecorationPoint(point, shiftedPage)?.textIndex).toBe(3);

    const deletedAnchorPage = {
      ...page,
      blocks: page.blocks.map((candidate) =>
        candidate.id === block.id
          ? {
              ...candidate,
              charRuns: block.charRuns.map((candidateRun, index) =>
                index === 0
                  ? { ...candidateRun, deletedMask: [0b00000010] }
                  : candidateRun,
              ),
            }
          : candidate,
      ),
    };
    expect(resolveDecorationPoint(point, deletedAnchorPage)?.textIndex).toBe(1);
  });
});
