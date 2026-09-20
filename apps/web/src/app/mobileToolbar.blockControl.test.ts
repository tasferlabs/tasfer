import { describe, expect, it } from "vitest";
import {
  createMobileToolbarModel,
  type MobileToolbarItem,
  type MobileToolbarMathContext,
  type MobileToolbarState,
} from "./mobileToolbar";

/** The English fallback is what the model carries when no catalog is loaded. */
const t = (_key: string, fallback?: string) => fallback ?? _key;

const baseState: MobileToolbarState = {
  visible: true,
  bottomInset: 0,
  canUndo: false,
  canRedo: false,
  isBold: false,
  isItalic: false,
  isCode: false,
  isMath: false,
  canOpenMathCommands: false,
  table: null,
  isStrikethrough: false,
  blockType: "paragraph",
  listIndent: 0,
  todoChecked: false,
  linkActive: false,
  canCreateLink: false,
  canRepositionImage: false,
  repositioningImage: false,
  math: null,
};

const math: MobileToolbarMathContext = {
  query: null,
  trigger: null,
  canCaretLeft: true,
  canCaretRight: true,
  matrix: null,
};

function build(state: Partial<MobileToolbarState>) {
  return createMobileToolbarModel({ ...baseState, ...state }, t);
}

/**
 * The block control is whatever occupies the slot right after the always-leading
 * undo/redo — the left zone's first non-divider item, or, when the context puts
 * nothing else there, the scrollable middle's first. Every context fills that
 * slot; which item lands in it is the thing under test.
 */
function blockControl(state: Partial<MobileToolbarState>) {
  const { layout } = build(state);
  const middle = layout.middle.kind === "items" ? layout.middle.items : [];
  const run = [...layout.left, ...middle].filter(
    (item): item is Extract<MobileToolbarItem, { kind: "button" | "menu" }> =>
      item.kind === "button" || item.kind === "menu",
  );
  // Drop the history pair the bar always leads with.
  return run.filter((item) => item.id !== "undo" && item.id !== "redo")[0];
}

// One tap on the block-control slot must always mean the same thing: "show me
// what I can do to the block I'm in". The contents change by context — convert
// this paragraph, act on this table, reposition this image — but a tap never
// fires an action outright in one context and opens a menu in another, because
// nothing on the bar tells the two apart until the panel opens (or doesn't).
describe("the toolbar's block control", () => {
  const contexts: Array<[string, Partial<MobileToolbarState>]> = [
    ["prose", {}],
    ["a heading", { blockType: "heading2" }],
    ["a bullet list", { blockType: "bullet_list" }],
    ["a todo list", { blockType: "todo_list", todoChecked: true }],
    ["a code block", { blockType: "code" }],
    [
      "a table cell",
      { table: { rows: 2, columns: 2, columnIndex: 0, align: null } },
    ],
    ["an image", { blockType: "image" }],
    [
      "a repositionable image",
      { blockType: "image", canRepositionImage: true },
    ],
    ["an equation", { blockType: "math", canOpenMathCommands: true, math }],
    [
      "an equation in a grid",
      {
        blockType: "math",
        canOpenMathCommands: true,
        math: {
          ...math,
          matrix: { env: "pmatrix", rows: 2, cols: 2, row: 0, col: 0 },
        },
      },
    ],
  ];

  it.each(contexts)("opens a menu in %s", (_name, state) => {
    const control = blockControl(state);
    expect(control.kind).toBe("menu");
    // An empty menu is a dead control — every context must offer something.
    if (control.kind === "menu")
      expect(control.options.length).toBeGreaterThan(0);
  });

  it("carries the image's own actions, not the block switcher", () => {
    const control = blockControl({
      blockType: "image",
      canRepositionImage: true,
    });
    if (control.kind !== "menu") throw new Error("not a menu");
    expect(control.options.map((option) => option.id)).toEqual([
      "reposition-image",
      "edit-image",
    ]);
  });

  // Re-entering the mode would re-stamp the origin Cancel restores to, quietly
  // making the pan so far permanent — so the way in leaves while it runs, and
  // the trigger lights up instead to say the mode is on.
  it("drops reposition while the mode is already running", () => {
    const control = blockControl({
      blockType: "image",
      canRepositionImage: true,
      repositioningImage: true,
    });
    if (control.kind !== "menu") throw new Error("not a menu");
    expect(control.options.map((option) => option.id)).toEqual(["edit-image"]);
    expect(control.active).toBe(true);
  });

  it("carries the matrix editor only inside a grid", () => {
    const flat = blockControl({
      blockType: "math",
      canOpenMathCommands: true,
      math,
    });
    if (flat.kind !== "menu") throw new Error("not a menu");
    expect(flat.options.map((option) => option.id)).toEqual(["math-commands"]);

    const grid = blockControl({
      blockType: "math",
      canOpenMathCommands: true,
      math: {
        ...math,
        matrix: { env: "pmatrix", rows: 2, cols: 2, row: 0, col: 0 },
      },
    });
    if (grid.kind !== "menu") throw new Error("not a menu");
    expect(grid.options.map((option) => option.id)).toEqual([
      "math-commands",
      "matrix-editor",
    ]);
  });

  // The matrix editor moved out of the overflow drawer and into the block
  // control, which leaves math with nothing in the long tail — so the overflow
  // trigger disappears and gives the cramped row its width back.
  it("empties the overflow drawer in math", () => {
    expect(
      build({
        blockType: "math",
        canOpenMathCommands: true,
        math: {
          ...math,
          matrix: { env: "pmatrix", rows: 2, cols: 2, row: 0, col: 0 },
        },
      }).layout.more,
    ).toEqual([]);
  });
});
