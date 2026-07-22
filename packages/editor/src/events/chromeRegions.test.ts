import type { EditorState } from "../state-types";
import { createChromeRegionRegistry } from "./chromeRegions";
import type { Region, RegionCtx } from "./regions";
import { describe, expect, it, vi } from "vitest";

// scrollToMakeCursorVisible needs a fully laid-out document to compute a real
// scroll offset; stub it so the fallback path is observable with a minimal ctx.
vi.mock("../selection", async (importActual) => {
  const actual = await importActual<typeof import("../selection")>();
  return { ...actual, scrollToMakeCursorVisible: vi.fn(() => 123) };
});
import { scrollToMakeCursorVisible } from "../selection";

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

    expect(scrollPositionIntoView).toHaveBeenCalledWith(target);
    // The corrected path is exclusive — no second, estimate-only scroll fires.
    expect(updateViewport).not.toHaveBeenCalled();
    expect(scrollToMakeCursorVisible).not.toHaveBeenCalled();
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
