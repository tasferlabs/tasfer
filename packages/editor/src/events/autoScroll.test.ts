import {
  EDGE_SCROLL_MAX_SPEED,
  EDGE_SCROLL_SPEED,
  EDGE_SCROLL_THRESHOLD,
} from "../constants";
import { edgeScrollDelta } from "./autoScroll";
import { describe, expect, it } from "vitest";

const VIEWPORT_HEIGHT = 800;

function accelerated(elapsedMs = 0) {
  return { accelerate: true, elapsedMs };
}
function constant() {
  return { accelerate: false, elapsedMs: 0 };
}

describe("edgeScrollDelta", () => {
  it("returns 0 away from both edges", () => {
    const mid = VIEWPORT_HEIGHT / 2;
    expect(edgeScrollDelta(mid, VIEWPORT_HEIGHT, accelerated())).toBe(0);
    expect(edgeScrollDelta(mid, VIEWPORT_HEIGHT, constant())).toBe(0);
    // Exactly at the threshold boundary is still outside the scroll zone
    expect(
      edgeScrollDelta(EDGE_SCROLL_THRESHOLD, VIEWPORT_HEIGHT, constant()),
    ).toBe(0);
    expect(
      edgeScrollDelta(
        VIEWPORT_HEIGHT - EDGE_SCROLL_THRESHOLD,
        VIEWPORT_HEIGHT,
        constant(),
      ),
    ).toBe(0);
  });

  it("scrolls up near the top edge, down near the bottom edge", () => {
    expect(
      edgeScrollDelta(EDGE_SCROLL_THRESHOLD / 2, VIEWPORT_HEIGHT, constant()),
    ).toBeLessThan(0);
    expect(
      edgeScrollDelta(
        VIEWPORT_HEIGHT - EDGE_SCROLL_THRESHOLD / 2,
        VIEWPORT_HEIGHT,
        constant(),
      ),
    ).toBeGreaterThan(0);
  });

  it("scales with proximity inside the edge zone", () => {
    const nearEdge = edgeScrollDelta(1, VIEWPORT_HEIGHT, constant());
    const nearThreshold = edgeScrollDelta(
      EDGE_SCROLL_THRESHOLD - 1,
      VIEWPORT_HEIGHT,
      constant(),
    );
    expect(Math.abs(nearEdge)).toBeGreaterThan(Math.abs(nearThreshold));
  });

  it("uses constant base speed outside the viewport when not accelerating", () => {
    // Image resize behavior: overshoot distance does not increase speed
    expect(edgeScrollDelta(-5, VIEWPORT_HEIGHT, constant())).toBe(
      -EDGE_SCROLL_SPEED,
    );
    expect(edgeScrollDelta(-500, VIEWPORT_HEIGHT, constant())).toBe(
      -EDGE_SCROLL_SPEED,
    );
    expect(
      edgeScrollDelta(VIEWPORT_HEIGHT + 500, VIEWPORT_HEIGHT, constant()),
    ).toBe(EDGE_SCROLL_SPEED);
  });

  it("scales with overshoot distance when accelerating, capped at 4x", () => {
    const small = edgeScrollDelta(-10, VIEWPORT_HEIGHT, accelerated());
    const large = edgeScrollDelta(-200, VIEWPORT_HEIGHT, accelerated());
    expect(Math.abs(large)).toBeGreaterThan(Math.abs(small));
    // Distance boost caps at 1 + 3
    expect(edgeScrollDelta(-300, VIEWPORT_HEIGHT, accelerated())).toBe(
      edgeScrollDelta(-10_000, VIEWPORT_HEIGHT, accelerated()),
    );
  });

  it("ramps up over time when accelerating, capped at EDGE_SCROLL_MAX_SPEED", () => {
    const atStart = edgeScrollDelta(-5, VIEWPORT_HEIGHT, accelerated(0));
    const later = edgeScrollDelta(-5, VIEWPORT_HEIGHT, accelerated(2000));
    expect(Math.abs(later)).toBeGreaterThan(Math.abs(atStart));

    // The time multiplier alone never exceeds MAX/BASE
    const muchLater = edgeScrollDelta(
      EDGE_SCROLL_THRESHOLD / 2,
      VIEWPORT_HEIGHT,
      accelerated(60_000),
    );
    expect(Math.abs(muchLater)).toBeLessThanOrEqual(EDGE_SCROLL_MAX_SPEED);
  });

  it("ignores elapsed time when not accelerating", () => {
    expect(
      edgeScrollDelta(-5, VIEWPORT_HEIGHT, {
        accelerate: false,
        elapsedMs: 60_000,
      }),
    ).toBe(-EDGE_SCROLL_SPEED);
  });
});
