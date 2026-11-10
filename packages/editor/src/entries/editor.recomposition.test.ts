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
import { insertText, splitBlock } from "../actions/actions";
import { getBaseDataSchema } from "../baseDataSchema";
import { getBlockTextContent } from "../node-shared";
import { moveCursorToPosition } from "../selection";
import { loadPage } from "../serlization/loadPage";
import type { EditorState, Operation, ViewportState } from "../state-types";
import { createInitialState } from "../state-utils";
import { applyOps } from "../sync/reducer";
import type { DataSchema } from "../sync/schema";
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
    /** A real keydown outside a composition, as Firefox sends for the space. */
    keydown(key: string) {
      fire("keydown", {
        key,
        code: "",
        keyCode: key === " " ? 32 : 0,
        isComposing: false,
        isTrusted: true,
      });
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

function setup(
  markdown: string,
  at?: { block: number; index: number },
  schema?: DataSchema,
  inputStrategy: "managed" | "faithful" = "managed",
) {
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
  const collapses: number[] = [];
  vi.stubGlobal("getSelection", () => ({
    collapse(_node: unknown, offset: number) {
      collapses.push(offset);
    },
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
  let state: EditorState = createInitialState(page, { schema });
  const text = markdown;
  state = at
    ? moveCursorToPosition(state, at.block, at.index)
    : moveCursorToPosition(state, 0, text.length);
  state = { ...state, view: { ...state.view, isFocused: true } };
  const editor = new Editor(
    canvasLayers(),
    state,
    viewport,
    el as unknown as HTMLElement,
    { inputStrategy },
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
  // A completed one-finger tap at a document position, through the real touch
  // pipeline (hit-test included).
  const tap = async (
    blockIndex: number,
    textIndex: number,
    { thenFrame = true }: { thenFrame?: boolean } = {},
  ) => {
    const tapInternals = editor as unknown as {
      coordsAtIndexPosition: (p: {
        blockIndex: number;
        textIndex: number;
      }) => { x: number; y: number; height: number } | null;
      session: { touch: unknown };
      eventsQueue: unknown[];
    };
    const at = tapInternals.coordsAtIndexPosition({ blockIndex, textIndex })!;
    const x = at.x + 1;
    const y = at.y + 4; // inside the line (the stub canvas reports no height)
    const now = Date.now();
    tapInternals.session.touch = {
      startY: y,
      startScrollY: 0,
      lastY: y,
      lastTime: now,
      velocityY: 0,
      velocityHistory: [],
      startX: x,
      startTime: now,
      isLongPress: false,
      hasMoved: false,
      currentTouchX: x,
      currentTouchY: y,
      isTouchingSelection: false,
      isTouchingCursor: false,
      isCursorDrag: false,
      touchRadiusX: 8,
      touchRadiusY: 8,
    };
    tapInternals.eventsQueue.push({
      type: "touchend",
      touches: [],
      changedTouches: [],
      preventDefault() {},
    });
    if (thenFrame) await frame();
  };
  return { editor, el, ime, frame, tap, collapses };
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

  it("keeps the committed word on the surface instead of wiping it", async () => {
    const { el, ime, frame } = setup("Hi");
    await frame();
    ime.commit(" ");
    ime.start();
    ime.update("there");
    ime.end();
    // Straight after the commit, before any frame: the keyboard must still see
    // the text it just committed, or it treats the change as an outside edit.
    expect(el.textContent).toBe(" Hi there");
    await frame();
    expect(el.textContent).toBe(" Hi there");
  });

  it("keeps a word whose space keydown arrives before the frame (Firefox)", async () => {
    // Firefox on Android sends HeliBoard's automatic space as a real keydown
    // (not composing) in the same task as `compositionend`, before the frame
    // that applies it. A frame mid-word had already opened the composition in
    // the editor, so the keydown met an editor still composing.
    const { editor, ime, frame } = setup("Hi");
    await frame();
    ime.commit(" ");
    for (const word of ["there", "you"]) {
      ime.start();
      ime.update(word);
      await frame(); // a frame lands mid-word
      ime.end();
      ime.keydown(" ");
      ime.commit(" ");
      await frame();
    }
    expect(editor.getMarkdown().trim()).toBe("Hi there you");
  });

  it("a tap on another line commits the word where it was typed", async () => {
    // handleTouchEnd's scrollbar hit-test probes document.body.
    const doc = globalThis.document as unknown as { body?: unknown };
    if (!doc.body) doc.body = { appendChild() {}, removeChild() {} };

    const { editor, ime, frame, tap } = setup("first\n\nsecond", {
      block: 0,
      index: 5,
    });
    await frame();
    ime.commit(" ");
    ime.start();
    ime.update("hey");
    await frame();

    await tap(2, 3);
    expect(editor.getMarkdown().trim()).toBe("first hey\n\nsecond");
    const state = (editor as unknown as { _state: EditorState })._state;
    expect(state.ui.composition).toBeNull();
    // On the tapped line (the stub canvas's metrics decide the exact column).
    const caret = state.document.cursor!.position;
    expect(caret.blockIndex).toBe(2);

    // The keyboard had not noticed yet: what is left of its session must not
    // land a second copy at the new caret.
    ime.update("hey");
    ime.end();
    await frame();
    expect(editor.getMarkdown().trim()).toBe("first hey\n\nsecond");

    // The next composition types at the new caret as usual.
    ime.start();
    ime.update("X");
    ime.end();
    await frame();
    const second = "second";
    expect(editor.getMarkdown().trim()).toBe(
      `first hey\n\n${second.slice(0, caret.textIndex)}X${second.slice(caret.textIndex)}`,
    );
  });

  it("letters typed into a session the keyboard kept after a tap land at the new caret", async () => {
    // The keyboard missed the signal that its composition is over and goes on
    // composing the old word. Only the letters past it are new typing.
    const doc = globalThis.document as unknown as { body?: unknown };
    if (!doc.body) doc.body = { appendChild() {}, removeChild() {} };

    const { editor, ime, frame, tap } = setup("first\n\nsecond", {
      block: 0,
      index: 5,
    });
    await frame();
    ime.commit(" ");
    ime.start();
    ime.update("hey");
    await frame();

    await tap(2, 3);
    const state = (editor as unknown as { _state: EditorState })._state;
    const caret = state.document.cursor!.position;
    ime.update("heyo");
    await frame();
    ime.update("heyok");
    ime.end();
    await frame();

    const second = "second";
    expect(editor.getMarkdown().trim()).toBe(
      `first hey\n\n${second.slice(0, caret.textIndex)}ok${second.slice(caret.textIndex)}`,
    );
  });

  it("on the faithful surface (iOS) a tap commits the word without rewriting the surface", async () => {
    // WebKit does not end a composition whose text is rewritten under it: the
    // keyboard goes on composing into text that is gone, and every later key
    // is lost (a device log with the Chinese keyboard). There the word is
    // committed where it was typed, and only the DOM caret moves, off the
    // composed text; the surface is left alone until the browser ends it.
    const doc = globalThis.document as unknown as { body?: unknown };
    if (!doc.body) doc.body = { appendChild() {}, removeChild() {} };

    const { editor, el, ime, frame, tap, collapses } = setup(
      "first\n\nsecond",
      { block: 0, index: 5 },
      undefined,
      "faithful",
    );
    await frame();
    ime.start();
    ime.update("hey");
    await frame();
    const surface = el.textContent;

    await tap(2, 3);
    expect(editor.getMarkdown().trim()).toBe("firsthey\n\nsecond");
    const state = (editor as unknown as { _state: EditorState })._state;
    expect(state.ui.composition).toBeNull();
    const caret = state.document.cursor!.position;
    expect(caret.blockIndex).toBe(2);
    // Off the composed text ("hey" ends at the caret), the text untouched,
    // through a frame too.
    expect(collapses).toEqual([surface.length - "hey".length]);
    await frame();
    expect(el.textContent).toBe(surface);

    // The browser's end of that session lands nothing, and the surface is
    // the editor's again.
    ime.end();
    await frame();
    expect(editor.getMarkdown().trim()).toBe("firsthey\n\nsecond");
    expect(el.textContent).toBe("second");

    // The next composition types at the new caret.
    ime.start();
    ime.update("X");
    ime.end();
    await frame();
    const second = "second";
    expect(editor.getMarkdown().trim()).toBe(
      `firsthey\n\n${second.slice(0, caret.textIndex)}X${second.slice(caret.textIndex)}`,
    );
  });

  it("a keyboard update queued behind a tap does not reopen the tapped word", async () => {
    // The keyboard's next update for the reopened word lands in the same
    // frame as the tap. It belongs to the session the tap just committed, so
    // it must not start a new composition at the tapped spot carrying the old
    // session's replaced-character count.
    const doc = globalThis.document as unknown as { body?: unknown };
    if (!doc.body) doc.body = { appendChild() {}, removeChild() {} };

    const { editor, ime, frame, tap } = setup("hello\n\nworld", {
      block: 0,
      index: 5,
    });
    await frame();
    ime.start(5); // reopen "hello"
    await frame();

    await tap(2, 5, { thenFrame: false });
    ime.update("hello");
    await frame();
    ime.end();
    await frame();

    expect(editor.getMarkdown().trim()).toBe("hello\n\nworld");
  });

  it("a word reopened before an autoformatted commit lands is not counted against stale text", async () => {
    // The commit comes out different from what the keyboard typed ("(c)"
    // becomes "©"), and the keyboard reopens the word before the frame that
    // applies the commit. It reopened the keyboard's text, not the document's.
    const copyright: DataSchema = getBaseDataSchema().withFeatures({
      inputRules: [
        {
          id: "test-copyright",
          phase: "before-insert",
          apply: ({ state, input }) =>
            input === "(c)"
              ? { ...insertText(state, "\u00a9"), handled: true }
              : undefined,
        },
      ],
    });
    const { editor, el, ime, frame } = setup("hello", undefined, copyright);
    await frame();
    ime.commit(" ");
    await frame();
    ime.start();
    ime.update("(c)");
    ime.end();
    ime.start(3); // reopen what the keyboard just committed
    await frame();
    ime.end();
    await frame();

    const markdown = editor.getMarkdown().trim();
    // Whatever lands, the text before the word is never eaten.
    expect(markdown.startsWith("hello ")).toBe(true);
    expect(markdown).toBe("hello \u00a9");
    // The surface is back to the document's text.
    expect(el.textContent).toBe(" hello \u00a9");
  });

  it("a new word started before an autoformatted commit lands keeps its first letter", async () => {
    // As above, but the keyboard starts a fresh word instead of reopening the
    // one it committed: its first update is new text, not the old word.
    const copyright: DataSchema = getBaseDataSchema().withFeatures({
      inputRules: [
        {
          id: "test-copyright",
          phase: "before-insert",
          apply: ({ state, input }) =>
            input === "(c)"
              ? { ...insertText(state, "\u00a9"), handled: true }
              : undefined,
        },
      ],
    });
    const { editor, ime, frame } = setup("hello", undefined, copyright);
    await frame();
    ime.commit(" ");
    await frame();
    ime.start();
    ime.update("(c)");
    ime.end();
    ime.start();
    ime.update("c");
    ime.update("ca");
    ime.update("cat");
    ime.end();
    await frame();

    expect(editor.getMarkdown().trim()).toBe("hello \u00a9cat");
  });

  describe("a peer's edit arriving while the caret sits in the text", () => {
    // A second replica of the editor's own page makes `edit`; the editor
    // adopts the merged page the way the doc wiring hands it over.
    function peerEdit(
      editor: Editor,
      edit: (peer: EditorState) => { state: EditorState; ops: Operation[] },
    ) {
      const internals = editor as unknown as { _state: EditorState };
      const page = internals._state.document.page;
      const { ops } = edit(createInitialState(page));
      editor.updatePageFromSync(applyOps(page, ops), ops);
    }

    it("typing lands where the caret was, after text the peer added before it", async () => {
      const { editor, ime, frame } = setup("hello");
      await frame();

      peerEdit(editor, (peer) =>
        insertText(moveCursorToPosition(peer, 0, 0), "AB "),
      );
      await frame();
      ime.start();
      ime.update("X");
      ime.end();
      await frame();

      expect(editor.getMarkdown().trim()).toBe("AB helloX");
    });

    it("the caret stays in its paragraph when the peer adds one above", async () => {
      const { editor, ime, frame } = setup("first\n\nsecond", {
        block: 2,
        index: 6,
      });
      await frame();

      // Enter at the end of "first": a new empty paragraph lands above ours.
      peerEdit(editor, (peer) => splitBlock(moveCursorToPosition(peer, 0, 5)));
      await frame();
      ime.start();
      ime.update("X");
      ime.end();
      await frame();

      const state = (editor as unknown as { _state: EditorState })._state;
      const caret = state.document.cursor!.position;
      const texts = state.document.page.blocks
        .filter((b) => !b.deleted)
        .map((b) => getBlockTextContent(b));
      expect(texts).toContain("secondX");
      expect(
        getBlockTextContent(state.document.page.blocks[caret.blockIndex]),
      ).toBe("secondX");
    });

    it("a reopened word is committed in place after the peer typed before it", async () => {
      const { editor, ime, frame } = setup("one helo");
      await frame();

      ime.start(4); // reopen "helo"
      await frame();
      peerEdit(editor, (peer) =>
        insertText(moveCursorToPosition(peer, 0, 0), "AB "),
      );
      await frame();
      ime.update("hello");
      ime.end();
      await frame();

      expect(editor.getMarkdown().trim()).toBe("AB one hello");
    });
  });
});
