/**
 * Android keyboards that "reopen" the word before the caret (issue #34).
 *
 * HeliBoard (and other AOSP-LatinIME forks, and SwiftKey) do not always compose
 * new text at the caret. When the caret lands after a word they reopen that word
 * as a composition — `compositionstart` + `compositionupdate("He'll")` with no
 * DOM change — and then edit it: swap it for a suggestion, or shrink it one
 * character per Backspace. The managed surface used to treat every composition
 * as new text, so a suggestion swap appended ("He'llShe'll") and Backspace
 * deleted nothing. The sequences below are shaped on a device log from
 * HeliBoard on Android Chromium.
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
 * A contenteditable stand-in plus a fake keyboard. The caret always sits at the
 * end of the surface (the managed surface's invariant), and the keyboard edits
 * the tail of the surface the way a composing IME does.
 */
function fakeSurface() {
  const listeners = new Map<string, ((e: unknown) => void)[]>();
  const textNode = {};
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

  // The composition currently occupies the last `composing` chars.
  let composing = 0;
  const ime = {
    /** Start composing. `reopen` claims that many chars before the caret. */
    start(reopen = 0) {
      composing = reopen;
      fire("compositionstart", { data: "" });
      if (reopen > 0) {
        // Reopening only re-labels existing text: no DOM change, no input.
        fire("compositionupdate", { data: el.textContent.slice(-reopen) });
      }
    },
    update(text: string) {
      fire("compositionupdate", { data: text });
      el.textContent =
        el.textContent.slice(0, el.textContent.length - composing) + text;
      composing = text.length;
      fire("input", {
        inputType: "insertCompositionText",
        data: text,
        isComposing: true,
      });
    },
    end() {
      const data = el.textContent.slice(el.textContent.length - composing);
      composing = 0;
      fire("compositionend", { data });
    },
    /** Commit plain text outside a composition (e.g. the automatic space). */
    commit(text: string) {
      el.textContent += text;
      fire("input", {
        inputType: "insertText",
        data: text,
        isComposing: false,
      });
    },
  };
  return { el, ime };
}

function setup(markdown: string) {
  const { el, ime } = fakeSurface();
  vi.stubGlobal("document", {
    ...globalThis.document,
    activeElement: el,
    hasFocus: () => true,
    createRange: () => ({
      setStart() {},
      setEnd() {},
      collapse() {},
    }),
  });
  vi.stubGlobal("getSelection", () => ({
    rangeCount: 1,
    getRangeAt: () => ({
      collapsed: true,
      startContainer: el.firstChild,
      startOffset: el.textContent.length,
    }),
    removeAllRanges() {},
    addRange() {},
  }));
  Object.assign(window, { getSelection: globalThis.getSelection });

  const page = loadPage(markdown);
  let state: EditorState = createInitialState(page);
  const text = markdown;
  state = moveCursorToPosition(state, 0, text.length);
  state = { ...state, view: { ...state.view, isFocused: true } };
  const editor = new Editor(
    canvasLayers(),
    state,
    viewport,
    el as unknown as HTMLElement,
    { inputStrategy: "managed" },
  );
  // One animation frame. Marked dirty first, as on a device where input and
  // the caret blink keep frames painting; otherwise an idle frame skips the
  // surface resync this suite depends on.
  const internals = editor as unknown as {
    scheduleRender: () => void;
    renderFrame: () => Promise<void>;
  };
  const frame = async () => {
    internals.scheduleRender();
    await internals.renderFrame();
  };
  return { editor, el, ime, frame };
}

describe("Android keyboards that reopen the previous word (#34)", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (Linux; Android 14) Chrome/130.0 Mobile",
      maxTouchPoints: 5,
      language: "en",
    });
    // The surface replays plain-text input as synthetic key events.
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

  it("a fresh composition still inserts at the caret", async () => {
    const { editor, ime, frame } = setup("Hi");
    await frame();
    ime.commit(" ");
    ime.start();
    ime.update("t");
    ime.update("th");
    ime.update("there");
    ime.end();
    await frame();
    expect(editor.getMarkdown().trim()).toBe("Hi there");
  });

  it("a suggestion swap on a reopened word replaces it instead of appending", async () => {
    const { editor, el, ime, frame } = setup("He'll");
    await frame();
    expect(el.textContent).toBe(" He'll");

    ime.start(5); // reopen "He'll"
    await frame(); // a frame lands before the keyboard edits it
    ime.update("She'll");
    ime.end();
    await frame();

    expect(editor.getMarkdown().trim()).toBe("She'll");
  });

  it("previews the composed text in place of the reopened word", async () => {
    const { editor, ime, frame } = setup("He'll");
    await frame();

    ime.start(5);
    await frame();
    ime.update("She'll");
    await frame();

    // Loaded after the editor: importing TextNode first trips the node
    // modules' import cycle.
    const { getContentWithComposition } = await import("../nodes/TextNode");
    const state = (editor as unknown as { _state: EditorState })._state;
    const block = state.document.page.blocks[0];
    const visible = getContentWithComposition(block, state, 0)
      .chars.filter((c) => !c.deleted)
      .map((c) => c.char)
      .join("");
    expect(visible).toBe("She'll");
  });

  it("Backspace that shrinks a reopened word deletes it", async () => {
    const { editor, ime, frame } = setup("he'll she'll");
    await frame();

    ime.start(6); // reopen "she'll"
    await frame();
    for (const t of ["she'l", "she'", "she", "sh", "s", ""]) ime.update(t);
    ime.end();
    await frame();

    expect(editor.getMarkdown().trim()).toBe("he'll");
  });

  it("a partial Backspace commit keeps the rest of the word", async () => {
    const { editor, ime, frame } = setup("she'll");
    await frame();

    ime.start(6);
    ime.update("she'l"); // no frame between reopening and the first edit
    ime.update("she'");
    ime.end();
    await frame();

    expect(editor.getMarkdown().trim()).toBe("she'");
  });

  it("reopening and committing unchanged leaves the word alone", async () => {
    const { editor, ime, frame } = setup("He'll");
    await frame();

    ime.start(5);
    await frame();
    ime.end();
    await frame();

    expect(editor.getMarkdown().trim()).toBe("He'll");
  });
});
