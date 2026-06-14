/**
 * Regression: a value-less `block_set` must never mutate document state.
 *
 * Origin: an image starts at `width: "full"`, `objectFit: "cover"`. A defensive
 * edge case in the resize math left the local block's `width`/`objectFit`
 * `undefined`, and `endImageDrag` emitted `block_set` ops with `value:
 * undefined`. That serializes to a *value-less* op (JSON drops the key). The
 * local editor that emitted it had already mutated its in-memory image to the
 * undefined value, so the image reflowed to its default size and the content
 * below it jumped — healing only on reload, because every peer rebuilding from
 * the log rejects the malformed op and keeps `width: "full"`.
 *
 * `endImageDrag` now guards the emit side (no op for an undefined value); this
 * test pins the apply-side guarantee that even a malformed op already sitting
 * in an oplog is an inert no-op, so it converges identically on every peer.
 */

import type { Block, Operation } from "../../state-types";
import { resolveBlockOrder } from "../crdt-utils";
import { applyOp, createEmptyPageState, getVisibleBlocks } from "../reducer";
import { describe, expect, it } from "vitest";

function imageBlock(): Block {
  return {
    id: ":img",
    afterId: null,
    type: "image",
    url: "https://example.com/i.png",
    width: "full",
    height: 336,
    objectFit: "cover",
    alt: "",
  } as Block;
}

describe("value-less block_set", () => {
  it("is a no-op on apply (image keeps width/objectFit)", () => {
    let page = createEmptyPageState("p");
    page = {
      ...page,
      blocks: resolveBlockOrder([...page.blocks, imageBlock()]),
    };

    // Exact malformed shape from a real oplog: `field` present, `value` absent.
    const widthOp = {
      op: "block_set",
      id: ":w",
      clock: { counter: 1, peerId: "" },
      pageId: "p",
      blockId: ":img",
      field: "width",
    } as unknown as Operation;
    const fitOp = {
      op: "block_set",
      id: ":f",
      clock: { counter: 2, peerId: "" },
      pageId: "p",
      blockId: ":img",
      field: "objectFit",
    } as unknown as Operation;

    page = applyOp(page, widthOp);
    page = applyOp(page, fitOp);

    const img = getVisibleBlocks(page)[0] as Block & {
      width: unknown;
      objectFit: unknown;
    };
    expect(img.width).toBe("full");
    expect(img.objectFit).toBe("cover");
  });

  it("an explicit undefined value is also a no-op", () => {
    let page = createEmptyPageState("p");
    page = {
      ...page,
      blocks: resolveBlockOrder([...page.blocks, imageBlock()]),
    };

    const op = {
      op: "block_set",
      id: ":w",
      clock: { counter: 1, peerId: "" },
      pageId: "p",
      blockId: ":img",
      field: "width",
      value: undefined,
    } as unknown as Operation;

    page = applyOp(page, op);
    expect(
      (getVisibleBlocks(page)[0] as Block & { width: unknown }).width,
    ).toBe("full");
  });
});
