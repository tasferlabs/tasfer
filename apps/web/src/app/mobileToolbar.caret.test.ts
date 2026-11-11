import { describe, expect, it } from "vitest";
import {
  createMobileToolbarModel,
  type MobileToolbarItem,
  type MobileToolbarMathContext,
} from "./mobileToolbar";

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
  table: null,
  isStrikethrough: false,
  blockType: "paragraph" as const,
  listIndent: 0,
  todoChecked: false,
  linkActive: false,
  canCreateLink: false,
  canRepositionImage: false,
  repositioningImage: false,
  caretTouchesMark: false,
  math: null as MobileToolbarMathContext | null,
};

function ids(items: MobileToolbarItem[]) {
  return items.map((item) => item.id);
}

describe("the toolbar's caret steps", () => {
  it("show in prose only while the caret touches marked text", () => {
    const plain = createMobileToolbarModel(baseState, t).layout;
    expect(plain.middle).toEqual({ kind: "items", items: [] });

    // In the middle, after the format marks.
    const marked = createMobileToolbarModel(
      { ...baseState, caretTouchesMark: true },
      t,
    ).layout;
    expect(marked.middle.kind).toBe("items");
    if (marked.middle.kind !== "items") return;
    expect(ids(marked.middle.items)).toEqual(["caret-left", "caret-right"]);
    expect(ids(marked.left)).not.toContain("caret-left");
  });

  it("show in a list item's row beside the indent controls", () => {
    const list = createMobileToolbarModel(
      { ...baseState, blockType: "bullet_list", caretTouchesMark: true },
      t,
    ).layout;
    expect(list.middle.kind).toBe("items");
    if (list.middle.kind !== "items") return;
    expect(ids(list.middle.items)).toContain("caret-right");
  });

  it("keep the math steps' edge state", () => {
    const math = createMobileToolbarModel(
      {
        ...baseState,
        math: {
          query: null,
          trigger: null,
          canCaretLeft: false,
          canCaretRight: true,
          matrix: null,
        },
      },
      t,
    ).layout;
    const left = math.left.find((item) => item.id === "caret-left");
    expect(left?.kind === "button" && left.enabled).toBe(false);
  });
});
