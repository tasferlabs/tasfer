/**
 * Image HTML export — the frame an exported/printed image draws in. A cover
 * image only crops if its `<img>` has a definite height; with `height:auto` the
 * box takes the source's own aspect ratio and `object-fit`/`object-position`
 * silently do nothing (the PDF export's uncropped, off-position covers).
 */

import type { Image } from "../nodes/ImageNode";
import { serializeToHTMLFragment } from "./htmlSerializer";
import type { Block } from "./loadPage";
import { describe, expect, it } from "vitest";

function html(image: Partial<Image>): string {
  const block = {
    id: "img-1",
    type: "image",
    url: "asset://a",
    ...image,
  } as Block;
  return serializeToHTMLFragment([block]);
}

describe("image html export", () => {
  it("gives a default cover image a definite frame so it crops", () => {
    const out = html({});
    expect(out).toContain("height:220px");
    expect(out).toContain("object-fit:cover");
    expect(out).toContain("object-position:50% 50%");
  });

  it("marks a full-width image for the shell's edge-to-edge bleed", () => {
    const out = html({});
    expect(out).toContain('class="full-bleed"');
    // An inline max-width would clamp the bleed back to the text column.
    expect(out).not.toContain("max-width");
  });

  it("carries the stored crop height and position", () => {
    const out = html({ height: 400, objectPosition: { x: 0.25, y: 0.8 } });
    expect(out).toContain("height:400px");
    expect(out).toContain("object-position:25% 80%");
  });

  it("scales a user-sized image's height with a narrower page", () => {
    const out = html({ width: 600, height: 300 });
    expect(out).toContain("width:600px");
    expect(out).toContain("aspect-ratio:600/300");
    expect(out).toContain("max-width:100%");
  });

  it("leaves a contained image at its natural aspect ratio", () => {
    const out = html({ objectFit: "contain" });
    expect(out).toContain("height:auto");
    expect(out).not.toContain("object-position");
  });
});
