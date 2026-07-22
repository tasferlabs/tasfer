/**
 * The link hover tooltip's keep-open hysteresis must hit-test the pointer in the
 * same canvas/container space the anchor is stored in. Regression: it used to
 * compare the stored anchor (canvas space, no `containerRect` baked in) against
 * the raw viewport pointer coords, so once the editor canvas wasn't at the
 * viewport origin the keep-open box sat offset from the painted tooltip and the
 * popover cleared the instant the pointer left the link glyph — you could never
 * reach it to click "open"/"edit".
 */

import { POINTER_MOVE } from "../../actions/pointer-actions";
import type { Page } from "../../serlization/loadPage";
import type {
  EditorState,
  LinkHoverState,
  ViewportState,
} from "../../state-types";
import { createInitialState } from "../../state-utils";
import { describe, expect, it } from "vitest";

const viewport: ViewportState = {
  width: 600,
  height: 800,
  scrollY: 0,
  documentHeight: 1000,
};

function page(): Page {
  return {
    id: "page-1",
    title: "Links",
    blocks: [
      {
        id: "block-1",
        orderKey: "a0",
        deleted: false,
        type: "paragraph",
        charRuns: [{ peerId: "peer", startCounter: 0, text: "see example" }],
        formats: [],
      },
    ],
  };
}

// Anchor in canvas space, well away from the viewport origin so a viewport-space
// hit-test would land outside the keep-open box.
const HOVER: LinkHoverState = {
  position: { blockIndex: 0, textIndex: 4 },
  url: "https://example.com",
  text: "example",
  x: 320,
  y: 240,
  startIndex: 4,
  endIndex: 11,
};

function withHover(): EditorState {
  const state = createInitialState(page());
  return { ...state, ui: { ...state.ui, linkHover: HOVER } };
}

// Pointer not over a link (textPosition null) — the hysteresis decides.
function move(
  state: EditorState,
  canvasX: number,
  canvasY: number,
): EditorState {
  return state.actionBus.dispatchState(POINTER_MOVE, state, {
    canvasX,
    canvasY,
    textPosition: null,
    blockUnderPoint: null,
    atomicBlock: null,
    viewport,
    resolveCoords: () => null,
    modifiers: { ctrlOrMeta: false },
  }).state;
}

describe("link hover keep-open hysteresis", () => {
  it("keeps the tooltip open while the pointer is over the tooltip box", () => {
    // Inside the box [320..620] x [240..360] in canvas space.
    const next = move(withHover(), 360, 270);
    expect(next.ui.linkHover).toEqual(HOVER);
  });

  it("clears the tooltip once the pointer leaves the tooltip box", () => {
    // Left of and above the box — genuinely off the tooltip.
    const next = move(withHover(), 100, 100);
    expect(next.ui.linkHover).toBeNull();
  });
});
