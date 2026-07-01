import { caretLandingProgress, caretLandingShape } from "./caret-landing";
import { describe, expect, it } from "vitest";

describe("caretLandingProgress", () => {
  it("is 0 before and at the start", () => {
    expect(caretLandingProgress(100, 100, 200)).toBe(0);
    expect(caretLandingProgress(90, 100, 200)).toBe(0);
  });

  it("advances linearly through the duration", () => {
    expect(caretLandingProgress(200, 100, 200)).toBeCloseTo(0.5);
  });

  it("clamps to 1 once the duration elapses", () => {
    expect(caretLandingProgress(300, 100, 200)).toBe(1);
    expect(caretLandingProgress(500, 100, 200)).toBe(1);
  });

  it("treats a non-positive duration as finished (disabled)", () => {
    expect(caretLandingProgress(100, 100, 0)).toBe(1);
    expect(caretLandingProgress(150, 100, -5)).toBe(1);
  });
});

describe("caretLandingShape", () => {
  const WIDTH = 2;
  const HEIGHT = 20;
  const RADIUS = 6;

  it("starts as a circle of the configured radius", () => {
    const shape = caretLandingShape(0, WIDTH, HEIGHT, RADIUS);
    expect(shape.halfWidth).toBeCloseTo(RADIUS);
    expect(shape.halfHeight).toBeCloseTo(RADIUS);
    // Equal half-extents + radius == half-extent ⇒ a circle.
    expect(shape.cornerRadius).toBeCloseTo(shape.halfWidth);
  });

  it("clamps the starting circle to half the caret height", () => {
    const shortHeight = 8;
    const shape = caretLandingShape(0, WIDTH, shortHeight, RADIUS);
    expect(shape.halfWidth).toBeCloseTo(shortHeight / 2);
    expect(shape.halfHeight).toBeCloseTo(shortHeight / 2);
  });

  it("ends as the caret bar", () => {
    const shape = caretLandingShape(1, WIDTH, HEIGHT, RADIUS);
    expect(shape.halfWidth).toBeCloseTo(WIDTH / 2);
    expect(shape.halfHeight).toBeCloseTo(HEIGHT / 2);
    expect(shape.cornerRadius).toBeCloseTo(WIDTH / 2);
  });

  it("squishes horizontally while stretching vertically as it morphs", () => {
    const a = caretLandingShape(0.25, WIDTH, HEIGHT, RADIUS);
    const b = caretLandingShape(0.75, WIDTH, HEIGHT, RADIUS);
    // Width shrinks toward the bar; height grows toward the bar.
    expect(b.halfWidth).toBeLessThan(a.halfWidth);
    expect(b.halfHeight).toBeGreaterThan(a.halfHeight);
    // The capsule radius always tracks the half-width so the ends stay rounded.
    expect(a.cornerRadius).toBeCloseTo(a.halfWidth);
    expect(b.cornerRadius).toBeCloseTo(b.halfWidth);
  });

  it("clamps out-of-range progress", () => {
    expect(caretLandingShape(-1, WIDTH, HEIGHT, RADIUS)).toEqual(
      caretLandingShape(0, WIDTH, HEIGHT, RADIUS),
    );
    expect(caretLandingShape(2, WIDTH, HEIGHT, RADIUS)).toEqual(
      caretLandingShape(1, WIDTH, HEIGHT, RADIUS),
    );
  });
});
