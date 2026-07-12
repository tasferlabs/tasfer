import type { CharRun } from "../serlization/loadPage";
import {
  applyStructuredEdit,
  applyStructuredEdits,
  canonicalizeStructuredDocument,
  createStructuredDocument,
  getStructuredChildren,
  getStructuredText,
  invertStructuredEdit,
  structuredContentId,
  type StructuredDocument,
  type StructuredEdit,
  type StructuredNodeSeed,
} from "./structured-content";
import { describe, expect, it } from "vitest";

const ROOT = "tree:root";

function root(): StructuredNodeSeed {
  return {
    id: ROOT,
    type: "root",
    placement: { parentId: null, slot: "", orderKey: "" },
  };
}

function child(
  id: string,
  parentId = ROOT,
  slot = "children",
  orderKey = "a0",
): StructuredNodeSeed {
  return { id, type: "item", placement: { parentId, slot, orderKey } };
}

function withRoot(): StructuredDocument {
  return applyStructuredEdit(createStructuredDocument("test", ROOT), {
    kind: "node_insert",
    node: root(),
  });
}

function run(peerId: string, startCounter: number, text: string): CharRun[] {
  return [{ peerId, startCounter, text }];
}

describe("structured content reducer", () => {
  it("derives feature-agnostic attachment ids from block and slot", () => {
    expect(structuredContentId("block:7", "math")).toBe("block:7/math");
    expect(structuredContentId("block:7", "diagram/layer")).toBe(
      "block:7/diagram%2Flayer",
    );
    expect(() => structuredContentId("block:7", "")).toThrow(/slot/);
  });

  it("retains orphans and resolves named child slots in deterministic order", () => {
    const orphanFirst: StructuredEdit[] = [
      {
        kind: "node_insert",
        node: child("leaf", "row", "children", "a0"),
      },
      { kind: "node_insert", node: root() },
      {
        kind: "node_insert",
        node: child("row", ROOT, "body", "a0"),
      },
      {
        kind: "node_insert",
        node: child("z", "row", "children", "same"),
      },
      {
        kind: "node_insert",
        node: child("a", "row", "children", "same"),
      },
    ];

    const beforeParent = applyStructuredEdit(
      createStructuredDocument("test", ROOT),
      orphanFirst[0],
    );
    expect(beforeParent.nodes.leaf).toBeDefined();
    expect(getStructuredChildren(beforeParent, "row", "children")).toEqual([]);

    const document = applyStructuredEdits(
      createStructuredDocument("test", ROOT),
      orphanFirst,
    );
    expect(
      getStructuredChildren(document, ROOT, "body").map((n) => n.id),
    ).toEqual(["row"]);
    expect(
      getStructuredChildren(document, "row", "children").map((n) => n.id),
    ).toEqual(["leaf", "a", "z"]);
  });

  it("converges concurrent same-anchor text inserts in either arrival order", () => {
    const seeded = applyStructuredEdit(withRoot(), {
      kind: "node_insert",
      node: child("text"),
    });
    const a: StructuredEdit = {
      kind: "text_insert",
      nodeId: "text",
      field: "source",
      afterCharId: null,
      charRuns: run("a", 1, "A"),
    };
    const b: StructuredEdit = {
      kind: "text_insert",
      nodeId: "text",
      field: "source",
      afterCharId: null,
      charRuns: run("b", 1, "B"),
    };

    const ab = applyStructuredEdits(seeded, [a, b]);
    const ba = applyStructuredEdits(seeded, [b, a]);
    expect(getStructuredText(ab, "text", "source")).toBe(
      getStructuredText(ba, "text", "source"),
    );
    expect(getStructuredText(ab, "text", "source")).toBe("BA");
  });

  it("tombstones and restores nodes without losing descendant edits", () => {
    const seeded = applyStructuredEdits(withRoot(), [
      { kind: "node_insert", node: child("parent") },
      { kind: "node_insert", node: child("leaf", "parent") },
    ]);
    const deletion: StructuredEdit = { kind: "node_delete", nodeId: "parent" };
    const inverses = invertStructuredEdit(deletion, seeded);
    const deleted = applyStructuredEdit(seeded, deletion);
    const editedWhileHidden = applyStructuredEdit(deleted, {
      kind: "node_attr_set",
      nodeId: "leaf",
      key: "value",
      value: 42,
    });

    expect(
      getStructuredChildren(editedWhileHidden, "parent", "children"),
    ).toEqual([]);
    const restored = applyStructuredEdits(editedWhileHidden, inverses);
    expect(getStructuredChildren(restored, ROOT, "children")[0].id).toBe(
      "parent",
    );
    expect(restored.nodes.leaf.attrs.value).toBe(42);
  });

  it("round-trips text insert/delete and attribute null/delete through inverses", () => {
    let document = applyStructuredEdit(withRoot(), {
      kind: "node_insert",
      node: { ...child("text"), attrs: { delimiter: null } },
    });

    const insert: StructuredEdit = {
      kind: "text_insert",
      nodeId: "text",
      field: "source",
      afterCharId: null,
      charRuns: run("p", 1, "abc"),
    };
    const undoInsert = invertStructuredEdit(insert, document);
    const afterInsert = applyStructuredEdit(document, insert);
    expect(getStructuredText(afterInsert, "text", "source")).toBe("abc");
    const redoInsert = invertStructuredEdit(undoInsert[0], afterInsert);
    document = applyStructuredEdits(afterInsert, undoInsert);
    expect(getStructuredText(document, "text", "source")).toBe("");
    document = applyStructuredEdits(document, redoInsert);
    expect(getStructuredText(document, "text", "source")).toBe("abc");

    const remove: StructuredEdit = {
      kind: "node_attr_delete",
      nodeId: "text",
      key: "delimiter",
    };
    const undoRemove = invertStructuredEdit(remove, document);
    document = applyStructuredEdit(document, remove);
    expect(Object.hasOwn(document.nodes.text.attrs, "delimiter")).toBe(false);
    document = applyStructuredEdits(document, undoRemove);
    expect(document.nodes.text.attrs.delimiter).toBeNull();
  });

  it("rejects root mutation, cycles, unsafe values, and malformed text runs", () => {
    const seeded = applyStructuredEdits(withRoot(), [
      { kind: "node_insert", node: child("a") },
      { kind: "node_insert", node: child("b", "a") },
    ]);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(
      applyStructuredEdit(seeded, { kind: "node_delete", nodeId: ROOT }),
    ).toBe(seeded);
    expect(
      applyStructuredEdit(seeded, {
        kind: "node_move",
        nodeId: "a",
        placement: { parentId: "b", slot: "children", orderKey: "a0" },
      }),
    ).toBe(seeded);
    expect(
      applyStructuredEdit(seeded, {
        kind: "node_attr_set",
        nodeId: "a",
        key: "bad",
        value: Number.NaN,
      }),
    ).toBe(seeded);
    expect(
      applyStructuredEdit(seeded, {
        kind: "node_attr_set",
        nodeId: "a",
        key: "cyclic",
        value: cyclic as never,
      }),
    ).toBe(seeded);
    expect(
      applyStructuredEdit(seeded, {
        kind: "text_insert",
        nodeId: "a",
        field: "text",
        afterCharId: null,
        charRuns: [{ peerId: "", startCounter: -1, text: "x" }],
      }),
    ).toBe(seeded);
  });

  it("canonicalizes snapshot map keys without dropping tombstones", () => {
    let document = applyStructuredEdits(withRoot(), [
      {
        kind: "node_insert",
        node: {
          ...child("z"),
          attrs: { z: true, a: false },
          textFields: {
            z: run("p", 2, "z"),
            a: run("p", 1, "a"),
          },
        },
      },
      { kind: "node_insert", node: child("a") },
    ]);
    document = applyStructuredEdit(document, {
      kind: "node_delete",
      nodeId: "z",
    });

    const snapshot = canonicalizeStructuredDocument(document);
    expect(Object.keys(snapshot.nodes)).toEqual(["a", ROOT, "z"]);
    expect(Object.keys(snapshot.nodes.z.attrs)).toEqual(["a", "z"]);
    expect(Object.keys(snapshot.nodes.z.textFields)).toEqual(["a", "z"]);
    expect(snapshot.nodes.z.deleted).toBe(true);
  });
});
