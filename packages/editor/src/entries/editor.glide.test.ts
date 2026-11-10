/**
 * Android keyboards that move the caret and select text on the input surface
 * themselves: Gboard's space-bar cursor control and backspace glide delete,
 * and HeliBoard's, which also reopens the word under the caret after every
 * move. The sequences are shaped on device logs from a Pixel (Chrome 156).
 */
import { moveCursorToPosition } from "../selection";
import { loadPage } from "../serlization/loadPage";
import type { EditorState, ViewportState } from "../state-types";
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

/**
 * A contenteditable stand-in with a real (anchor, focus) selection, plus a fake
 * keyboard that moves it, deletes ranges and composes over any span of it.
 */
function fakeSurface() {
  const listeners = new Map<string, ((e: unknown) => void)[]>();
  const textNode = {};
  const sel = { anchor: 0, focus: 0 };
  const el = {
    textContent: "",
    style: {} as Record<string, string>,
    get firstChild() {
      return el.textContent ? textNode : null;
    },
    addEventListener(type: string, fn: (e: unknown) => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
    removeEventListener() {},
    setAttribute() {},
    removeAttribute() {},
    getAttribute: () => null,
    focus() {},
    blur() {},
    click() {},
    contains: () => false,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
  };
  const fire = (type: string, props: Record<string, unknown>) => {
    for (const fn of listeners.get(type) ?? []) {
      fn({ type, preventDefault() {}, stopPropagation() {}, ...props });
    }
  };
  const selection = {
    rangeCount: 1,
    get anchorNode() {
      return el.firstChild;
    },
    get focusNode() {
      return el.firstChild;
    },
    get anchorOffset() {
      return sel.anchor;
    },
    get focusOffset() {
      return sel.focus;
    },
    getRangeAt: () => ({
      collapsed: sel.anchor === sel.focus,
      startContainer: el.firstChild ?? el,
      startOffset: Math.min(sel.anchor, sel.focus),
    }),
    removeAllRanges() {},
    addRange(range: { start: number; end: number }) {
      sel.anchor = range.start;
      sel.focus = range.end;
    },
  };
  const createRange = () => {
    const range = {
      start: 0,
      end: 0,
      setStart(_node: unknown, offset: number) {
        range.start = offset;
        range.end = offset;
      },
      setEnd(_node: unknown, offset: number) {
        range.end = offset;
      },
      collapse() {
        range.end = range.start;
      },
    };
    return range;
  };

  // The span the keyboard is composing over, as [start, end) surface offsets.
  let composing: { start: number; end: number } | null = null;
  const ime = {
    /** Move or extend the selection (InputConnection.setSelection). */
    select(anchor: number, focus = anchor) {
      sel.anchor = anchor;
      sel.focus = focus;
    },
    /** Delete the selection, as a glide delete does on release. */
    deleteSelection() {
      const start = Math.min(sel.anchor, sel.focus);
      const end = Math.max(sel.anchor, sel.focus);
      el.textContent =
        el.textContent.slice(0, start) + el.textContent.slice(end);
      sel.anchor = sel.focus = start;
      fire("input", {
        inputType: "deleteContentBackward",
        data: null,
        isComposing: false,
      });
    },
    /** Reopen [start, end) as a composition: no DOM change, no input. */
    reopen(start: number, end: number) {
      composing = { start, end };
      fire("compositionstart", { data: "" });
      fire("compositionupdate", { data: el.textContent.slice(start, end) });
    },
    /** Replace the composed span; the caret lands after it. */
    update(text: string) {
      const { start, end } = composing!;
      fire("compositionupdate", { data: text });
      el.textContent =
        el.textContent.slice(0, start) + text + el.textContent.slice(end);
      composing = { start, end: start + text.length };
      sel.anchor = sel.focus = start + text.length;
      fire("input", {
        inputType: "insertCompositionText",
        data: text,
        isComposing: true,
      });
    },
    end() {
      const { start, end } = composing!;
      composing = null;
      fire("compositionend", { data: el.textContent.slice(start, end) });
    },
    /** Commit plain text at the caret, outside a composition. */
    commit(text: string) {
      const at = sel.focus;
      el.textContent =
        el.textContent.slice(0, at) + text + el.textContent.slice(at);
      sel.anchor = sel.focus = at + text.length;
      fire("input", {
        inputType: "insertText",
        data: text,
        isComposing: false,
      });
    },
  };
  /** The surface with `|` at the caret or `[…]` around a range. */
  const show = () => {
    const t = el.textContent;
    const a = Math.min(sel.anchor, sel.focus);
    const f = Math.max(sel.anchor, sel.focus);
    return a === f
      ? t.slice(0, a) + "|" + t.slice(a)
      : t.slice(0, a) + "[" + t.slice(a, f) + "]" + t.slice(f);
  };
  return { el, ime, selection, createRange, show };
}

function setup(markdown: string, caret = markdown.length) {
  const { el, ime, selection, createRange, show } = fakeSurface();
  vi.stubGlobal("document", {
    ...globalThis.document,
    activeElement: el,
    hasFocus: () => true,
    addEventListener() {},
    removeEventListener() {},
    createRange,
  });
  vi.stubGlobal("getSelection", () => selection);
  Object.assign(window, { getSelection: globalThis.getSelection });

  let state: EditorState = createInitialState(loadPage(markdown));
  state = moveCursorToPosition(state, 0, caret);
  state = { ...state, view: { ...state.view, isFocused: true } };
  const editor = new Editor(
    canvasLayers(),
    state,
    viewport,
    el as unknown as HTMLElement,
    { inputStrategy: "managed" },
  );
  const internals = editor as unknown as {
    scheduleRender: () => void;
    renderFrame: () => Promise<void>;
    _state: EditorState;
  };
  const frame = async () => {
    internals.scheduleRender();
    await internals.renderFrame();
  };
  const text = () => editor.getMarkdown().trim();
  const caretAt = () => internals._state.document.cursor?.position.textIndex;
  return { editor, el, ime, frame, show, text, caretAt, internals };
}

describe("Android keyboards that move the surface selection themselves", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (Linux; Android 14) Chrome/156.0 Mobile",
      maxTouchPoints: 5,
      language: "en",
    });
    vi.stubGlobal(
      "KeyboardEvent",
      class {
        type: string;
        key: string;
        constructor(type: string, init: { key: string }) {
          this.type = type;
          this.key = init.key;
        }
        preventDefault() {}
        stopPropagation() {}
      },
    );
    Object.assign(window, { removeEventListener() {} });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("mirrors the whole paragraph with the caret where it is", async () => {
    const { frame, show } = setup("One two. Three four", 8);
    await frame();
    expect(show()).toBe(" One two.| Three four");
  });

  it("follows a space-bar cursor glide both ways without snapping back", async () => {
    const { ime, frame, show, caretAt } = setup("hello world");
    await frame();
    for (const at of [11, 10, 9, 8, 7]) {
      ime.select(at);
      await frame();
    }
    expect(show()).toBe(" hello |world");
    expect(caretAt()).toBe(6);
    ime.select(9);
    await frame();
    expect(caretAt()).toBe(8);
    expect(show()).toBe(" hello wo|rld");
  });

  it("deletes a glide-delete range across a full stop", async () => {
    const { ime, frame, text } = setup("One two. Three four");
    await frame();
    ime.select(20, 5); // "two. Three four"
    await frame();
    ime.deleteSelection();
    await frame();
    expect(text()).toBe("One");
  });

  it("deletes everything when the range takes the sentinel, even if the keyboard collapsed its selection first", async () => {
    const { ime, frame, text, show } = setup("One two. Three four");
    await frame();
    ime.select(20, 0);
    await frame();
    // HeliBoard collapses its selection, then deletes the range it remembers.
    ime.select(20);
    await frame();
    ime.select(0, 20);
    ime.deleteSelection();
    await frame();
    expect(text()).toBe("");
    expect(show()).toBe(" |");
  });

  it("keeps a word HeliBoard reopens around a mid-word caret", async () => {
    const { ime, frame, text, show } = setup("ten hello");
    await frame();
    ime.select(9); // glide one step left: " ten hell|o"
    await frame();
    ime.reopen(5, 10); // the word touched by the caret
    await frame();
    ime.end();
    await frame();
    ime.select(8); // the next glide step
    await frame();
    ime.reopen(5, 10);
    await frame();
    ime.end();
    await frame();
    expect(text()).toBe("ten hello");
    expect(show()).toBe(" ten hel|lo");
  });

  it("applies typing inside a word HeliBoard reopened around the caret", async () => {
    const { ime, frame, text, caretAt } = setup("ten hello");
    await frame();
    ime.select(8); // " ten hel|lo"
    await frame();
    ime.reopen(5, 10);
    await frame();
    ime.update("helxlo");
    await frame();
    ime.end();
    await frame();
    expect(text()).toBe("ten helxlo");
    expect(caretAt()).toBe(10);
  });

  it("still types at the end of a paragraph through the composition engine", async () => {
    const { ime, frame, text } = setup("Hi");
    await frame();
    ime.commit(" ");
    await frame();
    ime.reopen(4, 4);
    ime.update("there");
    ime.end();
    await frame();
    expect(text()).toBe("Hi there");
  });
});
