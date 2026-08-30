import type { EditorState } from "../state-types";
import { createChromeRegionRegistry } from "./chromeRegions";
import type { Region, RegionCtx } from "./regions";
import { beforeEach, describe, expect, it, vi } from "vitest";

// scrollToMakeCursorVisible needs a fully laid-out document to compute a real
// scroll offset; stub it so the fallback path is observable with a minimal ctx.
vi.mock("../selection", async (importActual) => {
  const actual = await importActual<typeof import("../selection")>();
  return {
    ...actual,
    scrollToMakeCursorVisible: vi.fn(() => 123),
    // A nested caret's coordinates likewise need a laid-out document; the span
    // maths on top of them stays real, so the fallback's arithmetic is pinned.
    getContentPointDocumentCoords: vi.fn(() => ({ x: 0, y: 5000, height: 20 })),
  };
});
import {
  getContentPointDocumentCoords,
  scrollToMakeCursorVisible,
} from "../selection";
import type { ContentPoint } from "../structured-selection";

function peerIndicatorRegion(): Region {
  const region = createChromeRegionRegistry()
    .all()
    .find((r) => r.id === "peer-indicator");
  if (!region) throw new Error("peer-indicator region not registered");
  return region;
}

// withScrollbarInteraction (run by onTap) only touches view.scrollbar.
function baseState(): EditorState {
  return {
    view: { scrollbar: { lastInteraction: 0 } },
  } as unknown as EditorState;
}

describe("peer-indicator region onTap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes the click through the corrected scroll hook so it lands on the peer's exact caret", () => {
    const scrollPositionIntoView = vi.fn();
    const updateViewport = vi.fn();
    const target = { blockIndex: 7, textIndex: 3 };
    const ctx = {
      state: baseState(),
      viewport: { scrollY: 0, height: 600 },
      scrollPositionIntoView,
      updateViewport,
    } as unknown as RegionCtx;

    peerIndicatorRegion().onTap!(target, { x: 0, y: 0 }, 1, ctx);

    expect(scrollPositionIntoView).toHaveBeenCalledWith(target, undefined);
    // The corrected path is exclusive — no second, estimate-only scroll fires.
    expect(updateViewport).not.toHaveBeenCalled();
    expect(scrollToMakeCursorVisible).not.toHaveBeenCalled();
  });

  it("hands the correction hook a peer's nested address, which a flat position cannot carry", () => {
    const scrollPositionIntoView = vi.fn();
    const contentPoint = {
      kind: "text",
      blockId: "b1",
      contentId: "b1:content",
      nodeId: "cell-3",
      field: "text",
      afterCharId: null,
      affinity: "forward",
    } as ContentPoint;
    const target = { blockIndex: 7, textIndex: 0, contentPoint };
    const ctx = {
      state: baseState(),
      viewport: { scrollY: 0, height: 600 },
      scrollPositionIntoView,
      updateViewport: vi.fn(),
    } as unknown as RegionCtx;

    peerIndicatorRegion().onTap!(target, { x: 0, y: 0 }, 1, ctx);

    expect(scrollPositionIntoView).toHaveBeenCalledWith(target, contentPoint);
  });

  it("scrolls to a peer's nested caret from its own coordinates with no hook", () => {
    // The flat path would resolve nothing here: the block a table cell belongs
    // to has no text to index, so the point resolves its own coordinates.
    const updateViewport = vi.fn();
    const target = {
      blockIndex: 7,
      textIndex: 0,
      contentPoint: {
        kind: "text",
        blockId: "b1",
        contentId: "b1:content",
        nodeId: "cell-3",
        field: "text",
        afterCharId: null,
        affinity: "forward",
      } as ContentPoint,
    };
    const ctx = {
      state: baseState(),
      viewport: { scrollY: 0, height: 600 },
      updateViewport,
    } as unknown as RegionCtx;

    peerIndicatorRegion().onTap!(target, { x: 0, y: 0 }, 1, ctx);

    expect(getContentPointDocumentCoords).toHaveBeenCalled();
    expect(scrollToMakeCursorVisible).not.toHaveBeenCalled();
    // 5020 (the caret's bottom) - 600 (viewport) + 40 (margin).
    expect(updateViewport).toHaveBeenCalledWith({ scrollY: 4460 });
  });

  it("falls back to a one-shot make-visible scroll when no correction hook is present", () => {
    const updateViewport = vi.fn();
    const target = { blockIndex: 2, textIndex: 0 };
    const ctx = {
      state: baseState(),
      viewport: { scrollY: 0, height: 600 },
      updateViewport,
    } as unknown as RegionCtx;

    peerIndicatorRegion().onTap!(target, { x: 0, y: 0 }, 1, ctx);

    expect(scrollToMakeCursorVisible).toHaveBeenCalled();
    expect(updateViewport).toHaveBeenCalledWith({ scrollY: 123 });
  });
});
