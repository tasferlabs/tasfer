import type { Block, Page } from "../serlization/loadPage";
import type { ContentEdit, Operation } from "../state-types";
import { invertOperation } from "./inverse";
import { applyOp, applyOps, rebuildState } from "./reducer";
import { blocksToOps } from "./snapshot-diff";
import {
  applyStructuredEdit,
  createStructuredDocument,
  getStructuredChildren,
  getStructuredText,
  type StructuredDocument,
} from "./structured-content";
import { createCRDTbinding, createSyncEngine } from "./sync";
import { describe, expect, it } from "vitest";

function document(contentId: string): StructuredDocument {
  return applyStructuredEdit(createStructuredDocument("example", contentId), {
    kind: "node_insert",
    node: {
      id: contentId,
      type: "root",
      placement: { parentId: null, slot: "", orderKey: "" },
    },
  });
}

describe("content_edit operation", () => {
  it("initializes and edits a structured attachment through SyncEngine", () => {
    const binding = createCRDTbinding("page", "peer");
    const engine = createSyncEngine(binding);
    const block = engine.createBlockInsert("a0", "paragraph");
    engine.emit([block]);

    const contentId = binding.nextId();
    engine.emit([
      engine.createContentEdit(block.blockId, contentId, {
        kind: "document_init",
        document: document(contentId),
      }),
      engine.createContentEdit(block.blockId, contentId, {
        kind: "node_insert",
        node: {
          id: binding.nextId(),
          type: "text",
          placement: {
            parentId: contentId,
            slot: "children",
            orderKey: "a0",
          },
        },
      }),
    ]);

    const attachment =
      engine.getState().blocks[0].structuredContent?.[contentId];
    expect(attachment).toBeDefined();
    expect(
      getStructuredChildren(attachment!, contentId, "children"),
    ).toHaveLength(1);
  });

  it("converges when the same HLC-ordered log arrives in different arrays", () => {
    const contentId = "p:2";
    const operations: Operation[] = [
      {
        op: "block_insert",
        id: "p:1",
        clock: { counter: 1, peerId: "p" },
        pageId: "page",
        blockId: "p:10",
        blockType: "paragraph",
        orderKey: "a0",
      },
      {
        op: "content_edit",
        id: "p:3",
        clock: { counter: 2, peerId: "p" },
        pageId: "page",
        blockId: "p:10",
        contentId,
        edit: { kind: "document_init", document: document(contentId) },
      },
      {
        op: "content_edit",
        id: "a:1",
        clock: { counter: 3, peerId: "a" },
        pageId: "page",
        blockId: "p:10",
        contentId,
        edit: {
          kind: "node_insert",
          node: {
            id: "a:2",
            type: "item",
            placement: {
              parentId: contentId,
              slot: "children",
              orderKey: "same",
            },
          },
        },
      },
      {
        op: "content_edit",
        id: "b:1",
        clock: { counter: 3, peerId: "b" },
        pageId: "page",
        blockId: "p:10",
        contentId,
        edit: {
          kind: "node_insert",
          node: {
            id: "b:2",
            type: "item",
            placement: {
              parentId: contentId,
              slot: "children",
              orderKey: "same",
            },
          },
        },
      },
    ];

    expect(rebuildState("page", operations)).toEqual(
      rebuildState("page", [...operations].reverse()),
    );
  });

  it("refuses type morphs that would discard block-authoritative content", () => {
    const blockId = "owner:10";
    const contentId = "owner:11";
    const authoritative = {
      ...document(contentId),
      authority: "block" as const,
    };
    const operations: Operation[] = [
      {
        op: "block_insert",
        id: "owner:1",
        clock: { counter: 1, peerId: "owner" },
        pageId: "page",
        blockId,
        blockType: "paragraph",
        orderKey: "a0",
      },
      {
        op: "content_edit",
        id: "owner:2",
        clock: { counter: 2, peerId: "owner" },
        pageId: "page",
        blockId,
        contentId,
        edit: {
          kind: "document_init",
          document: authoritative,
        },
      },
      {
        op: "block_set",
        id: "owner:3",
        clock: { counter: 3, peerId: "owner" },
        pageId: "page",
        blockId,
        field: "type",
        value: "heading1",
      },
    ];

    const empty: Page = { id: "page", title: "", blocks: [] };
    const incremental = applyOps(empty, operations);
    const rebuilt = rebuildState("page", [...operations].reverse());
    for (const page of [incremental, rebuilt]) {
      expect(page.blocks[0].type).toBe("paragraph");
      expect(page.blocks[0].structuredContent?.[contentId]).toEqual(
        authoritative,
      );
    }

    // Even if a caller captured a generic inverse for the refused op, replaying
    // it is harmless and leaves the authoritative snapshot byte-identical.
    const binding = createCRDTbinding("page", "undo-owner");
    const morph = operations[2];
    const inverses = invertOperation(morph, incremental, binding);
    const refused = applyOp(incremental, morph);
    expect(refused).toBe(incremental);
    expect(applyOps(refused, inverses)).toEqual(incremental);
  });

  it("carries supplemental content across replayed type morphs", () => {
    const blockId = "supplemental:10";
    const contentId = "supplemental:11";
    const supplemental = document(contentId);
    const operations: Operation[] = [
      {
        op: "block_insert",
        id: "supplemental:1",
        clock: { counter: 1, peerId: "supplemental" },
        pageId: "page",
        blockId,
        blockType: "paragraph",
        orderKey: "a0",
      },
      {
        op: "content_edit",
        id: "supplemental:2",
        clock: { counter: 2, peerId: "supplemental" },
        pageId: "page",
        blockId,
        contentId,
        edit: { kind: "document_init", document: supplemental },
      },
      {
        op: "block_set",
        id: "supplemental:3",
        clock: { counter: 3, peerId: "supplemental" },
        pageId: "page",
        blockId,
        field: "type",
        value: "heading1",
      },
    ];

    const empty: Page = { id: "page", title: "", blocks: [] };
    for (const page of [
      applyOps(empty, operations),
      rebuildState("page", [...operations].reverse()),
    ]) {
      expect(page.blocks[0].type).toBe("heading1");
      expect(page.blocks[0].structuredContent?.[contentId]).toEqual(
        supplemental,
      );
    }
  });

  it("participates in operation undo", () => {
    const binding = createCRDTbinding("page", "undo");
    const blockId = "undo:10";
    const contentId = "undo:11";
    const base: Page = {
      id: "page",
      title: "",
      blocks: [
        {
          id: blockId,
          type: "paragraph",
          charRuns: [],
          formats: [],
          structuredContent: { [contentId]: document(contentId) },
        },
      ],
    };
    const edit: ContentEdit = {
      op: "content_edit",
      id: "undo:1",
      clock: { counter: 1, peerId: "undo" },
      pageId: "page",
      blockId,
      contentId,
      edit: {
        kind: "node_attr_set",
        nodeId: contentId,
        key: "label",
        value: "changed",
      },
    };

    const inverses = invertOperation(edit, base, binding);
    const changed = applyOp(base, edit);
    expect(
      changed.blocks[0].structuredContent?.[contentId].nodes[contentId].attrs
        .label,
    ).toBe("changed");
    expect(applyOps(changed, inverses)).toEqual(base);
  });

  it("keeps initialization monotonic when its user edit is undone", () => {
    const binding = createCRDTbinding("page", "undo-init");
    const blockId = "undo-init:10";
    const contentId = "undo-init:11";
    const base: Page = {
      id: "page",
      title: "",
      blocks: [
        {
          id: blockId,
          type: "paragraph",
          charRuns: [],
          formats: [],
        },
      ],
    };
    const init: ContentEdit = {
      op: "content_edit",
      id: "undo-init:1",
      clock: { counter: 1, peerId: "undo-init" },
      pageId: "page",
      blockId,
      contentId,
      edit: { kind: "document_init", document: document(contentId) },
    };

    const inverses = invertOperation(init, base, binding);
    const initialized = applyOp(base, init);
    expect(initialized.blocks[0].structuredContent?.[contentId]).toBeDefined();
    expect(inverses).toEqual([]);
    expect(applyOps(initialized, inverses)).toBe(initialized);
  });

  it("restores a deleted attachment through operation undo", () => {
    const binding = createCRDTbinding("page", "undo-delete");
    const blockId = "undo-delete:10";
    const contentId = "undo-delete:11";
    const base: Page = {
      id: "page",
      title: "",
      blocks: [
        {
          id: blockId,
          type: "paragraph",
          charRuns: [],
          formats: [],
          structuredContent: { [contentId]: document(contentId) },
        },
      ],
    };
    const remove: ContentEdit = {
      op: "content_edit",
      id: "undo-delete:1",
      clock: { counter: 1, peerId: "undo-delete" },
      pageId: "page",
      blockId,
      contentId,
      edit: { kind: "document_delete" },
    };

    const inverses = invertOperation(remove, base, binding);
    const removed = applyOp(base, remove);
    expect(removed.blocks[0].structuredContent).toBeUndefined();
    expect(applyOps(removed, inverses)).toEqual(base);
  });

  it("survives block snapshot-to-op projection", () => {
    const contentId = "source:20";
    let attachment = document(contentId);
    attachment = applyStructuredEdit(attachment, {
      kind: "node_insert",
      node: {
        id: "source:21",
        type: "text",
        placement: {
          parentId: contentId,
          slot: "children",
          orderKey: "a0",
        },
        textFields: {
          value: [{ peerId: "source", startCounter: 22, text: "hello" }],
        },
      },
    });
    const block: Block = {
      id: "old",
      type: "paragraph",
      charRuns: [],
      formats: [],
      structuredContent: { [contentId]: attachment },
    };
    let counter = 100;
    const ops = blocksToOps([block], {
      pageId: "new-page",
      peerId: "import",
      nextId: () => `import:${counter++}`,
      getClock: () => ({ counter: counter++, peerId: "import" }),
    });

    const rebuilt = rebuildState("new-page", ops);
    const restored = rebuilt.blocks[0].structuredContent?.[contentId];
    expect(restored).toBeDefined();
    expect(getStructuredText(restored!, "source:21", "value")).toBe("hello");
  });
});
