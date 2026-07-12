import { updateCursor } from "./selection";
import type { Block, Page } from "./serlization/loadPage";
import { createInitialState } from "./state-utils";
import {
  cloneContentSelection,
  type ContentGapPoint,
  type ContentSelection,
  contentSelectionsEqual,
  type ContentTextPoint,
  contentTextPointsEqual,
  isContentSelectionCollapsed,
  normalizeContentGapPoint,
  normalizeContentSelection,
  normalizeContentTextPoint,
  reconcileContentSelectionState,
  updateContentSelection,
} from "./structured-selection";
import { recordUndoOps, redoState, undoState } from "./sync/crdt-undo";
import { applyOp } from "./sync/reducer";
import {
  applyStructuredEdit,
  applyStructuredEdits,
  createStructuredDocument,
  type StructuredDocument,
} from "./sync/structured-content";
import { describe, expect, it } from "vitest";

const BLOCK_ID = "block:1";
const CONTENT_ID = "content:1";
const ROOT_ID = CONTENT_ID;
const PARENT_ID = "node:parent";
const SIBLING_ID = "node:sibling";
const TEXT_ID = "node:text";

function attachment(): StructuredDocument {
  return applyStructuredEdits(createStructuredDocument("example", CONTENT_ID), [
    {
      kind: "node_insert",
      node: {
        id: ROOT_ID,
        type: "root",
        placement: { parentId: null, slot: "", orderKey: "" },
      },
    },
    {
      kind: "node_insert",
      node: {
        id: PARENT_ID,
        type: "container",
        placement: {
          parentId: ROOT_ID,
          slot: "children",
          orderKey: "a0",
        },
      },
    },
    {
      kind: "node_insert",
      node: {
        id: SIBLING_ID,
        type: "container",
        placement: {
          parentId: ROOT_ID,
          slot: "children",
          orderKey: "b0",
        },
      },
    },
    {
      kind: "node_insert",
      node: {
        id: TEXT_ID,
        type: "text",
        placement: {
          parentId: PARENT_ID,
          slot: "children",
          orderKey: "a0",
        },
        textFields: {
          value: [{ peerId: "seed", startCounter: 1, text: "abc" }],
        },
      },
    },
  ]);
}

function page(document = attachment()): Page {
  const block: Block = {
    id: BLOCK_ID,
    type: "paragraph",
    charRuns: [],
    formats: [],
    structuredContent: { [CONTENT_ID]: document },
  };
  return { id: "page", title: "", blocks: [block] };
}

function point(
  afterCharId: string | null,
  affinity: ContentTextPoint["affinity"] = "forward",
): ContentTextPoint {
  return {
    kind: "text",
    blockId: BLOCK_ID,
    contentId: CONTENT_ID,
    nodeId: TEXT_ID,
    field: "value",
    afterCharId,
    affinity,
  };
}

function gap(afterNodeId: string | null, slot = "children"): ContentGapPoint {
  return {
    kind: "gap",
    blockId: BLOCK_ID,
    contentId: CONTENT_ID,
    parentId: ROOT_ID,
    slot,
    afterNodeId,
    affinity: "forward",
  };
}

function selection(
  anchor: string | null,
  focus: string | null = anchor,
): ContentSelection {
  return { anchor: point(anchor), focus: point(focus, "backward") };
}

describe("structured content selection", () => {
  it("retains visible character identities and boundary affinity", () => {
    const start = point(null);
    const live = point("seed:2", "backward");

    expect(normalizeContentTextPoint(page(), start)).toBe(start);
    expect(normalizeContentTextPoint(page(), live)).toBe(live);
    expect(normalizeContentTextPoint(page(), point("missing:99"))).toBeNull();
  });

  it("does not retarget a text caret when a remote character is inserted before it", () => {
    const caret = point("seed:2", "backward");
    const inserted = applyStructuredEdit(attachment(), {
      kind: "text_insert",
      nodeId: TEXT_ID,
      field: "value",
      afterCharId: "seed:1",
      charRuns: [{ peerId: "remote", startCounter: 20, text: "x" }],
    });

    expect(normalizeContentTextPoint(page(inserted), caret)).toBe(caret);
  });

  it("falls back to the previous visible character when its text anchor is deleted", () => {
    const deleted = applyStructuredEdit(attachment(), {
      kind: "text_delete",
      nodeId: TEXT_ID,
      field: "value",
      charIds: ["seed:2"],
    });

    expect(
      normalizeContentTextPoint(page(deleted), point("seed:2", "backward")),
    ).toEqual(point("seed:1", "backward"));
  });

  it("keeps ranges within one declared text field", () => {
    const valid = selection(null, "seed:2");
    expect(normalizeContentSelection(page(), valid)).toBe(valid);

    expect(
      normalizeContentSelection(page(), {
        ...valid,
        focus: { ...valid.focus, field: "missing" },
      }),
    ).toBeNull();
    expect(
      normalizeContentSelection(page(), {
        ...valid,
        focus: { ...valid.focus, nodeId: PARENT_ID },
      }),
    ).toBeNull();
  });

  it("represents empty child slots and keeps cross-node ranges in one attachment", () => {
    const empty = gap(null, "empty-row");
    expect(normalizeContentGapPoint(page(), empty)).toBe(empty);

    const live = gap(PARENT_ID);
    expect(normalizeContentGapPoint(page(), live)).toBe(live);

    const range = { anchor: gap(null), focus: gap(SIBLING_ID) };
    expect(normalizeContentSelection(page(), range)).toBe(range);
    const crossNode = { anchor: gap(null), focus: point(null) };
    expect(normalizeContentSelection(page(), crossNode)).toBe(crossNode);
    expect(
      normalizeContentSelection(page(), {
        anchor: gap(null),
        focus: { ...point(null), contentId: "other-content" },
      }),
    ).toBeNull();
  });

  it("does not retarget a gap when a remote sibling is inserted before it", () => {
    const caret = gap(SIBLING_ID);
    const inserted = applyStructuredEdit(attachment(), {
      kind: "node_insert",
      node: {
        id: "node:remote",
        type: "container",
        placement: {
          parentId: ROOT_ID,
          slot: "children",
          orderKey: "a5",
        },
      },
    });

    expect(normalizeContentGapPoint(page(inserted), caret)).toBe(caret);
  });

  it("falls back to the previous visible sibling when a gap predecessor is deleted", () => {
    const caret = gap(SIBLING_ID);
    const deletedSibling = applyStructuredEdit(attachment(), {
      kind: "node_delete",
      nodeId: SIBLING_ID,
    });

    expect(normalizeContentGapPoint(page(deletedSibling), caret)).toEqual(
      gap(PARENT_ID),
    );

    const deletedParent = applyStructuredEdit(attachment(), {
      kind: "node_delete",
      nodeId: PARENT_ID,
    });
    expect(
      normalizeContentGapPoint(page(deletedParent), gap(PARENT_ID)),
    ).toEqual(gap(null));
  });

  it("invalidates missing or moved gap predecessors", () => {
    expect(normalizeContentGapPoint(page(), gap("missing"))).toBeNull();

    const moved = applyStructuredEdit(attachment(), {
      kind: "node_move",
      nodeId: SIBLING_ID,
      placement: {
        parentId: ROOT_ID,
        slot: "other-children",
        orderKey: "b0",
      },
    });
    expect(normalizeContentGapPoint(page(moved), gap(SIBLING_ID))).toBeNull();
  });

  it("drops points whose block, attachment, node, or ancestor disappears", () => {
    const deletedParent = applyStructuredEdit(attachment(), {
      kind: "node_delete",
      nodeId: PARENT_ID,
    });
    const orphan = applyStructuredEdit(attachment(), {
      kind: "node_move",
      nodeId: TEXT_ID,
      placement: {
        parentId: "missing",
        slot: "children",
        orderKey: "a0",
      },
    });
    const withoutContent = page();
    withoutContent.blocks[0] = {
      ...withoutContent.blocks[0],
      structuredContent: {},
    };

    expect(
      normalizeContentTextPoint(page(deletedParent), point("seed:1")),
    ).toBeNull();
    expect(normalizeContentTextPoint(page(orphan), point("seed:1"))).toBeNull();
    expect(
      normalizeContentTextPoint(withoutContent, point("seed:1")),
    ).toBeNull();
    expect(
      normalizeContentTextPoint(
        {
          ...page(),
          blocks: [{ ...page().blocks[0], deleted: true }],
        },
        point("seed:1"),
      ),
    ).toBeNull();
  });

  it("compares direction and affinity exactly but collapses by stable stop", () => {
    const forward = selection("seed:1", "seed:2");
    const reversed = { anchor: forward.focus, focus: forward.anchor };
    const sameStopDifferentAffinity = {
      anchor: point("seed:1", "forward"),
      focus: point("seed:1", "backward"),
    } satisfies ContentSelection;

    expect(contentSelectionsEqual(forward, reversed)).toBe(false);
    expect(
      contentSelectionsEqual(
        { ...forward, lastUpdate: 1 },
        { ...forward, lastUpdate: 2 },
      ),
    ).toBe(false);
    expect(
      contentTextPointsEqual(point("seed:1"), point("seed:1", "backward")),
    ).toBe(false);
    expect(isContentSelectionCollapsed(sameStopDifferentAffinity)).toBe(true);
  });

  it("keeps nested and document selections mutually exclusive", () => {
    const initial = updateCursor(createInitialState(page()), {
      blockIndex: 0,
      textIndex: 0,
    });
    const nested = updateContentSelection(initial, selection("seed:1"));

    expect(nested.document.cursor).toBeNull();
    expect(nested.document.selection).toBeNull();
    expect(nested.document.contentSelection).toEqual(selection("seed:1"));

    const documentCaret = updateCursor(nested, {
      blockIndex: 0,
      textIndex: 0,
    });
    expect(documentCaret.document.contentSelection).toBeNull();
  });

  it("reconciles page replacements and returns the same state when valid", () => {
    const selected = updateContentSelection(
      createInitialState(page()),
      selection("seed:2"),
    );
    expect(reconcileContentSelectionState(selected)).toBe(selected);

    const pageWithoutAttachment: Page = {
      ...selected.document.page,
      blocks: [{ ...selected.document.page.blocks[0], structuredContent: {} }],
    };
    const stale = {
      ...selected,
      document: { ...selected.document, page: pageWithoutAttachment },
    };
    expect(
      reconcileContentSelectionState(stale).document.contentSelection,
    ).toBeNull();
  });

  it("clones presence payloads and restores nested ranges through undo/redo", () => {
    const beforeSelection = { ...selection("seed:1"), lastUpdate: 123 };
    let before = updateContentSelection(
      createInitialState(page()),
      beforeSelection,
    );
    const detached = cloneContentSelection(beforeSelection)!;
    expect(detached).toEqual(beforeSelection);
    expect(detached).not.toBe(beforeSelection);
    expect(detached.anchor).not.toBe(beforeSelection.anchor);
    expect(detached.lastUpdate).toBe(123);

    const op = {
      op: "content_edit" as const,
      id: before.CRDTbinding.nextId(),
      clock: before.CRDTbinding.getClock(),
      pageId: before.CRDTbinding.pageId,
      blockId: BLOCK_ID,
      contentId: CONTENT_ID,
      edit: {
        kind: "text_insert" as const,
        nodeId: TEXT_ID,
        field: "value",
        afterCharId: "seed:1",
        charRuns: [{ peerId: "local", startCounter: 20, text: "x" }],
      },
    };
    const afterPage = applyOp(before.document.page, op, before.schema);
    const after = updateContentSelection(
      { ...before, document: { ...before.document, page: afterPage } },
      selection("local:20"),
    );
    before = recordUndoOps(before, after, [op], before.CRDTbinding.getPeerId());

    const undone = undoState(before).state;
    expect(undone.document.contentSelection).toEqual(beforeSelection);
    const redone = redoState(undone).state;
    expect(redone.document.contentSelection).toEqual(selection("local:20"));
  });
});
