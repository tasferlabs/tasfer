/**
 * Image resize handles: when they are painted, and — the regression that
 * motivated these tests — when they are reliably *un*-painted.
 *
 * Handles show in three cases (see `ImageNode.drawDragHandles`): a live resize
 * drag, a mouse hover (`ui.imageHover`), or the image being the current visual
 * block selection. The selection case is the one that surfaces handles on touch
 * and keeps them up while a selected image just sits there — so a user can see
 * where to drag without first hovering.
 *
 * The stuck-visible bug: `ui.imageHover` is mouse-only and was only ever cleared
 * by a *later* mousemove over a different block. Once the cursor leaves the
 * canvas (or the device switches to touch) no such move arrives, so the handles
 * stayed painted. Two clears close that gap and are pinned here:
 *   - a `mouseleave` on the canvas drops all hover chrome;
 *   - a touch interaction drops any stale `imageHover` it inherited from a prior
 *     mouse session.
 */

import type { NodeRegionCtx } from "../rendering/nodes";
import { getVisualBlockSelectionIndex } from "../selection";
import type { Block, Page } from "../serlization/loadPage";
import type {
  EditorState,
  ImageHoverState,
  SelectionState,
  ViewportState,
  VisibleBlockRange,
} from "../state-types";
import { createInitialState } from "../state-utils";
import { getEditorStyles } from "../styles";
import { generateNKeysBetween } from "../sync/fractional-index";
import { createChromeRegionRegistry } from "./chromeRegions";
import { handleEvents } from "./events";
import {
  createInteractionSession,
  type InteractionSession,
} from "./interaction-session";
import { handleTouchStart } from "./touchEvents";
import { describe, expect, it } from "vitest";

// The region hit-test consults scrollbar chrome, whose iOS safe-area probe
// appends a measuring node to document.body. The shared headless `document` stub
// omits `body`; supply a no-op one so the touch path runs.
const doc = globalThis.document as unknown as { body?: unknown };
if (!doc.body) {
  doc.body = { appendChild: () => {}, removeChild: () => {} };
}

// `image` is non-textual; `para` here is a fake type absent from the block
// registry, so it reads as textual-content-less — but it stands in for ordinary
// text in these selection-shape tests, so we treat it as the textual case.
function pageOf(types: string[]): Page {
  const keys = generateNKeysBetween(null, null, types.length);
  const blocks = types.map(
    (type, i) =>
      ({
        id: `b${i}`,
        orderKey: keys[i],
        type,
        charRuns: [],
        formats: [],
      }) as unknown as Block,
  );
  return { id: "page", title: "", blocks };
}

// A visual block selection: non-collapsed, anchor === focus, on a non-textual
// block. This is exactly what SELECT_VISUAL_BLOCK / TAP_SELECT_VISUAL_BLOCK emit.
function visualBlockSelection(blockIndex: number): SelectionState {
  const at = { blockIndex, textIndex: 0 };
  return {
    anchor: at,
    focus: at,
    isForward: true,
    isCollapsed: false,
    lastUpdate: 0,
  };
}

function stateWithSelection(
  types: string[],
  selection: SelectionState | undefined,
): EditorState {
  const state = createInitialState(pageOf(types));
  return {
    ...state,
    document: { ...state.document, selection },
  };
}

function hoverOn(blockIndex: number): ImageHoverState {
  return {
    blockIndex,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    hoveredHandle: null,
  };
}

describe("getVisualBlockSelectionIndex", () => {
  it("returns the block index when an image is the visual-block selection", () => {
    const state = stateWithSelection(["image"], visualBlockSelection(0));
    expect(getVisualBlockSelectionIndex(state)).toBe(0);
  });

  it("returns null with no selection", () => {
    const state = stateWithSelection(["image"], undefined);
    expect(getVisualBlockSelectionIndex(state)).toBeNull();
  });

  it("returns null for a collapsed text caret", () => {
    const at = { blockIndex: 0, textIndex: 1 };
    const caret: SelectionState = {
      anchor: at,
      focus: at,
      isForward: true,
      isCollapsed: true,
      lastUpdate: 0,
    };
    const state = stateWithSelection(["para"], caret);
    expect(getVisualBlockSelectionIndex(state)).toBeNull();
  });

  it("returns null for a real (anchor ≠ focus) text range", () => {
    const range: SelectionState = {
      anchor: { blockIndex: 0, textIndex: 0 },
      focus: { blockIndex: 0, textIndex: 3 },
      isForward: true,
      isCollapsed: false,
      lastUpdate: 0,
    };
    const state = stateWithSelection(["para"], range);
    expect(getVisualBlockSelectionIndex(state)).toBeNull();
  });

  it("returns null when the visual-selection shape lands on a textual block", () => {
    // Same encoding, but the block is textual — not an atomic/visual block, so
    // it gets no resize handles.
    const state = stateWithSelection(["heading1"], visualBlockSelection(0));
    expect(getVisualBlockSelectionIndex(state)).toBeNull();
  });
});

describe("readonly documents never surface the resize handles", () => {
  const viewport: ViewportState = {
    width: 600,
    height: 800,
    scrollY: 0,
    documentHeight: 1000,
  };

  // Build the image-resize region for a single full-width image block, plus a
  // point that lands squarely on its left resize handle. A readonly editor must
  // refuse the hit there; an editable one accepts it.
  function imageResizeHitAtLeftHandle(mode?: "readonly"): unknown {
    const page = pageOf(["image"]);
    (page.blocks[0] as unknown as { url: string }).url = "blob:test";
    const state = createInitialState(page, mode ? { mode } : undefined);
    const styles = getEditorStyles(state);
    const { paddingLeft, paddingRight, paddingTop } = styles.canvas;
    const maxWidth = viewport.width - (paddingLeft + paddingRight);

    const node = state.nodes.get("image");
    if (!node?.regions) throw new Error("image node has no regions");
    const c: NodeRegionCtx = {
      block: page.blocks[0],
      blockIndex: 0,
      maxWidth,
      isFirst: true,
      styles,
      marks: state.marks,
      state,
      viewport,
      origin: { x: paddingLeft, y: paddingTop },
    };

    const region = node.regions(c).find((r) => r.id === "image-resize");
    if (!region) throw new Error("no image-resize region");

    // A first full-width image bleeds to box {x:0, y:0}; the left handle bar is
    // inset from the left edge and vertically centered.
    const { vertical } = styles.imageResize.dragHandles;
    const imageHeight = styles.blocks.image.dimensions.height;
    const point = {
      x: vertical.inset + vertical.thickness / 2,
      y: imageHeight / 2,
    };
    return region.hitTest(point, "mouse");
  }

  it("an editable editor resolves the left handle under the pointer", () => {
    expect(imageResizeHitAtLeftHandle()).not.toBeNull();
  });

  it("a readonly editor resolves no handle (resize stays inert)", () => {
    expect(imageResizeHitAtLeftHandle("readonly")).toBeNull();
  });
});

describe("stale image-hover handles are cleared when the pointer leaves", () => {
  const viewport: ViewportState = {
    width: 600,
    height: 800,
    scrollY: 0,
    documentHeight: 1000,
  };
  const visibility: VisibleBlockRange = { start: 0, end: 0, startY: 0 };

  function withHover(): { state: EditorState; session: InteractionSession } {
    const base = createInitialState(pageOf(["image"]));
    const state: EditorState = {
      ...base,
      ui: { ...base.ui, imageHover: hoverOn(0) },
    };
    return {
      state,
      session: createInteractionSession(createChromeRegionRegistry()),
    };
  }

  it("a canvas mouseleave drops imageHover (and sibling hovers)", () => {
    const { state, session } = withHover();
    expect(state.ui.imageHover).not.toBeNull();

    const next = handleEvents(
      state,
      viewport,
      visibility,
      [{ type: "mouseleave" } as unknown as Event],
      viewport.documentHeight,
      { left: 0, top: 0 },
      session,
    ).state;

    expect(next.ui.imageHover).toBeNull();
  });

  it("a mouseleave onto the hover toolbar keeps imageHover (the cursor is reaching it, not leaving)", () => {
    // The download / edit buttons are a pointer-events-auto DOM overlay the host
    // renders on top of the image. Moving the cursor from the image onto a button
    // fires this very canvas mouseleave — the reported bug was that clearing
    // imageHover here unmounted the buttons before the click could land. The host
    // marks its overlay layer `data-editor-overlay`, so a mouseleave whose
    // relatedTarget resolves inside that layer must leave imageHover intact.
    const { state, session } = withHover();
    const relatedTarget = {
      closest: (selector: string) =>
        selector === "[data-editor-overlay]" ? { tag: "overlay" } : null,
    };

    const next = handleEvents(
      state,
      viewport,
      visibility,
      [{ type: "mouseleave", relatedTarget } as unknown as Event],
      viewport.documentHeight,
      { left: 0, top: 0 },
      session,
    ).state;

    expect(next.ui.imageHover).toEqual(state.ui.imageHover);
  });

  it("a mouseleave onto unrelated DOM still drops imageHover", () => {
    // relatedTarget exists but is not within the editor's overlay layer (e.g. the
    // sidebar) — a real exit, so the hover chrome clears as before.
    const { state, session } = withHover();
    const relatedTarget = { closest: () => null };

    const next = handleEvents(
      state,
      viewport,
      visibility,
      [{ type: "mouseleave", relatedTarget } as unknown as Event],
      viewport.documentHeight,
      { left: 0, top: 0 },
      session,
    ).state;

    expect(next.ui.imageHover).toBeNull();
  });

  it("a canvas mouseleave keeps linkHover (interactive popover the host owns)", () => {
    // The link tooltip is a pointer-events-auto DOM popover: the pointer
    // crossing from the canvas onto it fires this very mouseleave. Clearing here
    // would unmount the popover before the cursor could reach it (the reported
    // bug). Its dismissal is host-owned (the popover clears it on pointer-leave),
    // so mouseleave must leave linkHover intact while dropping sibling hovers.
    const base = createInitialState(pageOf(["image"]));
    const state: EditorState = {
      ...base,
      ui: {
        ...base.ui,
        imageHover: hoverOn(0),
        linkHover: {
          position: { blockIndex: 0, textIndex: 0 },
          url: "https://example.com",
          text: "example",
          x: 10,
          y: 20,
          startIndex: 0,
          endIndex: 7,
        },
      },
    };
    const session = createInteractionSession(createChromeRegionRegistry());

    const next = handleEvents(
      state,
      viewport,
      visibility,
      [{ type: "mouseleave" } as unknown as Event],
      viewport.documentHeight,
      { left: 0, top: 0 },
      session,
    ).state;

    expect(next.ui.imageHover).toBeNull();
    expect(next.ui.linkHover).toEqual(state.ui.linkHover);
  });

  it("a touch interaction drops a stale (mouse-set) imageHover", () => {
    const { state, session } = withHover();
    expect(state.ui.imageHover).not.toBeNull();

    const touchEvent = {
      touches: [{ clientX: 50, clientY: 50, radiusX: 8, radiusY: 8 }],
    } as unknown as TouchEvent;

    const next = handleTouchStart(
      state,
      viewport,
      touchEvent,
      { left: 0, top: 0 },
      viewport.documentHeight,
      session,
      visibility,
    );

    expect(next.ui.imageHover).toBeNull();
  });
});
