/**
 * `getVisibleBlocks` stamps view-only fields (`originalIndex`, neighbour types)
 * in place on the shared page blocks of a full-document editor. They must not
 * reach a saved snapshot, nor trip the dev-only incremental-vs-rebuilt check in
 * `mergeOps`, which compares through `cleanSnapshotForSave`.
 */

import { type Block } from "../serlization/loadPage";
import { createOpLog, mergeOps } from "./oplog";
import { cleanSnapshotForSave, getVisibleBlocks } from "./reducer";
import { blocksToOps } from "./snapshot-diff";
import { createCRDTbinding } from "./sync";
import { afterEach, describe, expect, it, vi } from "vitest";

const PAGE = "clean-page";

function paragraph(text: string): Block {
  return {
    id: `src-${text}`,
    orderKey: "",
    type: "paragraph",
    charRuns: [{ peerId: "src", startCounter: 0, text }],
    formats: [],
  } as Block;
}

function opsFor(
  binding: ReturnType<typeof createCRDTbinding>,
  texts: string[],
) {
  return blocksToOps(texts.map(paragraph), {
    pageId: PAGE,
    peerId: binding.getPeerId(),
    nextId: binding.nextId,
    getClock: binding.getClock,
  });
}

afterEach(() => vi.restoreAllMocks());

describe("cleanSnapshotForSave", () => {
  it("drops the fields a full-document view stamps on blocks", () => {
    const binding = createCRDTbinding(PAGE, "writer");
    const log = mergeOps(createOpLog(PAGE), opsFor(binding, ["one", "two"]));
    getVisibleBlocks(log.state);

    for (const block of cleanSnapshotForSave(log.state.blocks)) {
      expect(block).not.toHaveProperty("originalIndex");
      expect(block).not.toHaveProperty("prevType");
      expect(block).not.toHaveProperty("nextType");
    }
  });

  it("keeps mergeOps' dev divergence check quiet after a view stamped the page", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const binding = createCRDTbinding(PAGE, "writer");
    const log = mergeOps(createOpLog(PAGE), opsFor(binding, ["one"]));
    getVisibleBlocks(log.state);

    mergeOps(log, opsFor(binding, ["two"]));

    expect(error).not.toHaveBeenCalled();
  });
});
