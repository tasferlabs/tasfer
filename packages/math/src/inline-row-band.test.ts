/**
 * Even caret and highlight heights inside an inline formula: every piece on
 * one row of the formula is as tall as the row, and the formula's own row is
 * as tall as the text line — so a selected letter and a selected root read as
 * the same band, and the caret keeps one height as it moves along.
 */

import { resolveStructuredInlineMathRuns } from "./inline-structured";
import { mathExtension } from "./math-extension";
import { mathContentSelectionFromSourceOffset } from "./tree-selection";
import { createMarkRegistry } from "@tasfer/editor/rendering/marks";
import { createNodeRegistry } from "@tasfer/editor/rendering/nodes";
import { baseSchema } from "@tasfer/editor/schema";
import {
  getContentSelectionDocumentGeometry,
  getCursorDocumentCoords,
  moveCursorToPosition,
} from "@tasfer/editor/selection";
import { loadPage } from "@tasfer/editor/serlization/loadPage";
import type { EditorState, ViewportState } from "@tasfer/editor/state-types";
import { createInitialState } from "@tasfer/editor/state-utils";
import { updateContentSelection } from "@tasfer/editor/structured-selection";
import { isTextualBlock } from "@tasfer/editor/sync/block-registry";
import { createCRDTbinding } from "@tasfer/editor/sync/sync";
import { describe, expect, it } from "vitest";

const schema = baseSchema.use(mathExtension());

const viewport: ViewportState = {
  width: 600,
  height: 800,
  scrollY: 0,
  documentHeight: 1000,
};

// Source offsets: a+x+ [0,4) · \sqrt{b} [4,12) · + [12,13) ·
// \frac{12}{3} [13,25) with "12" at [19,21) · + [25,26) · {y}^{2} [26,33)
// with the base y at [27,28) and the exponent's 2 at [31,32).
const md = "hi $a+x+\\sqrt{b}+\\frac{12}{3}+{y}^{2}$ yo";

function load(): EditorState {
  const state = createInitialState(loadPage(md, schema.data), {
    schema: schema.data,
    nodes: createNodeRegistry(schema.nodes),
    marks: createMarkRegistry(schema.marks),
    crdtBinding: createCRDTbinding("page", "peer"),
  });
  return moveCursorToPosition(state, 0, 0);
}

function select(from: number, to: number): EditorState {
  const state = load();
  const block = state.document.page.blocks[0];
  if (!isTextualBlock(block)) throw new Error("expected a textual block");
  const run = resolveStructuredInlineMathRuns(block)[0];
  if (!run?.contentId || !run.document) throw new Error("expected a chip");
  const a = mathContentSelectionFromSourceOffset(
    block.id,
    run.contentId,
    run.document,
    from,
  );
  const f = mathContentSelectionFromSourceOffset(
    block.id,
    run.contentId,
    run.document,
    to,
  );
  if (!a || !f) throw new Error("expected nested carets");
  return updateContentSelection(state, {
    anchor: a.anchor,
    focus: f.focus,
    lastUpdate: 0,
  });
}

/**
 * The text line's height, read off the prose caret: prose carets and
 * highlights are as tall as their line.
 */
function lineHeight() {
  const caret = getCursorDocumentCoords(
    { blockIndex: 0, textIndex: 0 },
    load(),
    viewport,
  );
  if (!caret) throw new Error("expected a prose caret");
  return caret.height;
}

function highlight(from: number, to: number) {
  const rects = getContentSelectionDocumentGeometry(
    select(from, to),
    viewport,
  )?.rects;
  if (!rects?.length) throw new Error("expected a highlight");
  const top = Math.min(...rects.map((r) => r.y));
  const bottom = Math.max(...rects.map((r) => r.y + r.height));
  return { y: top, height: bottom - top };
}

function caretAt(offset: number) {
  const caret = getCursorDocumentCoords(
    { blockIndex: 0, textIndex: 0 },
    select(offset, offset),
    viewport,
  );
  if (!caret) throw new Error("expected a nested caret");
  return { y: caret.y, height: caret.height };
}

describe("the formula's own row", () => {
  it("highlights a letter, a sign and a whole root as tall as the line", () => {
    const band = highlight(0, 1);

    expect(band.height).toBe(lineHeight());
    expect(highlight(1, 2)).toEqual(band);
    expect(highlight(4, 12)).toEqual(band);
    expect(highlight(13, 25)).toEqual(band);
  });

  it("keeps the caret in that same band all along the row", () => {
    const band = highlight(0, 1);

    for (const offset of [0, 1, 2, 4, 12, 13, 25, 26]) {
      expect(caretAt(offset)).toEqual(band);
    }
  });

  it("treats the base of a power as part of the row", () => {
    const band = highlight(0, 1);

    expect(highlight(27, 28)).toEqual(band);
    expect(caretAt(28)).toEqual(band);
  });
});

describe("a row inside the formula", () => {
  it("gives one digit and two digits of a numerator the same band", () => {
    expect(highlight(19, 20)).toEqual(highlight(19, 21));
  });

  it("keeps the caret one height across the numerator", () => {
    const start = caretAt(19);

    expect(caretAt(20)).toEqual(start);
    expect(caretAt(21)).toEqual(start);
  });

  it("stays shorter than the line, so the row still reads as inside", () => {
    expect(highlight(19, 20).height).toBeLessThan(lineHeight());
    expect(highlight(31, 32).height).toBeLessThan(lineHeight());
    expect(caretAt(31).height).toBeLessThan(lineHeight());
  });
});
