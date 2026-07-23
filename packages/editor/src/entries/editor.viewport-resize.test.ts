import { loadPage } from "../serlization/loadPage";
import type { ViewportState } from "../state-types";
import { createInitialState } from "../state-utils";
import { Editor } from "./editor";
import type { CanvasLayers } from "./layers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const viewport: ViewportState = {
  scrollY: 0,
  width: 800,
  height: 480,
  documentHeight: 0,
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
    style: {},
    addEventListener() {},
    removeEventListener() {},
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      right: viewport.width,
      bottom: viewport.height,
      width: viewport.width,
      height: viewport.height,
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

describe("viewport resize anchoring", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    Object.assign(window, { removeEventListener() {} });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("adjusts scroll when rewrapping content above a scrolled viewport", () => {
    const markdown = Array.from(
      { length: 80 },
      (_, index) =>
        `Paragraph ${index} ${"several wrapping words ".repeat(30)}`,
    ).join("\n\n");
    const page = loadPage(markdown);
    const editor = new Editor(
      canvasLayers(),
      createInitialState(page),
      viewport,
    );

    editor.view.updateViewport({ scrollY: 4_000 });
    const before = editor.view.getScrollY();
    editor.view.updateViewport({ width: 520 });

    expect(before).toBeGreaterThan(0);
    expect(editor.view.getScrollY()).toBeGreaterThan(before);
  });
});
