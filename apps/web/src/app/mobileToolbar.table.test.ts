import { describe, expect, it } from "vitest";
import {
  createMobileToolbarModel,
  type MobileToolbarItem,
  type MobileToolbarTableContext,
} from "./mobileToolbar";

/** The English fallback is what the model carries when no catalog is loaded. */
const t = (_key: string, fallback?: string) => fallback ?? _key;

const baseState = {
  visible: true,
  bottomInset: 0,
  canUndo: false,
  canRedo: false,
  isBold: false,
  isItalic: false,
  isCode: false,
  isMath: false,
  canOpenMathCommands: false,
  table: null as MobileToolbarTableContext | null,
  isStrikethrough: false,
  blockType: "paragraph" as const,
  listIndent: 0,
  todoChecked: false,
  linkActive: false,
  canCreateLink: false,
  canRepositionImage: false,
  repositioningImage: false,
  math: null,
};

function build(table: MobileToolbarTableContext | null) {
  return createMobileToolbarModel({ ...baseState, table }, t);
}

function findItem(items: MobileToolbarItem[], id: string) {
  return items.find((item) => item.id === id);
}

function tableMenu(table: MobileToolbarTableContext) {
  const item = findItem(build(table).layout.left, "table");
  if (item?.kind !== "menu") throw new Error("no table menu in the left zone");
  return item;
}

const square: MobileToolbarTableContext = {
  rows: 3,
  columns: 3,
  columnIndex: 1,
  align: null,
};

describe("the toolbar's table menu", () => {
  it("takes the block switcher's slot while the caret is in a cell", () => {
    const inTable = build(square).layout.left;
    expect(findItem(inTable, "table")?.kind).toBe("menu");
    expect(findItem(inTable, "block")).toBeUndefined();

    // Out of the table the switcher comes back — a cell is prose, but it is not
    // a block whose type can be changed.
    const inProse = build(null).layout.left;
    expect(findItem(inProse, "block")?.kind).toBe("menu");
    expect(findItem(inProse, "table")).toBeUndefined();
  });

  it("drops inline math from a cell's drawer, and keeps the other marks", () => {
    const inCell = build(square).layout.more;
    expect(findItem(inCell, "inline-math")).toBeUndefined();
    // The marks a cell CAN carry are still there — this is one omission, not a
    // formatting-free row.
    expect(findItem(inCell, "strikethrough")?.kind).toBe("button");
    expect(findItem(inCell, "code")?.kind).toBe("button");
    expect(findItem(inCell, "edit-link")?.kind).toBe("button");

    // Out of a cell it is offered as before.
    expect(findItem(build(null).layout.more, "inline-math")?.kind).toBe(
      "button",
    );
  });

  it("offers the caret's row and column commands", () => {
    expect(tableMenu(square).options.map((option) => option.id)).toEqual([
      "row-above",
      "row-below",
      "row-delete",
      "column-before",
      "column-after",
      "column-left",
      "column-right",
      "column-delete",
      "align-default",
      "align-left",
      "align-center",
      "align-right",
    ]);
  });

  it("leaves out the delete of a last row or column", () => {
    const oneRow = tableMenu({
      rows: 1,
      columns: 4,
      columnIndex: 1,
      align: null,
    });
    expect(oneRow.options.map((option) => option.id)).not.toContain(
      "row-delete",
    );
    expect(oneRow.options.map((option) => option.id)).toContain(
      "column-delete",
    );

    const oneColumn = tableMenu({
      rows: 4,
      columns: 1,
      columnIndex: 0,
      align: null,
    });
    expect(oneColumn.options.map((option) => option.id)).toContain(
      "row-delete",
    );
    expect(oneColumn.options.map((option) => option.id)).not.toContain(
      "column-delete",
    );
  });

  it("leaves out a move the caret's column cannot make", () => {
    const ids = (table: MobileToolbarTableContext) =>
      tableMenu(table).options.map((option) => option.id);
    // The first column has no left; the last has no right.
    expect(ids({ ...square, columnIndex: 0 })).not.toContain("column-left");
    expect(ids({ ...square, columnIndex: 0 })).toContain("column-right");
    expect(ids({ ...square, columnIndex: 2 })).toContain("column-left");
    expect(ids({ ...square, columnIndex: 2 })).not.toContain("column-right");
    // A lone column goes nowhere at all.
    expect(ids({ rows: 3, columns: 1, columnIndex: 0, align: null })).toEqual(
      expect.not.arrayContaining(["column-left", "column-right"]),
    );
  });

  it("marks the caret column's alignment as the selected option", () => {
    expect(tableMenu(square).selected).toBe("align-default");
    expect(tableMenu({ ...square, align: "center" }).selected).toBe(
      "align-center",
    );
  });

  it("stays open after a command, unlike a one-shot choice", () => {
    expect(tableMenu(square).sticky).toBe(true);

    const blockSwitcher = findItem(build(null).layout.left, "block");
    expect(blockSwitcher?.kind === "menu" && blockSwitcher.sticky).toBeFalsy();
  });

  it("carries the commands into the flat native bar too", () => {
    const native = findItem(build(square).items, "table");
    expect(native?.kind).toBe("menu");
    expect(native?.kind === "menu" && native.options).toHaveLength(12);
  });

  it("dispatches each command at the caret's own cell", () => {
    const actions = Object.fromEntries(
      tableMenu(square).options.map((option) => [option.id, option.action]),
    );
    expect(actions["row-above"]).toEqual({
      type: "table-insert-row",
      side: "before",
    });
    expect(actions["column-after"]).toEqual({
      type: "table-insert-column",
      side: "after",
    });
    expect(actions["row-delete"]).toEqual({ type: "table-delete-row" });
    expect(actions["column-delete"]).toEqual({ type: "table-delete-column" });
    // The move names the index the column ends up at, the engine's own currency.
    expect(actions["column-left"]).toEqual({
      type: "table-move-column",
      to: 0,
    });
    expect(actions["column-right"]).toEqual({
      type: "table-move-column",
      to: 2,
    });
    expect(actions["align-default"]).toEqual({
      type: "table-align",
      align: null,
    });
    expect(actions["align-right"]).toEqual({
      type: "table-align",
      align: "right",
    });
  });
});
