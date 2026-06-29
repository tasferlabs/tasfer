/**
 * Continuous selection geometry.
 *
 * The local selection closes its vertical gaps so it reads as one connected
 * shape: each line still hugs its own text width (ragged edges where widths
 * differ), but a block the selection passes through fills its whole box (its
 * inter-block spacing) so adjacent selected blocks meet with no gap. The same
 * geometry drives mobile tap hit-testing, so a tap in that connected space
 * won't dismiss the selection.
 *
 * Tight range decorations (find highlights, remote carets) keep the default
 * `continuous = false` and hug the matched glyphs.
 */
import { createDefaultMarkRegistry } from "../rendering/marks";
import { loadPage } from "../serlization/loadPage";
import { resolveTheme } from "../styles";
import { TextNode, type TextualBlock } from "./TextNode";
import { describe, expect, it } from "vitest";

describe("TextNode continuous selection geometry", () => {
  const styles = resolveTheme({});
  const marks = createDefaultMarkRegistry();
  const node = new TextNode();

  const block = loadPage("Second").blocks[0] as TextualBlock;
  const layout = node.computeLayout(block, 1000, styles, undefined, marks);
  const blockTopY = 100;
  const originX = 0;

  // A selection passing fully through this block: it starts in an earlier block
  // and ends in a later one, so for this block (index 1) it both enters from
  // above and exits below.
  const through = {
    anchor: { blockIndex: 0, textIndex: 0 },
    focus: { blockIndex: 2, textIndex: 0 },
    isForward: true,
  };

  it("tight (default) hugs the text — text width and line box only", () => {
    const [r] = node.selectionRects(layout, through, 1, originX, blockTopY);
    expect(r.x).toBe(originX);
    expect(r.width).toBeCloseTo(layout.lines[0].width, 1);
    expect(r.y).toBeCloseTo(blockTopY + layout.insetY, 1);
    expect(r.height).toBeCloseTo(layout.lines[0].height, 1);
  });

  it("continuous keeps natural text width but fills the block's whole box", () => {
    const [r] = node.selectionRects(
      layout,
      through,
      1,
      originX,
      blockTopY,
      true,
    );
    // Width is unchanged — the line keeps its natural (ragged) text width, NOT
    // the full content width.
    expect(r.x).toBe(originX);
    expect(r.width).toBeCloseTo(layout.lines[0].width, 1);
    expect(r.width).toBeLessThan(layout.adjustedMaxWidth);
    // Vertical box fill: top edge → bottom edge, covering inter-block spacing so
    // it connects to the blocks above and below.
    expect(r.y).toBeCloseTo(blockTopY, 1);
    expect(r.y + r.height).toBeCloseTo(blockTopY + layout.height, 1);
  });

  it("continuous still stops at the selection's end boundary on the final line", () => {
    // Enters from above but ENDS inside this block at index 3.
    const endsHere = {
      anchor: { blockIndex: 0, textIndex: 0 },
      focus: { blockIndex: 1, textIndex: 3 },
      isForward: true,
    };
    const [r] = node.selectionRects(
      layout,
      endsHere,
      1,
      originX,
      blockTopY,
      true,
    );
    // No trailing fill — the line break itself isn't selected.
    expect(r.width).toBeLessThan(layout.adjustedMaxWidth);
    // Top is filled (entered from above); the bottom stops at the line box
    // because the selection does not exit into a later block.
    expect(r.y).toBeCloseTo(blockTopY, 1);
    expect(r.y + r.height).toBeCloseTo(
      blockTopY + layout.insetY + layout.lines[0].height,
      1,
    );
  });
});
