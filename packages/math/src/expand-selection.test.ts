/**
 * Expand / shrink selection inside a display equation: each press climbs one
 * nesting level of the formula (symbol → slot → construct → … → equation),
 * then the document; shrink walks the same rungs back down.
 */
import { mathExtension } from "./math-extension";
import { getMathStructuredDocument } from "./structured";
import {
  mathContentSelectionFromSourceOffset,
  mathSourceRangeFromContentSelection,
} from "./tree-selection";
import {
  EXPAND_SELECTION,
  SHRINK_SELECTION,
} from "@tasfer/editor/actions/selection-expansion";
import { handleKeyDown } from "@tasfer/editor/events/keysEvents";
import { createMarkRegistry } from "@tasfer/editor/rendering/marks";
import { createNodeRegistry } from "@tasfer/editor/rendering/nodes";
import { baseSchema } from "@tasfer/editor/schema";
import { loadPage } from "@tasfer/editor/serlization/loadPage";
import type { EditorState, ViewportState } from "@tasfer/editor/state-types";
import { createInitialState } from "@tasfer/editor/state-utils";
import { updateContentSelection } from "@tasfer/editor/structured-selection";
import { afterEach, describe, expect, it, vi } from "vitest";

const schema = baseSchema.use(mathExtension());
const LATEX = "x+\\frac{a+b}{c}";

function equation(latex: string, caretAt: number): EditorState {
  const page = loadPage(`$$\n${latex}\n$$\n\nafter`, schema.data);
  const state = createInitialState(page, {
    schema: schema.data,
    nodes: createNodeRegistry(schema.nodes),
    marks: createMarkRegistry(schema.marks),
  });
  const block = state.document.page.blocks[0];
  const document = getMathStructuredDocument(block as never)!;
  const caret = mathContentSelectionFromSourceOffset(
    block.id,
    document.rootId,
    document,
    caretAt,
  )!;
  return updateContentSelection(state, caret);
}

/** The selected slice of the equation's source, or the document span. */
function selected(state: EditorState, latex: string): string {
  const content = state.document.contentSelection;
  if (content) {
    const document = getMathStructuredDocument(
      state.document.page.blocks[0] as never,
    )!;
    const range = mathSourceRangeFromContentSelection(document, content);
    return range ? latex.slice(range.from, range.to) : "";
  }
  const sel = state.document.selection!;
  return `blocks ${sel.anchor.blockIndex}–${sel.focus.blockIndex}`;
}

function expand(s: EditorState) {
  return s.actionBus.dispatchState(EXPAND_SELECTION, s).state;
}
function shrink(s: EditorState) {
  return s.actionBus.dispatchState(SHRINK_SELECTION, s).state;
}

describe("display math — expand selection", () => {
  it("climbs symbol → numerator → fraction → equation → document", () => {
    let state = equation(LATEX, LATEX.indexOf("+b"));
    const rungs: string[] = [];
    for (let i = 0; i < 5; i++) {
      state = expand(state);
      rungs.push(selected(state, LATEX));
    }
    const last = state.document.page.blocks.length - 1;
    expect(rungs).toEqual([
      "+",
      "a+b",
      "\\frac{a+b}{c}",
      LATEX,
      `blocks 0–${last}`,
    ]);
  });

  it("shrinks back down the same rungs to the caret", () => {
    const start = equation(LATEX, LATEX.indexOf("+b"));
    let state = start;
    for (let i = 0; i < 4; i++) state = expand(state);
    expect(selected(state, LATEX)).toBe(LATEX);

    state = shrink(state);
    expect(selected(state, LATEX)).toBe("\\frac{a+b}{c}");
    state = shrink(state);
    expect(selected(state, LATEX)).toBe("a+b");
    state = shrink(state);
    expect(selected(state, LATEX)).toBe("+");
    state = shrink(state);
    expect(state.document.contentSelection).toEqual(
      start.document.contentSelection,
    );
  });

  it("takes the next level up from a range the user selected", () => {
    const base = equation(LATEX, 0);
    const document = getMathStructuredDocument(
      base.document.page.blocks[0] as never,
    )!;
    const blockId = base.document.page.blocks[0].id;
    const from = mathContentSelectionFromSourceOffset(
      blockId,
      document.rootId,
      document,
      LATEX.indexOf("+b"),
    )!;
    const to = mathContentSelectionFromSourceOffset(
      blockId,
      document.rootId,
      document,
      LATEX.indexOf("b") + 1,
    )!;
    const partial = updateContentSelection(base, {
      anchor: from.focus,
      focus: to.focus,
      lastUpdate: 0,
    });
    expect(selected(partial, LATEX)).toBe("+b");
    expect(selected(expand(partial), LATEX)).toBe("a+b");
  });
});

describe("expand / shrink selection keys", () => {
  afterEach(() => vi.unstubAllGlobals());

  const viewport: ViewportState = {
    width: 800,
    height: 600,
    scrollY: 0,
    documentHeight: 2_000,
  };

  function press(
    state: EditorState,
    key: "ArrowRight" | "ArrowLeft",
    mods: { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean },
  ): EditorState {
    const event = {
      key,
      code: key,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: true,
      ...mods,
      repeat: false,
      isComposing: false,
      isTrusted: true,
      preventDefault() {},
      stopPropagation() {},
    } as unknown as Event;
    const focused = { ...state, view: { ...state.view, isFocused: true } };
    return handleKeyDown(focused, viewport, event).state;
  }

  it("⌃⇧⌘→ expands and ⌃⇧⌘← shrinks on Apple", () => {
    vi.stubGlobal("navigator", { platform: "MacIntel", userAgent: "Mac" });
    const start = equation(LATEX, LATEX.indexOf("+b"));
    const grown = press(start, "ArrowRight", { ctrlKey: true, metaKey: true });
    expect(selected(grown, LATEX)).toBe("+");
    const twice = press(grown, "ArrowRight", { ctrlKey: true, metaKey: true });
    expect(selected(twice, LATEX)).toBe("a+b");
    const back = press(twice, "ArrowLeft", { ctrlKey: true, metaKey: true });
    expect(selected(back, LATEX)).toBe("+");
  });

  it("Shift+Alt+→ expands and Shift+Alt+← shrinks elsewhere", () => {
    vi.stubGlobal("navigator", { platform: "Win32", userAgent: "Windows" });
    const start = equation(LATEX, LATEX.indexOf("+b"));
    const grown = press(start, "ArrowRight", { altKey: true });
    expect(selected(grown, LATEX)).toBe("+");
    const back = press(grown, "ArrowLeft", { altKey: true });
    expect(back.document.contentSelection).toEqual(
      start.document.contentSelection,
    );
  });
});
