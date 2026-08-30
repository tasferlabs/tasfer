/**
 * The precomputed child index must be indistinguishable from the scan it
 * replaces — same nodes, same order, same treatment of tombstones and orphans.
 * A grid node walks a whole tree per layout, so the two paths diverging would
 * show up as cells rendering in the wrong order, not as an obvious error.
 */

import {
  applyStructuredEdit,
  applyStructuredEdits,
  buildStructuredChildIndex,
  createStructuredDocument,
  getStructuredChildren,
  type StructuredDocument,
  type StructuredEdit,
} from "./structured-content";
import { describe, expect, it } from "vitest";

const ROOT = "root0";

function seed(
  id: string,
  parentId: string,
  slot: string,
  orderKey: string,
): StructuredEdit {
  return {
    kind: "node_insert",
    node: { id, type: "cell", placement: { parentId, slot, orderKey } },
  };
}

/** Two rows of two cells, plus a deleted row and an orphan. */
function grid(): StructuredDocument {
  let document = applyStructuredEdit(
    createStructuredDocument("example", ROOT),
    {
      kind: "node_insert",
      node: {
        id: ROOT,
        type: "table",
        placement: { parentId: null, slot: "", orderKey: "" },
      },
    },
  );
  document = applyStructuredEdits(document, [
    seed("r1", ROOT, "rows", "a1"),
    seed("r0", ROOT, "rows", "a0"),
    seed("r2", ROOT, "rows", "a2"),
    seed("c01", "r0", "cells", "a1"),
    seed("c00", "r0", "cells", "a0"),
    seed("c10", "r1", "cells", "a0"),
    // A column list on the same parent — a different slot must not bleed in.
    seed("col0", ROOT, "columns", "a0"),
    // Orphan: its parent was never inserted.
    seed("ghost", "missing", "cells", "a0"),
    { kind: "node_delete", nodeId: "r2" },
  ]);
  return document;
}

function ids(nodes: { id: string }[]): string[] {
  return nodes.map((node) => node.id);
}

describe("structured child index", () => {
  const document = grid();
  const index = buildStructuredChildIndex(document);

  const cases: ReadonlyArray<[string, string, { includeDeleted?: boolean }]> = [
    ["rows of the root", "rows", {}],
    ["rows including tombstones", "rows", { includeDeleted: true }],
    ["cells of a row", "cells", {}],
    ["an empty slot", "footer", {}],
  ];

  for (const [name, slot, options] of cases) {
    it(`matches the scanning path for ${name}`, () => {
      const parentId = slot === "cells" ? "r0" : ROOT;
      expect(
        ids(
          getStructuredChildren(document, parentId, slot, {
            ...options,
            index,
          }),
        ),
      ).toEqual(ids(getStructuredChildren(document, parentId, slot, options)));
    });
  }

  it("returns children in fractional-index order, not insertion order", () => {
    expect(
      ids(getStructuredChildren(document, ROOT, "rows", { index })),
    ).toEqual(["r0", "r1"]);
    expect(
      ids(getStructuredChildren(document, "r0", "cells", { index })),
    ).toEqual(["c00", "c01"]);
  });

  it("keeps slots on one parent separate", () => {
    expect(
      ids(getStructuredChildren(document, ROOT, "columns", { index })),
    ).toEqual(["col0"]);
  });

  it("hides a deleted node's subtree by refusing to traverse it", () => {
    expect(getStructuredChildren(document, "r2", "cells", { index })).toEqual(
      [],
    );
  });

  it("does not surface orphans whose parent is absent", () => {
    expect(
      getStructuredChildren(document, "missing", "cells", { index }),
    ).toEqual([]);
  });

  it("hands back a fresh array the caller may sort in place", () => {
    const first = getStructuredChildren(document, ROOT, "rows", { index });
    first.reverse();

    expect(
      ids(getStructuredChildren(document, ROOT, "rows", { index })),
    ).toEqual(["r0", "r1"]);
  });
});
