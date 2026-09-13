/**
 * Where the host sees the caret when it sits in a table cell.
 *
 * Host chrome that follows the caret (the touch magnifier, overlays anchored to
 * the caret) asks `view.coordsAtPos("caret")`. A cell caret has no flat block
 * offset, so the answer has to come from the cell itself.
 */
import { tableCaretToContentPoint } from "./selection";
import { getTableDocument } from "./structured";
import { tableExtension } from "./table-extension";
import type { TableBlock } from "./TableNode";
import { Editor } from "@tasfer/editor/entries/editor";
import type { CanvasLayers } from "@tasfer/editor/entries/layers";
import { createMarkRegistry } from "@tasfer/editor/rendering/marks";
import { createNodeRegistry } from "@tasfer/editor/rendering/nodes";
import { baseSchema } from "@tasfer/editor/schema";
import { loadPage } from "@tasfer/editor/serlization/loadPage";
import type { ViewportState } from "@tasfer/editor/state-types";
import { createInitialState } from "@tasfer/editor/state-utils";
import { createCRDTbinding } from "@tasfer/editor/sync/sync";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const VIEWPORT: ViewportState = {
  scrollY: 0,
  width: 640,
  height: 480,
  documentHeight: 480,
};

function canvasLayers(): CanvasLayers {
  const context = new Proxy(
    {
      globalAlpha: 1,
      measureText: (text: string) => ({
        width: text.length * 8,
        fontBoundingBoxAscent: 12,
        fontBoundingBoxDescent: 4,
      }),
      createLinearGradient: () => ({ addColorStop() {} }),
    } as unknown as CanvasRenderingContext2D,
    {
      get(target, key, receiver) {
        if (Reflect.has(target, key)) return Reflect.get(target, key, receiver);
        return () => {};
      },
      set(target, key, value, receiver) {
        return Reflect.set(target, key, value, receiver);
      },
    },
  );
  const canvas = {
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    style: {},
    addEventListener() {},
    removeEventListener() {},
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      right: VIEWPORT.width,
      bottom: VIEWPORT.height,
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      x: 0,
      y: 0,
      toJSON() {},
    }),
  } as unknown as HTMLCanvasElement;
  return {
    content: { canvas, ctx: context },
    cursor: { canvas, ctx: context },
  };
}

function tableEditor(before: string[] = [], after: string[] = []) {
  const schema = baseSchema.use(tableExtension());
  const page = loadPage(
    [...before, "| A | B |", "| --- | --- |", "| one two | x |", ...after].join(
      "\n",
    ),
    schema.data,
  );
  const editor = new Editor(
    canvasLayers(),
    createInitialState(page, {
      schema: schema.data,
      nodes: createNodeRegistry(schema.nodes),
      marks: createMarkRegistry(schema.marks),
      crdtBinding: createCRDTbinding(page.id, "cell-coords"),
    }),
    VIEWPORT,
  );
  const block = page.blocks.find((b) => (b.type as string) === "table");
  return { editor, block: block as unknown as TableBlock };
}

describe("caret coordinates in a table cell", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    Object.assign(window, { removeEventListener() {} });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('coordsAtPos("caret") follows a caret inside a cell', () => {
    const { editor, block } = tableEditor();
    const document = getTableDocument(block)!;
    const cellId = Object.values(document.nodes).find((node) =>
      node.textFields?.text?.some((run) => run.text.includes("one")),
    )!.id;

    const place = (offset: number) => {
      const point = tableCaretToContentPoint(document, block.id, {
        cellId,
        offset,
      })!;
      editor.change((c) => c.selectContent({ anchor: point, focus: point }));
      return point;
    };

    const start = place(0);
    const atStart = editor.view.coordsAtPos("caret");
    expect(atStart).not.toBeNull();
    expect(atStart).toEqual(editor.view.coordsAtContent(start));

    place(3);
    const later = editor.view.coordsAtPos("caret");
    expect(later!.x).toBeGreaterThan(atStart!.x);
    expect(later!.y).toBe(atStart!.y);
  });

  const caretInOne = (editor: Editor, block: TableBlock, offset: number) => {
    const document = getTableDocument(block)!;
    const cellId = Object.values(document.nodes).find((node) =>
      node.textFields?.text?.some((run) => run.text.includes("one")),
    )!.id;
    const point = tableCaretToContentPoint(document, block.id, {
      cellId,
      offset,
    })!;
    editor.change((c) => c.selectContent({ anchor: point, focus: point }));
    return point;
  };

  it("setCaret onlyIfUnset leaves a caret inside a cell alone", () => {
    const { editor, block } = tableEditor(["Intro", ""]);
    const point = caretInOne(editor, block, 2);

    editor.setCaret("start", { onlyIfUnset: true });

    expect(editor.state.contentSelection?.focus).toEqual(point);
  });

  it('scrollToPosition("caret") places a cell caret at the viewport offset', () => {
    const filler = Array.from({ length: 80 }, (_, i) => [
      `Line ${i}`,
      "",
    ]).flat();
    const { editor, block } = tableEditor(filler, ["", ...filler]);
    caretInOne(editor, block, 3);

    editor.view.scrollToPosition("caret", { viewportOffsetY: 120 });

    expect(editor.view.getScrollY()).toBeGreaterThan(0);
    expect(editor.view.coordsAtPos("caret")!.y).toBeCloseTo(120, 0);
  });
});
