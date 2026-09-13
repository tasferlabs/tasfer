/**
 * Test-only editor harness (not shipped; nothing in `index.ts` imports it).
 *
 * Builds a real editor over a public `Doc` through the public `createEditor`
 * — the same wiring a host gets (local ops flow into the doc, doc updates from
 * other origins come back as `on("change")` with `isRemote: true`) — with no
 * DOM: a Proxy-backed fake element stands in for the container and the
 * canvases, and the text-measuring context is a stub. Like every module in
 * this package it imports only the public `@tasfer/editor` root.
 */

import type { Doc, Operation, TasferEditor } from "@tasfer/editor";
import { createDoc, createEditor } from "@tasfer/editor";

const VIEWPORT = { width: 800, height: 480 };

function fakeContext(): CanvasRenderingContext2D {
  return new Proxy(
    {
      globalAlpha: 1,
      canvas: {},
      measureText: (text: string) => ({
        width: text.length * 8,
        fontBoundingBoxAscent: 12,
        fontBoundingBoxDescent: 4,
        actualBoundingBoxAscent: 12,
        actualBoundingBoxDescent: 4,
      }),
      createLinearGradient: () => ({ addColorStop() {} }),
      getTransform: () => ({ a: 1, d: 1 }),
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
}

function rect() {
  return {
    left: 0,
    top: 0,
    right: VIEWPORT.width,
    bottom: VIEWPORT.height,
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    x: 0,
    y: 0,
    toJSON() {},
  };
}

/** A DOM element that swallows every method and carries plain data props. */
function fakeElement(tag: string): HTMLElement {
  const children: unknown[] = [];
  const ctx = tag === "canvas" ? fakeContext() : null;
  const data: Record<string, unknown> = {
    tagName: tag.toUpperCase(),
    nodeType: 1,
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
    childNodes: children,
    children,
    firstChild: null,
    lastChild: null,
    parentNode: null,
    parentElement: null,
    nextSibling: null,
    isConnected: true,
    textContent: "",
    innerText: "",
    innerHTML: "",
    contentEditable: "false",
    isContentEditable: false,
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    offsetWidth: VIEWPORT.width,
    offsetHeight: VIEWPORT.height,
    clientWidth: VIEWPORT.width,
    clientHeight: VIEWPORT.height,
    scrollTop: 0,
    scrollLeft: 0,
    getBoundingClientRect: rect,
    getClientRects: () => [rect()],
    appendChild: (child: unknown) => {
      children.push(child);
      return child;
    },
    insertBefore: (child: unknown) => {
      children.push(child);
      return child;
    },
    removeChild: (child: unknown) => child,
    contains: () => false,
    getAttribute: () => null,
    hasAttribute: () => false,
    querySelector: () => null,
    querySelectorAll: () => [],
    getContext: () => ctx,
    ownerDocument: (globalThis as any).document,
  };
  return new Proxy(data, {
    get(target, key) {
      if (key in target) return target[key as string];
      if (typeof key === "symbol") return undefined;
      return () => {};
    },
    set(target, key, value) {
      target[key as string] = value;
      return true;
    },
  }) as unknown as HTMLElement;
}

/** Complete the setup file's minimal DOM with what `mountEditor` touches. Idempotent. */
function installFakeDom(): void {
  const g = globalThis as any;
  const doc = (g.document ??= {});
  if (doc.createElement === fakeElement) return;
  doc.createElement = fakeElement;
  doc.createElementNS = (_ns: string, tag: string) => fakeElement(tag);
  doc.createTextNode = (text: string) => ({ nodeType: 3, textContent: text });
  doc.addEventListener ??= () => {};
  doc.removeEventListener ??= () => {};
  doc.visibilityState = "visible";
  doc.hidden = false;
  doc.activeElement = null;
  doc.body ??= fakeElement("body");
  doc.documentElement ??= fakeElement("html");
  doc.getSelection ??= () => null;
  doc.fonts ??= { ready: Promise.resolve(), addEventListener() {} };
  const win = (g.window ??= {});
  win.addEventListener ??= () => {};
  win.removeEventListener ??= () => {};
  win.devicePixelRatio ??= 1;
  win.matchMedia ??= () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  });
  win.getSelection ??= () => null;
  win.document = doc;
  if (typeof g.requestAnimationFrame !== "function") {
    g.requestAnimationFrame = () => 1;
    g.cancelAnimationFrame = () => {};
  }
  if (typeof g.ResizeObserver !== "function") {
    g.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  if (typeof g.getComputedStyle !== "function") {
    g.getComputedStyle = () => ({ getPropertyValue: () => "" });
  }
}

export interface Harness {
  editor: TasferEditor;
  doc: Doc;
  /** Block ids in document order. */
  blockIds: string[];
  /** Ops this replica produced locally (for feeding another replica). */
  localOps: Operation[];
  /** Apply another replica's ops as a remote update. */
  receive(ops: Operation[]): void;
  destroy(): void;
}

/**
 * Editor + doc from Markdown (or from another harness's `doc.encodeState()`
 * bytes, to make a second replica of the same document).
 */
export function createHarness(
  content: string | { bytes: Uint8Array },
  opts: { peerId?: string } = {},
): Harness {
  installFakeDom();
  const peerId = opts.peerId ?? `spell-test-${crypto.randomUUID().slice(0, 8)}`;
  const doc =
    typeof content === "string"
      ? createDoc({ markdown: content, peerId, pageId: "spell-page" })
      : createDoc({ bytes: content.bytes, peerId });
  const localOps: Operation[] = [];
  const offDoc = doc.on("update", (u) => {
    if (u.local) localOps.push(...u.ops);
  });
  const editor = createEditor({
    element: fakeElement("div"),
    doc,
    accessibilityTree: false,
  });
  return {
    editor,
    doc,
    blockIds: editor.query
      .blocks({ from: "start", to: "end" })
      .map((b) => b.id),
    localOps,
    receive: (ops) => doc.applyUpdate(ops, "remote"),
    destroy: () => {
      offDoc();
      editor.destroy();
      doc.destroy();
    },
  };
}
