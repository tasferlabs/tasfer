/**
 * Cover repositioning stores WHICH PART of a cropped image the frame shows as a
 * pair of normalized `object-position` fractions. The pieces worth pinning are
 * the ones with no UI in them: the crop math a drag runs through, the clamp that
 * keeps a hostile or stale value from blanking the frame, the CRDT field
 * validation every peer replays through, and the markdown round-trip.
 */
import { getBaseDataSchema } from "../baseDataSchema";
import {
  canRepositionImage,
  type Image,
  imageCache,
  imageObjectPosition,
  isImageDefault,
  repositionFromDelta,
} from "./ImageNode";
import { afterEach, describe, expect, it } from "vitest";

/** A decoded-image stand-in: the crop math only reads the natural dimensions. */
function decoded(
  naturalWidth: number,
  naturalHeight: number,
): HTMLImageElement {
  return { naturalWidth, naturalHeight, complete: true } as HTMLImageElement;
}

function imageBlock(props: Partial<Image> = {}): Image {
  return {
    id: "img0",
    orderKey: "a0",
    deleted: false,
    type: "image",
    url: "blob:test",
    ...props,
  } as Image;
}

afterEach(() => {
  imageCache.clear();
});

describe("imageObjectPosition", () => {
  it("defaults to centered, the pre-feature behavior", () => {
    expect(imageObjectPosition(imageBlock())).toEqual({ x: 0.5, y: 0.5 });
  });

  it("clamps a stored value outside [0,1]", () => {
    // A peer on an older build or a hand-edited op can put anything here; an
    // out-of-range fraction would drag the source rect off the decoded image.
    const block = imageBlock({ objectPosition: { x: -3, y: 42 } });
    expect(imageObjectPosition(block)).toEqual({ x: 0, y: 1 });
  });
});

describe("repositionFromDelta", () => {
  // A 2000×1000 source in a 1000×500 frame has matching aspect: no slack.
  // Making the frame shorter (1000×250) crops it vertically instead.
  const source = decoded(2000, 1000);

  it("pans the crop opposite the pointer, so the image follows the drag", () => {
    // Frame 1000×250 → the crop window is 2000×500 of source, leaving 500px of
    // vertical slack. Dragging DOWN by 25 canvas px moves the source window up.
    const moved = repositionFromDelta(
      source,
      1000,
      250,
      { x: 0.5, y: 0.5 },
      0,
      25,
    );
    expect(moved.y).toBeLessThan(0.5);
    expect(moved.x).toBe(0.5);
  });

  it("clamps at the image edge instead of running past it", () => {
    const moved = repositionFromDelta(
      source,
      1000,
      250,
      { x: 0.5, y: 0.5 },
      0,
      100_000,
    );
    expect(moved.y).toBe(0);
  });

  it("pins an axis with no slack rather than accumulating a dead offset", () => {
    // Frame 1000×500 matches the source aspect exactly — nothing is cropped.
    const moved = repositionFromDelta(
      source,
      1000,
      500,
      { x: 0.5, y: 0.5 },
      500,
      500,
    );
    expect(moved).toEqual({ x: 0.5, y: 0.5 });
  });

  it("is symmetric: dragging back returns to the starting crop", () => {
    const out = repositionFromDelta(
      source,
      1000,
      250,
      { x: 0.5, y: 0.5 },
      0,
      40,
    );
    const back = repositionFromDelta(source, 1000, 250, out, 0, -40);
    expect(back.y).toBeCloseTo(0.5, 10);
  });
});

describe("canRepositionImage", () => {
  it("is false when the crop has no slack to move", () => {
    imageCache.set("blob:test", decoded(2000, 1000));
    expect(canRepositionImage(imageBlock(), 1000, 500)).toBe(false);
  });

  it("is true when the source is cropped", () => {
    imageCache.set("blob:test", decoded(2000, 1000));
    expect(canRepositionImage(imageBlock(), 1000, 250)).toBe(true);
  });

  it("is false in contain mode, which crops nothing", () => {
    imageCache.set("blob:test", decoded(2000, 1000));
    const block = imageBlock({ objectFit: "contain" });
    expect(canRepositionImage(block, 1000, 250)).toBe(false);
  });

  it("is false before the image has decoded", () => {
    expect(canRepositionImage(imageBlock(), 1000, 250)).toBe(false);
  });
});

describe("objectPosition CRDT field", () => {
  const validate = (value: unknown): boolean =>
    getBaseDataSchema().validateField("image", "objectPosition", value);

  it("accepts a pair of in-range fractions", () => {
    expect(validate({ x: 0, y: 1 })).toBe(true);
    expect(validate({ x: 0.25, y: 0.75 })).toBe(true);
  });

  it("rejects values a peer must not be able to apply", () => {
    // Rejected ops are dropped on every peer, so anything that could desync a
    // block's crop has to fail here rather than land half-applied.
    expect(validate({ x: 1.5, y: 0.5 })).toBe(false);
    expect(validate({ x: -0.1, y: 0.5 })).toBe(false);
    expect(validate({ x: Number.NaN, y: 0.5 })).toBe(false);
    expect(validate({ x: 0.5 })).toBe(false);
    expect(validate(null)).toBe(false);
    expect(validate("0.5 0.5")).toBe(false);
  });
});

describe("serialization", () => {
  it("keeps a repositioned image out of the plain-markdown branch", () => {
    // `![alt](url)` cannot carry a crop, so a repositioned image must take the
    // `<img>` branch or the position is silently dropped on round-trip.
    expect(isImageDefault(imageBlock())).toBe(true);
    expect(
      isImageDefault(imageBlock({ objectPosition: { x: 0.5, y: 0.2 } })),
    ).toBe(false);
  });

  it("round-trips the crop through the markdown <img> tag", () => {
    const codec = getBaseDataSchema().getCodec("image");
    const block = imageBlock({ objectPosition: { x: 0.4, y: 0.2 } });
    const markdown = codec!.markdown.output(block, {
      mapAssetUrl: (url: string) => url,
    } as never);
    expect(markdown).toContain('data-object-position="40% 20%"');
  });

  it("emits no position attribute for an unrepositioned image", () => {
    const codec = getBaseDataSchema().getCodec("image");
    const block = imageBlock({ height: 500 });
    const markdown = codec!.markdown.output(block, {
      mapAssetUrl: (url: string) => url,
    } as never);
    expect(markdown).not.toContain("data-object-position");
  });
});
