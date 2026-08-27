/**
 * The authoring backstop: an edit that would leave the document unable to
 * satisfy `restrict({ blocks, content })` is rolled back whole, so the gesture
 * behind it does nothing.
 *
 * These drive real gestures through the event drain rather than calling a
 * transform directly — the point of the check is that it holds for transforms
 * that never ask, including a node's own key handler. Every shaped case is
 * paired with the same document under a schema that permits the edit, so a
 * refusal is never mistaken for a gesture that does nothing anyway.
 */

import { baseSchema } from "../schema";
import { editSatisfiesSchema } from "../schema-content";
import type { Block, Page } from "../serlization/loadPage";
import type { EditorState, Operation, ViewportState } from "../state-types";
import { createInitialState } from "../state-utils";
import { getVisibleTextFromRuns } from "../sync/char-runs";
import { applyOps } from "../sync/reducer";
import type { DataSchema } from "../sync/schema";
import { createChromeRegionRegistry } from "./chromeRegions";
import { handleEvents } from "./events";
import { createInteractionSession } from "./interaction-session";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  const d = (globalThis as unknown as { document: Record<string, unknown> })
    .document;
  if (!d.body) d.body = { appendChild: () => {}, removeChild: () => {} };
});

const viewport: ViewportState = {
  width: 800,
  height: 1000,
  scrollY: 0,
  documentHeight: 2000,
};

/** Valid fractional-index keys, in document order, for the ids used here. */
const ORDER: Record<string, string> = { b1: "a0", b2: "a1", b3: "a2" };

function textual(id: string, type: string, text: string, indent = 0): Block {
  return {
    id,
    orderKey: ORDER[id],
    deleted: false,
    type,
    charRuns: text
      ? [{ peerId: "peer", startCounter: 0, text }]
      : ([] as unknown as never),
    formats: [],
    indent,
  } as unknown as Block;
}

function image(id: string): Block {
  return {
    id,
    orderKey: ORDER[id],
    deleted: false,
    type: "image",
    url: "https://example.com/a.png",
  } as unknown as Block;
}

function pageWith(blocks: Block[]): Page {
  return { id: "page-1", title: "t", blocks };
}

type Restriction = Parameters<typeof baseSchema.restrict>[0];

function stateWith(page: Page, restriction?: Restriction): EditorState {
  const schema = (restriction ? baseSchema.restrict(restriction) : baseSchema)
    .data;
  const base = createInitialState(page, { schema: schema as DataSchema });
  return { ...base, view: { ...base.view, isFocused: true } };
}

function caretAt(
  state: EditorState,
  blockIndex: number,
  textIndex: number,
): EditorState {
  return {
    ...state,
    document: {
      ...state.document,
      cursor: { position: { blockIndex, textIndex }, lastUpdate: 0 },
      selection: null,
    },
  };
}

/** A whole-block (node) selection — anchor and focus on the same block. */
function nodeSelected(state: EditorState, blockIndex: number): EditorState {
  const at = { blockIndex, textIndex: 0 };
  return {
    ...state,
    document: {
      ...state.document,
      cursor: { position: at, lastUpdate: 0 },
      selection: { anchor: at, focus: at, isForward: true, isCollapsed: false },
    },
  };
}

type Mods = Partial<Record<"metaKey" | "ctrlKey" | "shiftKey", boolean>>;

function key(name: string, mods: Mods = {}): Event {
  return {
    type: "keydown",
    key: name,
    code: name,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    isTrusted: true,
    preventDefault() {},
    stopPropagation() {},
    ...mods,
  } as unknown as Event;
}

function press(
  state: EditorState,
  ...keys: Event[]
): { state: EditorState; ops: Operation[] } {
  const session = createInteractionSession(createChromeRegionRegistry());
  const result = handleEvents(
    state,
    viewport,
    {
      start: 0,
      end: state.view.visibleBlocks.length - 1,
      startY: 0,
      scrollY: 0,
    },
    keys as never,
    viewport.documentHeight,
    { left: 0, top: 0 },
    session,
  );
  return { state: result.state, ops: result.ops };
}

function visibleTypes(state: EditorState): string[] {
  return state.document.page.blocks
    .filter((b) => !b.deleted)
    .map((b) => b.type);
}

function textOf(state: EditorState, blockIndex: number): string {
  return getVisibleTextFromRuns(
    (state.document.page.blocks[blockIndex] as { charRuns?: [] }).charRuns,
  );
}

describe("a delete the shape cannot afford", () => {
  const heading = () =>
    pageWith([
      textual("b1", "heading1", "Title"),
      textual("b2", "paragraph", "body"),
    ]);

  it("refuses the Backspace-merge that would remove a required block", () => {
    const before = caretAt(
      stateWith(heading(), { content: "heading1 paragraph" }),
      1,
      0,
    );
    const after = press(before, key("Backspace"));

    expect(after.ops).toHaveLength(0);
    expect(after.state.document.page).toBe(before.document.page);
    expect(visibleTypes(after.state)).toEqual(["heading1", "paragraph"]);
  });

  it("allows the same merge when the shape can spare the block", () => {
    const before = caretAt(
      stateWith(heading(), { content: "heading1 paragraph*" }),
      1,
      0,
    );
    const after = press(before, key("Backspace"));

    expect(after.ops.length).toBeGreaterThan(0);
    expect(visibleTypes(after.state)).toEqual(["heading1"]);
    expect(textOf(after.state, 0)).toBe("Titlebody");
  });

  const listFirst = () =>
    pageWith([
      textual("b1", "bullet_list", ""),
      textual("b2", "paragraph", "body"),
    ]);

  it("refuses the implicit list → paragraph demote at indent 0", () => {
    const before = caretAt(
      stateWith(listFirst(), { content: "bullet_list paragraph" }),
      0,
      0,
    );
    const after = press(before, key("Backspace"));

    expect(after.ops).toHaveLength(0);
    expect(visibleTypes(after.state)).toEqual(["bullet_list", "paragraph"]);
  });

  it("allows that demote when the shape admits a paragraph there", () => {
    const before = caretAt(
      stateWith(listFirst(), { content: "(bullet_list|paragraph) paragraph" }),
      0,
      0,
    );
    const after = press(before, key("Backspace"));

    expect(visibleTypes(after.state)).toEqual(["paragraph", "paragraph"]);
  });

  it("refuses the forward-delete merge the same way", () => {
    const before = caretAt(
      stateWith(heading(), { content: "heading1 paragraph" }),
      0,
      "Title".length,
    );
    const after = press(before, key("Delete"));

    expect(after.ops).toHaveLength(0);
    expect(visibleTypes(after.state)).toEqual(["heading1", "paragraph"]);
  });

  it("refuses deleting a node-selected block the shape requires", () => {
    const page = pageWith([image("b1"), textual("b2", "paragraph", "caption")]);
    const before = nodeSelected(
      stateWith(page, { content: "image paragraph" }),
      0,
    );
    const after = press(before, key("Backspace"));

    expect(after.ops).toHaveLength(0);
    expect(visibleTypes(after.state)).toEqual(["image", "paragraph"]);
  });

  it("allows it when the paragraph minted in its place satisfies the shape", () => {
    // The lone image empties the document, so the delete path mints an empty
    // paragraph — the check judges what the edit actually leaves behind.
    const before = nodeSelected(
      stateWith(pageWith([image("b1")]), { content: "(image|paragraph)+" }),
      0,
    );
    const after = press(before, key("Backspace"));

    expect(visibleTypes(after.state)).toEqual(["paragraph"]);
  });
});

describe("a split the shape cannot afford", () => {
  it("refuses Enter when no continuation type fits", () => {
    const page = pageWith([textual("b1", "heading1", "Title")]);
    const before = caretAt(stateWith(page, { content: "heading1" }), 0, 5);
    const after = press(before, key("Enter"));

    expect(after.ops).toHaveLength(0);
    expect(visibleTypes(after.state)).toEqual(["heading1"]);
  });
});

describe("a schema with no content expression is unaffected", () => {
  it("merges on Backspace as before", () => {
    const page = pageWith([
      textual("b1", "heading1", "Title"),
      textual("b2", "paragraph", "body"),
    ]);
    const after = press(caretAt(stateWith(page), 1, 0), key("Backspace"));

    expect(visibleTypes(after.state)).toEqual(["heading1"]);
    expect(textOf(after.state, 0)).toBe("Titlebody");
  });

  it("demotes an empty list item at indent 0 as before", () => {
    const page = pageWith([
      textual("b1", "bullet_list", ""),
      textual("b2", "paragraph", "body"),
    ]);
    const after = press(caretAt(stateWith(page), 0, 0), key("Backspace"));

    expect(visibleTypes(after.state)).toEqual(["paragraph", "paragraph"]);
  });

  it("splits on Enter as before", () => {
    const page = pageWith([textual("b1", "heading1", "Title")]);
    const after = press(caretAt(stateWith(page), 0, 5), key("Enter"));

    expect(visibleTypes(after.state)).toEqual(["heading1", "paragraph"]);
  });
});

describe("the allow-list half", () => {
  const state = (blocks?: Restriction["blocks"]) =>
    stateWith(
      pageWith([textual("b1", "paragraph", "a")]),
      blocks && { blocks },
    );

  const insert = (blockType: string): Operation =>
    ({
      op: "block_insert",
      id: "op-1",
      clock: { counter: 1, peerId: "peer" },
      pageId: "page-1",
      orderKey: "a1",
      blockId: "b2",
      blockType,
    }) as unknown as Operation;

  const retype = (value: string): Operation =>
    ({
      op: "block_set",
      id: "op-2",
      clock: { counter: 2, peerId: "peer" },
      pageId: "page-1",
      blockId: "b1",
      field: "type",
      value,
    }) as unknown as Operation;

  it("refuses an op that mints a type the user may not create", () => {
    const s = state(["paragraph"]);
    expect(editSatisfiesSchema(s, s, [insert("image")])).toBe(false);
    expect(editSatisfiesSchema(s, s, [retype("heading1")])).toBe(false);
  });

  it("passes ops that stay inside the allow-list", () => {
    const s = state(["paragraph", "heading1"]);
    expect(editSatisfiesSchema(s, s, [insert("paragraph")])).toBe(true);
    expect(editSatisfiesSchema(s, s, [retype("heading1")])).toBe(true);
  });

  it("passes everything for an unrestricted schema", () => {
    const s = state();
    expect(editSatisfiesSchema(s, s, [insert("image")])).toBe(true);
    expect(editSatisfiesSchema(s, s, [retype("heading1")])).toBe(true);
  });
});

describe("a peer on a looser schema", () => {
  // The authoring check never runs on remote ops: the reducer is deliberately
  // allow-list- and shape-agnostic, so two peers materialize one op log
  // identically no matter how each has restricted its own authoring.
  const remoteRetype = (blockId: string, value: string): Operation =>
    ({
      op: "block_set",
      id: "loose-peer:7",
      clock: { counter: 7, peerId: "loose-peer" },
      pageId: "page-1",
      blockId,
      field: "type",
      value,
    }) as unknown as Operation;

  const shaped = () =>
    stateWith(
      pageWith([
        textual("b1", "heading1", "Title"),
        textual("b2", "paragraph", "body"),
      ]),
      { blocks: ["heading1", "paragraph"], content: "heading1 paragraph" },
    );

  it("converges: an op that breaks the shape still applies verbatim", () => {
    const restricted = shaped();
    const op = remoteRetype("b1", "quote");

    // Both peers run the same reducer over the same op; only the schema they
    // pass differs (the restricted one forbids `quote` outright).
    const here = applyOps(restricted.document.page, [op], restricted.schema);
    const there = applyOps(
      restricted.document.page,
      [op],
      stateWith(pageWith([])).schema,
    );

    expect(here.blocks.map((b) => b.type)).toEqual(["quote", "paragraph"]);
    expect(here.blocks.map((b) => [b.id, b.type, b.orderKey])).toEqual(
      there.blocks.map((b) => [b.id, b.type, b.orderKey]),
    );
  });

  it("leaves the restricted peer editable on the document it produced", () => {
    // `quote paragraph` satisfies neither the allow-list nor the shape, yet a
    // Backspace-merge that would be refused on a valid document goes through —
    // refusing here would strand the user on a document they cannot repair.
    const restricted = shaped();
    const page = applyOps(
      restricted.document.page,
      [remoteRetype("b1", "quote")],
      restricted.schema,
    );
    const before = caretAt(
      { ...restricted, document: { ...restricted.document, page } },
      1,
      0,
    );
    const after = press(before, key("Backspace"));

    expect(after.ops.length).toBeGreaterThan(0);
    expect(visibleTypes(after.state)).toEqual(["quote"]);
  });
});

describe("two peers on the SAME restricted schema", () => {
  // Each peer checks the edit against the document it can see. Two edits that
  // are each valid on their own replica can merge into a sequence that is not:
  // a `content` expression is a local authoring guard, not an invariant the
  // CRDT can hold. The peers still agree — they converge on the same document.
  const restriction = { content: "heading1 paragraph+" } as const;
  const shared = () =>
    pageWith([
      textual("b1", "heading1", "Title"),
      textual("b2", "paragraph", "aaa"),
      textual("b3", "paragraph", "bbb"),
    ]);

  it("converges on a document neither peer would have authored", () => {
    // Peer A merges the last paragraph away: heading1 paragraph — valid.
    const a = press(
      caretAt(stateWith(shared(), restriction), 2, 0),
      key("Backspace"),
    );
    expect(visibleTypes(a.state)).toEqual(["heading1", "paragraph"]);

    // Peer B, concurrently, merges the first paragraph into the heading:
    // heading1 paragraph — also valid, and also allowed.
    const b = press(
      caretAt(stateWith(shared(), restriction), 1, 0),
      key("Backspace"),
    );
    expect(visibleTypes(b.state)).toEqual(["heading1", "paragraph"]);

    // Exchange. Neither op was refusable when it was made.
    const schema = stateWith(shared(), restriction).schema;
    const aThenB = applyOps(a.state.document.page, b.ops, schema);
    const bThenA = applyOps(b.state.document.page, a.ops, schema);

    expect(aThenB.blocks.map((x) => [x.id, x.type, !!x.deleted])).toEqual(
      bThenA.blocks.map((x) => [x.id, x.type, !!x.deleted]),
    );

    const merged = aThenB.blocks.filter((x) => !x.deleted).map((x) => x.type);
    expect(merged).toEqual(["heading1"]);
    expect(schema.contentAccepts(merged)).toBe(false);
  });
});
