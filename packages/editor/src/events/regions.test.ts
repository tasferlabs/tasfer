import type { EditorState } from "../state-types";
import {
  type Region,
  type RegionCtx,
  routeCapturedCancel,
  routeCapturedEnd,
} from "./regions";
import { describe, expect, it, vi } from "vitest";

// Minimal session/ctx doubles: these tests only exercise capture release
// ordering, so most of EditorState/InteractionSession is irrelevant.
function makeCtx(region: Region, hit: unknown) {
  const session = {
    captured: { region, hit },
  } as unknown as RegionCtx["session"];
  const state = { marker: "state" } as unknown as EditorState;
  const ctx = { state, session } as unknown as RegionCtx;
  return { ctx, session };
}

const baseDrag = {
  onStart: () => null,
  onMove: () => null,
  onEnd: () => null,
  onCancel: (ctx: RegionCtx) => ctx.state,
};

describe("routeCapturedEnd", () => {
  it("keeps session.captured populated while onEnd runs, then clears it", () => {
    let capturedDuringEnd: unknown = "unset";
    const region: Region = {
      id: "drag-region",
      priority: 1,
      hitTest: () => null,
      drag: {
        ...baseDrag,
        // A node drag (e.g. image resize) reads its start descriptor back off
        // session.captured.hit during onEnd. If the capture were released
        // first, this would be undefined and the drag would drop its ops.
        onEnd(_p, ctx) {
          capturedDuringEnd = ctx.session.captured?.hit;
          return { state: ctx.state, ops: [] };
        },
      },
    };
    const { ctx, session } = makeCtx(region, { handle: "right" });

    routeCapturedEnd(null, ctx);

    expect(capturedDuringEnd).toEqual({ handle: "right" });
    // Released afterward so the next pointer-down starts fresh.
    expect(session.captured).toBeNull();
  });
});

describe("routeCapturedCancel", () => {
  it("keeps session.captured populated while onCancel runs, then clears it", () => {
    let capturedDuringCancel: unknown = "unset";
    const region: Region = {
      id: "drag-region",
      priority: 1,
      hitTest: () => null,
      drag: {
        ...baseDrag,
        onCancel(ctx) {
          capturedDuringCancel = ctx.session.captured?.hit;
          return ctx.state;
        },
      },
    };
    const { ctx, session } = makeCtx(region, { handle: "bottom" });

    routeCapturedCancel(ctx);

    expect(capturedDuringCancel).toEqual({ handle: "bottom" });
    expect(session.captured).toBeNull();
  });

  it("clears the capture even when the captured region has no drag spec", () => {
    const onCancel = vi.fn();
    const region = {
      id: "tap-region",
      priority: 1,
      hitTest: () => null,
    } as unknown as Region;
    const { ctx, session } = makeCtx(region, null);

    expect(routeCapturedCancel(ctx)).toBeNull();
    expect(session.captured).toBeNull();
    expect(onCancel).not.toHaveBeenCalled();
  });
});
