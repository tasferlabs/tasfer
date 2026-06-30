/**
 * Inline-math reflow must survive a delete that tombstones a chip's anchor char.
 *
 * A delete that removes the char a math span's `startCharId`/`endCharId` points
 * at tombstones that endpoint while the rest of the formula survives. `wrapText`
 * used to resolve chips by a strict char-id lookup, so it dropped the whole chip
 * to plain text the instant an anchor was tombstoned — the formula stopped
 * wrapping at its operators (it overflowed or broke as plain source) even though
 * paint still drew it as a formula. It now shares the tolerant ordinal resolver
 * with the paint/caret path, so wrap survives the delete. Pairs with
 * `inline-math-render-resolution.test.ts` (which pins render↔edit resolution).
 */
import { resolveMarkRunsFromChars } from "../inline-math-spans";
import { createDefaultMarkRegistry } from "../rendering/marks";
import type { Block } from "../serlization/loadPage";
import { resolveTheme } from "../styles";
import { charRunsToChars } from "../sync/char-runs";
import {
  deleteCharsInRange,
  insertCharsAtPosition,
  markCharsInRange,
} from "../sync/crdt-utils";
import { createCRDTbinding, createSyncEngine } from "../sync/sync";
import { TextNode, type TextualBlock } from "./TextNode";
import { describe, expect, it } from "vitest";

describe("TextNode inline-math reflow survives anchor-char delete", () => {
  const styles = resolveTheme({});
  const marks = createDefaultMarkRegistry();
  const node = new TextNode();

  // Wide formula, many top-level operators, no spaces — every wrap is a math
  // break, so the line texts concatenate back to the (post-delete) source.
  const latex = "a+b+c+d+e+f+g+h+i+j+k+l+m+n+o+p";

  function chipBlock(src: string) {
    const binding = createCRDTbinding("wrap-del", "peer-1");
    const engine = createSyncEngine(binding);
    const blockOp = engine.createBlockInsert(null, "paragraph", {});
    engine.emit([blockOp]);
    const blockId = blockOp.blockId;
    let page = engine.getState();
    page = insertCharsAtPosition(page, blockId, 0, src, binding).newPage;
    page = markCharsInRange(
      page,
      blockId,
      0,
      src.length,
      { type: "math" },
      true,
      binding,
    ).newPage;
    return { page, blockId, binding };
  }

  const wrapsAtMath = (block: Block) => {
    const layout = node.computeLayout(
      block as TextualBlock,
      120,
      styles,
      undefined,
      marks,
    );
    return layout;
  };

  it("still wraps at operators after deleting the TRAILING anchor char", () => {
    const { page, blockId, binding } = chipBlock(latex);
    // Sanity: the intact chip wraps.
    expect(wrapsAtMath(page.blocks[0]).lines.length).toBeGreaterThan(1);

    // Backspace the chip's last char 'p' — tombstones the span's endCharId.
    const { newPage } = deleteCharsInRange(
      page,
      blockId,
      latex.length - 1,
      latex.length,
      binding,
    );

    // The chip still resolves (tolerant resolver) and the layout still wraps at
    // its operators instead of collapsing to one overflowing plain-text line.
    const run = resolveMarkRunsFromChars(
      charRunsToChars(newPage.blocks[0].charRuns),
      newPage.blocks[0].formats,
    ).find((r) => r.name === "math");
    expect(run?.text).toBe(latex.slice(0, -1));

    const layout = wrapsAtMath(newPage.blocks[0]);
    expect(layout.lines.length).toBeGreaterThan(1);
    expect(layout.lines.map((l) => l.text).join("")).toBe(latex.slice(0, -1));
    for (let i = 1; i < layout.lines.length; i++) {
      expect("+-=".includes(layout.lines[i].text[0])).toBe(true);
    }
  });

  it("still wraps at operators after deleting the LEADING anchor char", () => {
    const { page, blockId, binding } = chipBlock(latex);
    // Delete the chip's first char 'a' — tombstones the span's startCharId.
    const { newPage } = deleteCharsInRange(page, blockId, 0, 1, binding);

    const layout = wrapsAtMath(newPage.blocks[0]);
    expect(layout.lines.length).toBeGreaterThan(1);
    expect(layout.lines.map((l) => l.text).join("")).toBe(latex.slice(1));
  });
});
