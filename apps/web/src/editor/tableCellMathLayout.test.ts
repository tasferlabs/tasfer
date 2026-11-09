/**
 * A formula in a table cell is measured as the formula, not as its anchor.
 *
 * Canvas output itself is not observable here, so this pins the input the
 * painter and the caret both read: the cell's laid-out line. Without the table
 * block's attachments a formula is one zero-width placeholder; with them it
 * reserves its rendered width and height.
 */

import { vi } from "vitest";

// Text measurement needs a canvas context before the engine's modules load;
// this app's test environment is plain node.
vi.hoisted(() => {
  const g = globalThis as Record<string, unknown>;
  if (typeof g.document !== "undefined") return;
  const element = () => ({
    // Width proportional to length, so measured widths mean something.
    getContext: () => ({
      measureText: (text: string) => ({ width: text.length * 7 }),
    }),
    style: {},
    setAttribute: () => {},
    appendChild: () => {},
  });
  g.getComputedStyle = () => ({ getPropertyValue: () => "" });
  g.document = {
    documentElement: {},
    location: "http://localhost/",
    getElementsByTagName: () => [],
    createElement: element,
    createElementNS: element,
    addEventListener: () => {},
  };
});

import { appSchema } from "../editorSchema";
import { createNodeRegistry } from "@tasfer/editor";
import { currentFontFamily } from "@tasfer/editor/fonts";
import { createMarkRegistry } from "@tasfer/editor/rendering/marks";
import { loadPage } from "@tasfer/editor/serlization/loadPage";
import { createInitialState } from "@tasfer/editor/state-utils";
import { getEditorStyles } from "@tasfer/editor/styles";
import { layoutTable } from "@tasfer/table/geometry";
import { getTableDocument } from "@tasfer/table/structured";
import { describe, expect, it } from "vitest";

describe("a formula in a table cell", () => {
  it("lays out at the formula's own size, read from the table block", () => {
    const page = loadPage(
      ["| A |", "| --- |", "| $\\frac{a+b+c+d}{e}$ |"].join("\n"),
      appSchema.data,
    );
    const state = createInitialState(page, {
      schema: appSchema.data,
      nodes: createNodeRegistry(appSchema.nodes),
      marks: createMarkRegistry(appSchema.marks),
    });
    const styles = getEditorStyles(state);
    const block = page.blocks[0];
    const ctx = {
      maxWidth: 600,
      style: styles.blocks.table,
      fontFamily: currentFontFamily(styles),
      fonts: styles.fonts,
      marks: state.marks,
    };

    const placeholder = layoutTable(getTableDocument(block), ctx).cells[1];
    const formula = layoutTable(getTableDocument(block), {
      ...ctx,
      attachments: block.structuredContent,
    }).cells[1];

    expect(placeholder.lines[0].width).toBe(0);
    expect(formula.lines[0].width).toBeGreaterThan(20);
    // A fraction is taller than a line of text, and the row makes room.
    expect(formula.height).toBeGreaterThan(placeholder.height);
  });
});
