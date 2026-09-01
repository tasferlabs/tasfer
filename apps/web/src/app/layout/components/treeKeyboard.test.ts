import { describe, expect, it } from "vitest";
import {
  logicalTreeKey,
  resolveTreeKey,
  visibleTreeRows,
  type TreeRow,
} from "./treeKeyboard";

const row = (
  id: string,
  parentId: string | null,
  opts: Partial<Pick<TreeRow, "expanded" | "hasChildren">> = {},
): TreeRow => ({
  id,
  parentId,
  expanded: opts.expanded ?? false,
  hasChildren: opts.hasChildren ?? false,
});

// a (open)
//   a1 (open, animating shut → its children are still mounted)
//     a1x
//   a2
// b (closed, has children)
//   b1   ← mounted only while its exit animation runs
// c
const mounted: TreeRow[] = [
  row("a", null, { expanded: true, hasChildren: true }),
  row("a1", "a", { expanded: false, hasChildren: true }),
  row("a1x", "a1"),
  row("a2", "a"),
  row("b", null, { expanded: false, hasChildren: true }),
  row("b1", "b"),
  row("c", null),
];

describe("visibleTreeRows", () => {
  it("hides rows whose parent is collapsed, even while they stay mounted", () => {
    expect(visibleTreeRows(mounted).map((r) => r.id)).toEqual([
      "a",
      "a1",
      "a2",
      "b",
      "c",
    ]);
  });

  it("hides a whole subtree when an ancestor further up is collapsed", () => {
    const rows = [
      row("p", null, { expanded: false, hasChildren: true }),
      row("q", "p", { expanded: true, hasChildren: true }),
      row("r", "q"),
    ];
    expect(visibleTreeRows(rows).map((r) => r.id)).toEqual(["p"]);
  });
});

describe("resolveTreeKey", () => {
  const rows = visibleTreeRows(mounted);
  const at = (id: string) => rows.findIndex((r) => r.id === id);

  it("moves up and down through visible rows and stops at the ends", () => {
    expect(resolveTreeKey("next", rows, at("a2"))).toEqual({
      type: "focus",
      index: at("b"),
    });
    expect(resolveTreeKey("prev", rows, at("b"))).toEqual({
      type: "focus",
      index: at("a2"),
    });
    expect(resolveTreeKey("next", rows, at("c"))).toBeNull();
    expect(resolveTreeKey("prev", rows, at("a"))).toBeNull();
  });

  it("jumps to the first and last rows", () => {
    expect(resolveTreeKey("first", rows, at("b"))).toEqual({
      type: "focus",
      index: 0,
    });
    expect(resolveTreeKey("last", rows, at("b"))).toEqual({
      type: "focus",
      index: rows.length - 1,
    });
    expect(resolveTreeKey("first", rows, 0)).toBeNull();
  });

  it("expand opens a closed row with children and steps into an open one", () => {
    expect(resolveTreeKey("expand", rows, at("b"))).toEqual({ type: "expand" });
    expect(resolveTreeKey("expand", rows, at("a"))).toEqual({
      type: "focus",
      index: at("a1"),
    });
    // A leaf has nothing to open.
    expect(resolveTreeKey("expand", rows, at("c"))).toBeNull();
  });

  it("expand does nothing on an open row whose children are not there yet", () => {
    const open = [row("p", null, { expanded: true, hasChildren: true })];
    expect(resolveTreeKey("expand", open, 0)).toBeNull();
  });

  it("collapse closes an open row and climbs out of a closed one", () => {
    expect(resolveTreeKey("collapse", rows, at("a"))).toEqual({
      type: "collapse",
    });
    expect(resolveTreeKey("collapse", rows, at("a2"))).toEqual({
      type: "focus",
      index: at("a"),
    });
    // A closed top-level row has nowhere to climb.
    expect(resolveTreeKey("collapse", rows, at("c"))).toBeNull();
  });

  it("ignores an index outside the list", () => {
    expect(resolveTreeKey("next", rows, -1)).toBeNull();
  });
});

describe("logicalTreeKey", () => {
  it("swaps the horizontal arrows in right-to-left layouts", () => {
    expect(logicalTreeKey("ArrowRight", false)).toBe("expand");
    expect(logicalTreeKey("ArrowLeft", false)).toBe("collapse");
    expect(logicalTreeKey("ArrowRight", true)).toBe("collapse");
    expect(logicalTreeKey("ArrowLeft", true)).toBe("expand");
  });

  it("leaves other keys alone", () => {
    expect(logicalTreeKey("Tab", false)).toBeNull();
    expect(logicalTreeKey("a", false)).toBeNull();
  });
});
