/**
 * Links in table cells.
 *
 * A cell's text is structured prose, not a block's flat text, so a link in it
 * is read through `query.marks` at a cell caret, written through `setMark` with
 * the nested range that read returns, and found by the link mark's hover and
 * Cmd/Ctrl+click through the cell hit-test.
 */

import { tableCaretToContentPoint, tableCellIds } from "./selection";
import { cellText, getTableDocument, readTable } from "./structured";
import { tableExtension } from "./table-extension";
import type { TableBlock } from "./TableNode";
import { OPEN_LINK } from "@tasfer/editor/action-bus";
import {
  POINTER_MOVE,
  TEXT_CLICK,
} from "@tasfer/editor/actions/pointer-actions";
import { Editor } from "@tasfer/editor/entries/editor";
import type { CanvasLayers } from "@tasfer/editor/entries/layers";
import { createMarkRegistry } from "@tasfer/editor/rendering/marks";
import { createNodeRegistry } from "@tasfer/editor/rendering/nodes";
import { baseSchema } from "@tasfer/editor/schema";
import { loadPage } from "@tasfer/editor/serlization/loadPage";
import { serializeToMarkdown } from "@tasfer/editor/serlization/serializer";
import type { EditorState, ViewportState } from "@tasfer/editor/state-types";
import { createInitialState } from "@tasfer/editor/state-utils";
import type { ContentSelection } from "@tasfer/editor/structured-selection";
import { createCRDTbinding } from "@tasfer/editor/sync/sync";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const schema = baseSchema.use(tableExtension());

const VIEWPORT: ViewportState = {
  scrollY: 0,
  width: 640,
  height: 480,
  documentHeight: 480,
};

const SOURCE = [
  "| Name | Site |",
  "| --- | --- |",
  "| docs | see [the guide](https://example.com/guide) here |",
].join("\n");

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

function initialState(): EditorState {
  const page = loadPage(SOURCE, schema.data);
  return createInitialState(page, {
    schema: schema.data,
    nodes: createNodeRegistry(schema.nodes),
    marks: createMarkRegistry(schema.marks),
    crdtBinding: createCRDTbinding(page.id, "links"),
  });
}

function table(state: EditorState) {
  const block = state.document.page.blocks[0] as unknown as TableBlock;
  const document = getTableDocument(block)!;
  return { block, document, cellId: tableCellIds(document)[3] };
}

/** A caret `offset` characters into the "see the guide here" cell. */
function caretAt(state: EditorState, offset: number): ContentSelection {
  const { block, document, cellId } = table(state);
  const point = tableCaretToContentPoint(document, block.id, {
    cellId,
    offset,
  })!;
  return { anchor: point, focus: point };
}

function markdownOf(state: EditorState): string {
  return serializeToMarkdown(state.document.page.blocks, undefined, {
    schema: schema.data,
  });
}

describe("links in a table cell", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    Object.assign(window, { removeEventListener() {} });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const live = (e: Editor) => (e as unknown as { _state: EditorState })._state;

  function editor() {
    return new Editor(canvasLayers(), initialState(), VIEWPORT);
  }

  it("reads the link under a cell caret, with its nested range", () => {
    const e = editor();
    e.change((c) => c.selectContent(caretAt(live(e), 6)));
    const [link] = e.query.marks().filter((mark) => mark.name === "link");

    expect(link).toMatchObject({
      name: "link",
      attrs: { url: "https://example.com/guide" },
      from: 4,
      to: 13,
      text: "the guide",
    });
    expect(link.content).toBeDefined();
  });

  it("rewrites and clears the link through its nested range", () => {
    const e = editor();
    const select = () => {
      const state = live(e);
      e.change((c) => c.selectContent(caretAt(state, 6)));
    };
    select();
    const link = e.query.marks().find((mark) => mark.name === "link")!;

    e.change((c) =>
      c.setMark("link", {
        attrs: { url: "https://example.com/new" },
        range: link.content,
      }),
    );
    select();
    expect(
      e.query.marks().find((mark) => mark.name === "link")?.attrs.url,
    ).toBe("https://example.com/new");

    e.change((c) => c.setMark("link", { active: false, range: link.content }));
    select();
    expect(e.query.marks().some((mark) => mark.name === "link")).toBe(false);
    expect(e.getMarkdown()).toContain("| see the guide here |");
  });

  it("makes a link from text selected in a cell", () => {
    const e = editor();
    const state = live(e);
    const { block, document } = table(state);
    const nameCell = tableCellIds(document)[2]; // "docs"
    const from = tableCaretToContentPoint(document, block.id, {
      cellId: nameCell,
      offset: 0,
    })!;
    const to = tableCaretToContentPoint(document, block.id, {
      cellId: nameCell,
      offset: 4,
    })!;

    e.change((c) =>
      c.setMark("link", {
        attrs: { url: "https://example.com/docs" },
        range: { anchor: from, focus: to },
      }),
    );

    expect(e.getMarkdown()).toContain("| [docs](https://example.com/docs) |");
    const after = live(e);
    const cells = readTable(table(after).document).rows[1].cells;
    expect(cellText(table(after).document, cells[0]!)).toBe("docs");
  });

  it("opens the link on Cmd/Ctrl+click in a cell", () => {
    const state = initialState();
    const opened = vi.fn();
    state.actionBus.register(OPEN_LINK, opened);

    const result = state.actionBus.dispatchState(TEXT_CLICK, state, {
      canvasX: 0,
      canvasY: 0,
      position: { blockIndex: 0, textIndex: 0 },
      contentSelection: caretAt(state, 6),
      previousMenu: { type: "none" },
      viewport: VIEWPORT,
      modifiers: { ctrlOrMeta: true, shift: false },
    });

    expect(result.claimed).toBe(true);
    expect(opened).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://example.com/guide" }),
    );
  });

  it("shows the hover tooltip for a link in a cell", () => {
    const state = initialState();
    const hovered = state.actionBus.dispatchState(POINTER_MOVE, state, {
      canvasX: 40,
      canvasY: 40,
      textPosition: { blockIndex: 0, textIndex: 0 },
      blockUnderPoint: 0,
      atomicBlock: null,
      viewport: VIEWPORT,
      resolveCoords: () => null,
      resolveContentCoords: () => ({ x: 30, y: 50, height: 16 }),
      resolveContentSelection: () => caretAt(state, 6),
      modifiers: { ctrlOrMeta: false },
    }).state;

    expect(hovered.ui.linkHover).toMatchObject({
      url: "https://example.com/guide",
      text: "the guide",
      startIndex: 4,
      endIndex: 13,
      x: 30,
      y: 66,
    });
    expect(hovered.ui.linkHover?.content).toBeDefined();
    expect(markdownOf(hovered)).toContain("[the guide]");
  });
});
