import {
  type DecorationLayers,
  setDecorationLayer,
} from "../rendering/decorations";
import { loadPage } from "../serlization/loadPage";
import { isTextualBlock } from "../sync/block-registry";
import {
  collectTextNodes,
  decorationBlockIds,
  DomMirror,
  invalidRangesForBlock,
  planInvalidSegments,
  wrapInvalidRanges,
} from "./dom-mirror";
import { describe, expect, it } from "vitest";

// -----------------------------------------------------------------------------
// A hand-rolled DOM: just enough Node/Text/Element for the mirror's patching
// glue (childNodes, insertBefore, removeChild, replaceWith, setAttribute, a
// `<template>` whose innerHTML parses a flat tag soup). No jsdom in this
// package, and the mirror deliberately walks `childNodes` rather than a
// TreeWalker so this stays sufficient.
// -----------------------------------------------------------------------------

class FakeNode {
  nodeType = 0;
  childNodes: FakeNode[] = [];
  parentNode: FakeNode | null = null;

  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null;
  }

  get nextSibling(): FakeNode | null {
    const parent = this.parentNode;
    if (!parent) return null;
    return parent.childNodes[parent.childNodes.indexOf(this) + 1] ?? null;
  }

  appendChild(node: FakeNode): FakeNode {
    return this.insertBefore(node, null);
  }

  insertBefore(node: FakeNode, ref: FakeNode | null): FakeNode {
    node.parentNode?.removeChild(node);
    const index = ref ? this.childNodes.indexOf(ref) : this.childNodes.length;
    this.childNodes.splice(index, 0, node);
    node.parentNode = this;
    return node;
  }

  removeChild(node: FakeNode): FakeNode {
    const index = this.childNodes.indexOf(node);
    if (index >= 0) this.childNodes.splice(index, 1);
    node.parentNode = null;
    return node;
  }

  replaceWith(node: FakeNode): void {
    const parent = this.parentNode;
    if (!parent) return;
    parent.insertBefore(node, this);
    parent.removeChild(this);
  }

  serialize(): string {
    return "";
  }
}

class FakeText extends FakeNode {
  override nodeType = 3;
  data: string;
  constructor(data: string) {
    super();
    this.data = data;
  }
  override serialize(): string {
    return this.data;
  }
}

const VOID_TAGS = new Set(["br", "img", "input", "hr"]);

class FakeElement extends FakeNode {
  override nodeType = 1;
  readonly attrs = new Map<string, string>();
  readonly tagName: string;
  constructor(tagName: string) {
    super();
    this.tagName = tagName;
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }

  get className(): string {
    return this.attrs.get("class") ?? "";
  }

  set className(value: string) {
    if (value) this.attrs.set("class", value);
    else this.attrs.delete("class");
  }

  get firstElementChild(): FakeElement | null {
    for (const child of this.childNodes) {
      if (child instanceof FakeElement) return child;
    }
    return null;
  }

  /** `<template>.content` — the fake keeps the parsed nodes on itself. */
  get content(): FakeElement {
    return this;
  }

  get innerHTML(): string {
    return this.childNodes.map((child) => child.serialize()).join("");
  }

  set innerHTML(html: string) {
    this.childNodes = [];
    parseInto(this, html);
  }

  get outerHTML(): string {
    const attrs = [...this.attrs]
      .map(([name, value]) => ` ${name}="${value}"`)
      .join("");
    const tag = this.tagName.toLowerCase();
    if (VOID_TAGS.has(tag)) return `<${tag}${attrs}>`;
    return `<${tag}${attrs}>${this.innerHTML}</${tag}>`;
  }

  override serialize(): string {
    return this.outerHTML;
  }
}

function decodeEntities(text: string): string {
  return text.replace(
    /&(#\d+|#x[0-9a-f]+|[a-z]+);/gi,
    (match, body: string) => {
      if (body[0] === "#") {
        const code =
          body[1] === "x" || body[1] === "X"
            ? parseInt(body.slice(2), 16)
            : parseInt(body.slice(1), 10);
        return String.fromCodePoint(code);
      }
      const named: Record<string, string> = {
        amp: "&",
        lt: "<",
        gt: ">",
        quot: '"',
        apos: "'",
        nbsp: " ",
      };
      return named[body.toLowerCase()] ?? match;
    },
  );
}

const TOKEN =
  /<\/([a-zA-Z0-9-]+)\s*>|<([a-zA-Z0-9-]+)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*\/?>|([^<]+)/g;
const ATTR = /([^\s=>/]+)(?:="([^"]*)")?/g;

function parseInto(root: FakeElement, html: string): void {
  const stack: FakeElement[] = [root];
  for (const match of html.matchAll(TOKEN)) {
    const [, close, open, attrs, text] = match;
    const top = stack[stack.length - 1];
    if (text !== undefined) {
      top.appendChild(new FakeText(decodeEntities(text)));
    } else if (open !== undefined) {
      const el = new FakeElement(open.toUpperCase());
      for (const attr of attrs.matchAll(ATTR)) {
        el.setAttribute(attr[1], decodeEntities(attr[2] ?? ""));
      }
      top.appendChild(el);
      if (!VOID_TAGS.has(open.toLowerCase())) stack.push(el);
    } else if (close !== undefined && stack.length > 1) {
      stack.pop();
    }
  }
}

function fakeDocument(): Document {
  return {
    createElement: (tag: string) => new FakeElement(tag.toUpperCase()),
    createTextNode: (text: string) => new FakeText(text),
    defaultView: null,
  } as unknown as Document;
}

function el(tag: string, ...children: FakeNode[]): FakeElement {
  const node = new FakeElement(tag.toUpperCase());
  for (const child of children) node.appendChild(child);
  return node;
}

/** The mirror's DOM glue is typed against `Node`; the fake stands in for it. */
function asNode(node: FakeNode): Node {
  return node as unknown as Node;
}

function text(data: string): FakeText {
  return new FakeText(data);
}

// -----------------------------------------------------------------------------

describe("planInvalidSegments", () => {
  it("leaves untouched nodes as one null segment", () => {
    expect(planInvalidSegments([5, 3], [])).toEqual([
      [{ start: 0, end: 5, invalid: null }],
      [{ start: 0, end: 3, invalid: null }],
    ]);
  });

  it("splits a single node at both range boundaries", () => {
    expect(
      planInvalidSegments([18], [{ from: 8, to: 12, invalid: "spelling" }]),
    ).toEqual([
      [
        { start: 0, end: 8, invalid: null },
        { start: 8, end: 12, invalid: "spelling" },
        { start: 12, end: 18, invalid: null },
      ],
    ]);
  });

  it("clips a range that straddles two nodes to each node's edge", () => {
    // "this is " | "helo" | " world" with a range over "is he" (5..10).
    expect(
      planInvalidSegments([8, 4, 6], [{ from: 5, to: 10, invalid: "grammar" }]),
    ).toEqual([
      [
        { start: 0, end: 5, invalid: null },
        { start: 5, end: 8, invalid: "grammar" },
      ],
      [
        { start: 0, end: 2, invalid: "grammar" },
        { start: 2, end: 4, invalid: null },
      ],
      [{ start: 0, end: 6, invalid: null }],
    ]);
  });

  it("covers a whole node without emitting empty segments", () => {
    expect(
      planInvalidSegments([4, 4], [{ from: 4, to: 8, invalid: "spelling" }]),
    ).toEqual([
      [{ start: 0, end: 4, invalid: null }],
      [{ start: 0, end: 4, invalid: "spelling" }],
    ]);
  });

  it("lets the later range win where two overlap, and ignores empty ranges", () => {
    expect(
      planInvalidSegments(
        [10],
        [
          { from: 2, to: 6, invalid: "spelling" },
          { from: 4, to: 8, invalid: "grammar" },
          { from: 9, to: 9, invalid: "true" },
        ],
      ),
    ).toEqual([
      [
        { start: 0, end: 2, invalid: null },
        { start: 2, end: 4, invalid: "spelling" },
        { start: 4, end: 6, invalid: "grammar" },
        { start: 6, end: 8, invalid: "grammar" },
        { start: 8, end: 10, invalid: null },
      ],
    ]);
  });

  it("keeps an empty node as one empty segment", () => {
    expect(
      planInvalidSegments([0], [{ from: 0, to: 1, invalid: "true" }]),
    ).toEqual([[{ start: 0, end: 0, invalid: null }]]);
  });
});

describe("wrapInvalidRanges", () => {
  it("wraps the covered slice of a text node in a span carrying only aria-invalid", () => {
    const root = el("p", text("this is helo world"));
    const ran = wrapInvalidRanges(
      asNode(root),
      [{ from: 8, to: 12, invalid: "spelling" }],
      18,
      fakeDocument(),
    );
    expect(ran).toBe(true);
    expect(root.outerHTML).toBe(
      '<p>this is <span aria-invalid="spelling">helo</span> world</p>',
    );
  });

  it("splits across marks without disturbing their nesting", () => {
    const root = el(
      "p",
      text("this is "),
      el("strong", text("helo")),
      text(" world"),
    );
    wrapInvalidRanges(
      asNode(root),
      [{ from: 5, to: 10, invalid: "grammar" }],
      18,
      fakeDocument(),
    );
    expect(root.outerHTML).toBe(
      '<p>this <span aria-invalid="grammar">is </span><strong><span aria-invalid="grammar">he</span>lo</strong> world</p>',
    );
  });

  it("skips the whole block when the mirrored text does not align with the visible length", () => {
    // A soft break serialized as <br> drops one character from the text nodes.
    const root = el("p", text("ab"), el("br"), text("cd"));
    const ran = wrapInvalidRanges(
      asNode(root),
      [{ from: 3, to: 5, invalid: "spelling" }],
      5,
      fakeDocument(),
    );
    expect(ran).toBe(false);
    expect(root.outerHTML).toBe("<p>ab<br>cd</p>");
  });

  it("is a no-op for an empty range list", () => {
    const root = el("p", text("abc"));
    expect(wrapInvalidRanges(asNode(root), [], 3, fakeDocument())).toBe(true);
    expect(root.outerHTML).toBe("<p>abc</p>");
  });

  it("collects text nodes depth-first in document order", () => {
    const root = el(
      "p",
      text("a"),
      el("em", text("b"), el("code", text("c"))),
      text("d"),
    );
    expect(collectTextNodes(asNode(root)).map((node) => node.data)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });
});

describe("invalidRangesForBlock", () => {
  it("resolves flat and character-anchored a11y ranges, ignoring the rest", () => {
    const page = loadPage("this is helo world");
    const block = page.blocks[0];
    if (!block || !isTextualBlock(block) || !block.charRuns[0]) {
      throw new Error("expected a textual block");
    }
    const run = block.charRuns[0];
    const layers = setDecorationLayer({}, "hints", [
      {
        kind: "range",
        range: {
          from: { block: block.id, offset: 8 },
          to: { block: block.id, offset: 12 },
        },
        color: "#f00",
        a11y: { invalid: "spelling" },
      },
      {
        kind: "range",
        range: {
          from: {
            blockId: block.id,
            afterCharId: `${run.peerId}:${run.startCounter + 12}`,
          },
          to: {
            blockId: block.id,
            afterCharId: `${run.peerId}:${run.startCounter + 17}`,
          },
        },
        color: "#0f0",
        a11y: { invalid: "grammar" },
      },
      // Plain visual decoration: no a11y, nothing to project.
      {
        kind: "range",
        range: {
          from: { block: block.id, offset: 0 },
          to: { block: block.id, offset: 4 },
        },
        color: "#00f",
      },
    ]);
    expect(invalidRangesForBlock(layers, page, block, 18)).toEqual([
      { from: 8, to: 12, invalid: "spelling" },
      { from: 13, to: 18, invalid: "grammar" },
    ]);
  });

  it("clips a range spanning blocks to each block it passes through", () => {
    const page = loadPage("aaaa\n\nbbbb\n\ncccc");
    const [a, b, c] = page.blocks;
    if (!a || !b || !c) throw new Error("expected three blocks");
    const layers = setDecorationLayer({}, "hints", [
      {
        kind: "range",
        range: {
          from: { block: a.id, offset: 2 },
          to: { block: c.id, offset: 1 },
        },
        color: "#f00",
        a11y: { invalid: "true" },
      },
    ]);
    expect(invalidRangesForBlock(layers, page, a, 4)).toEqual([
      { from: 2, to: 4, invalid: "true" },
    ]);
    expect(invalidRangesForBlock(layers, page, b, 4)).toEqual([
      { from: 0, to: 4, invalid: "true" },
    ]);
    expect(invalidRangesForBlock(layers, page, c, 4)).toEqual([
      { from: 0, to: 1, invalid: "true" },
    ]);
  });
});

describe("decorationBlockIds", () => {
  it("unions the block ids of every decoration kind across old and new contents", () => {
    const ids = decorationBlockIds(
      [
        { kind: "block", block: "b1", color: "#000" },
        {
          kind: "caret",
          point: { blockId: "b2", afterCharId: null },
          color: "#000",
        },
      ],
      undefined,
      [
        {
          kind: "range",
          range: {
            from: { block: "b3", offset: 0 },
            to: { block: "b4", offset: 0 },
          },
          color: "#000",
        },
      ],
    );
    expect([...ids].sort()).toEqual(["b1", "b2", "b3", "b4"]);
  });
});

describe("DomMirror a11y decorations", () => {
  function mount(markdown: string) {
    const page = loadPage(markdown);
    let layers: DecorationLayers = {};
    const container = new FakeElement("DIV");
    const mirror = new DomMirror({
      container: container as unknown as HTMLElement,
      getBlocks: () => page.blocks,
      getDecorations: () => layers,
      doc: fakeDocument(),
    });
    return {
      page,
      container,
      mirror,
      setLayers: (next: DecorationLayers) => {
        layers = next;
      },
    };
  }

  it("projects a spelling decoration as aria-invalid and drops it when the layer clears", () => {
    const { page, container, mirror, setLayers } = mount("this is helo world");
    const block = page.blocks[0];
    if (!block) throw new Error("expected a block");
    expect(container.innerHTML).toBe(
      `<p data-block-id="${block.id}">this is helo world</p>`,
    );

    const decorations = [
      {
        kind: "range" as const,
        range: {
          from: { block: block.id, offset: 8 },
          to: { block: block.id, offset: 12 },
        },
        color: "#e11d48",
        a11y: { invalid: "spelling" as const },
      },
    ];
    setLayers(setDecorationLayer({}, "hints", decorations));
    // No frame scheduler on the fake document, so the flush is synchronous.
    mirror.applyDecorations([block.id]);
    expect(container.innerHTML).toBe(
      `<p data-block-id="${block.id}">this is <span aria-invalid="spelling">helo</span> world</p>`,
    );

    // Re-applying the same store is idempotent: the block is rebuilt from
    // scratch, never wrapped twice.
    mirror.applyDecorations([block.id]);
    expect(container.innerHTML).toBe(
      `<p data-block-id="${block.id}">this is <span aria-invalid="spelling">helo</span> world</p>`,
    );

    setLayers({});
    mirror.applyDecorations([block.id]);
    expect(container.innerHTML).toBe(
      `<p data-block-id="${block.id}">this is helo world</p>`,
    );
  });

  it("splits around inline marks the serializer emitted", () => {
    const { page, container, mirror, setLayers } = mount(
      "this is **helo** world",
    );
    const block = page.blocks[0];
    if (!block) throw new Error("expected a block");
    setLayers(
      setDecorationLayer({}, "hints", [
        {
          kind: "range",
          range: {
            from: { block: block.id, offset: 5 },
            to: { block: block.id, offset: 10 },
          },
          color: "#e11d48",
          a11y: { invalid: "grammar" },
        },
      ]),
    );
    mirror.applyDecorations([block.id]);
    expect(container.innerHTML).toBe(
      `<p data-block-id="${block.id}">this <span aria-invalid="grammar">is </span><strong><span aria-invalid="grammar">he</span>lo</strong> world</p>`,
    );
  });
});
