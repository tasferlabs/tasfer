/**
 * Regression: a drag that STARTS in the page padding must select.
 *
 * Pressing in the left/right gutter or the top margin used to only place the
 * caret (or just clear the selection) and leave the editor in `edit` mode, so
 * the mousemoves that followed were treated as plain hovers — the sweep down a
 * paragraph's edge, the most natural place to start one, selected nothing.
 * The padding press now anchors a selection and enters `select` mode, exactly
 * like a press inside the text column.
 */
import { getBlockHeight } from "../rendering/renderer";
import { loadPage } from "../serlization/loadPage";
import type {
  EditorState,
  MouseEvent as EditorMouseEvent,
  ViewportState,
} from "../state-types";
import { createInitialState } from "../state-utils";
import { getEditorStyles } from "../styles";
import { createChromeRegionRegistry } from "./chromeRegions";
import { handleEvents } from "./events";
import { createInteractionSession } from "./interaction-session";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  const d = (globalThis as unknown as { document: Record<string, unknown> })
    .document;
  if (!d.body) d.body = { appendChild: () => {}, removeChild: () => {} };
});

// Short paragraphs so each block owns one line: vertical hit-testing is exact
// in the test environment even though horizontal text measurement is not.
const MD = ["# Title", "AAA", "BBB", "CCC", "DDD", "EEE"].join("\n\n");

const viewport: ViewportState = {
  width: 800,
  height: 1000,
  scrollY: 0,
  documentHeight: 2000,
};

function mouse(type: string, x: number, y: number): EditorMouseEvent {
  return {
    type,
    x,
    y,
    button: 0,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    preventDefault: () => {},
    stopPropagation: () => {},
  };
}

/** Canvas-y at the middle of a block's band, at scroll 0. */
function blockMidY(state: EditorState, blockIndex: number): number {
  const styles = getEditorStyles(state);
  const maxWidth =
    viewport.width - (styles.canvas.paddingLeft + styles.canvas.paddingRight);
  const blocks = state.view.visibleBlocks;
  let y = styles.canvas.paddingTop;
  for (let i = 0; i < blocks.length; i++) {
    const height = getBlockHeight(
      state.nodes,
      state.marks,
      blocks[i],
      maxWidth,
      styles,
      i === 0,
    );
    if (blocks[i].originalIndex === blockIndex) return y + height / 2;
    y += height;
  }
  throw new Error(`block ${blockIndex} is not visible`);
}

function drag(
  state: EditorState,
  from: { x: number; y: number },
  to: { x: number; y: number },
): EditorState {
  const session = createInteractionSession(createChromeRegionRegistry());
  const styles = getEditorStyles(state);
  const visibility = {
    start: 0,
    end: state.view.visibleBlocks.length - 1,
    startY: styles.canvas.paddingTop,
    scrollY: 0,
  };
  return handleEvents(
    state,
    viewport,
    visibility,
    [
      mouse("mousedown", from.x, from.y),
      mouse("mousemove", to.x, to.y),
    ] as never,
    viewport.documentHeight,
    { left: 0, top: 0 },
    session,
  ).state;
}

describe("drag started in the page padding", () => {
  it("selects when the press lands in the side gutter", () => {
    const state = createInitialState(loadPage(MD));
    // x = 10 sits inside the 40px left gutter, left of the text column.
    const after = drag(
      state,
      { x: 10, y: blockMidY(state, 2) },
      { x: 200, y: blockMidY(state, 4) },
    );

    const selection = after.document.selection;
    expect(selection?.isCollapsed).toBe(false);
    expect(selection?.anchor.blockIndex).toBe(2);
    expect(selection?.focus.blockIndex).toBe(4);
    expect(after.ui.mode).toBe("select");
  });

  it("keeps extending while the drag stays in the gutter", () => {
    const state = createInitialState(loadPage(MD));
    const after = drag(
      state,
      { x: 10, y: blockMidY(state, 1) },
      { x: 10, y: blockMidY(state, 3) },
    );

    const selection = after.document.selection;
    expect(selection?.isCollapsed).toBe(false);
    expect(selection?.anchor.blockIndex).toBe(1);
    expect(selection?.focus.blockIndex).toBe(3);
  });

  it("selects from the document start when the press lands in the top margin", () => {
    const state = createInitialState(loadPage(MD));
    // Above the first block (paddingTop is 4).
    const after = drag(
      state,
      { x: 200, y: 1 },
      { x: 200, y: blockMidY(state, 3) },
    );

    const selection = after.document.selection;
    expect(selection?.isCollapsed).toBe(false);
    expect(selection?.anchor).toEqual({ blockIndex: 0, textIndex: 0 });
    expect(selection?.focus.blockIndex).toBe(3);
  });
});
