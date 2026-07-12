import { convertBlockAtCursor, deleteForward } from "../actions/actions";
import type { HostClipboard } from "../actions/clipboard";
import { createFeatureMarkInRange } from "../actions/structured-marks";
import { mathExtension } from "../math-extension";
import { createMarkRegistry } from "../rendering/marks";
import { createNodeRegistry } from "../rendering/nodes";
import { baseSchema } from "../schema";
import { moveCursorToPosition } from "../selection";
import { loadPage } from "../serlization/loadPage";
import type { Operation, ViewportState } from "../state-types";
import { createInitialState } from "../state-utils";
import type { ContentSelection } from "../structured-selection";
import {
  applyStructuredEdit,
  createStructuredDocument,
  type StructuredDocument,
} from "../sync/structured-content";
import { createCRDTbinding } from "../sync/sync";
import { type ChangeApi, type DocRange, Editor } from "./editor";
import type { CanvasLayers } from "./layers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const VIEWPORT: ViewportState = {
  scrollY: 0,
  width: 640,
  height: 480,
  documentHeight: 480,
};

function authoritativeDocument(contentId: string): StructuredDocument {
  return applyStructuredEdit(
    { ...createStructuredDocument("example", contentId), authority: "block" },
    {
      kind: "node_insert",
      node: {
        id: contentId,
        type: "root",
        placement: { parentId: null, slot: "", orderKey: "" },
      },
    },
  );
}

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

function createTestEditor() {
  const page = loadPage("shadow");
  const binding = createCRDTbinding(page.id, "public-content-api");
  const editor = new Editor(
    canvasLayers(),
    createInitialState(page, { crdtBinding: binding }),
    VIEWPORT,
  );
  return { editor, blockId: page.blocks[0].id };
}

function createMathEditor(
  displayEditing: "legacy" | "tree",
  markdown = "$$\nabcd\n$$",
) {
  const schema = baseSchema.use(mathExtension({ displayEditing }));
  const page = loadPage(markdown, schema.data);
  const binding = createCRDTbinding(page.id, `public-math-${displayEditing}`);
  const editor = new Editor(
    canvasLayers(),
    createInitialState(page, {
      schema: schema.data,
      nodes: createNodeRegistry(schema.nodes),
      marks: createMarkRegistry(schema.marks),
      crdtBinding: binding,
    }),
    VIEWPORT,
  );
  return {
    editor,
    blockId: page.blocks[0].id,
    blockIds: page.blocks.map((block) => block.id),
  };
}

function createAttachedInlineMathEditor() {
  const schema = baseSchema.use(mathExtension());
  let page = loadPage("axyb", schema.data);
  const binding = createCRDTbinding(page.id, "public-inline-attached");
  const blockId = page.blocks[0].id;
  page = createFeatureMarkInRange(
    page,
    blockId,
    1,
    3,
    { type: "math" },
    binding,
    schema.data,
  ).newPage;
  const editor = new Editor(
    canvasLayers(),
    createInitialState(page, {
      schema: schema.data,
      nodes: createNodeRegistry(schema.nodes),
      marks: createMarkRegistry(schema.marks),
      crdtBinding: binding,
    }),
    VIEWPORT,
  );
  return { editor, blockId };
}

describe("Editor structured-content public API", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    Object.assign(window, { removeEventListener() {} });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("allocates feature identities from the change's document allocator", () => {
    const { editor, blockId } = createTestEditor();
    const contentId = `${blockId}/diagram`;
    let featureNodeId = "";

    expect(
      editor.change((change) => {
        featureNodeId = change.identities.nextId();
        change.editContent(blockId, contentId, [
          {
            kind: "document_init",
            document: authoritativeDocument(contentId),
          },
          {
            kind: "node_insert",
            node: {
              id: featureNodeId,
              type: "shape",
              placement: {
                parentId: contentId,
                slot: "children",
                orderKey: "a0",
              },
            },
          },
        ]);
      }),
    ).toBe(true);

    expect(featureNodeId).toMatch(/^public-content-api:\d+$/);
    expect(
      editor.query.content(blockId, contentId)?.nodes[featureNodeId],
    ).toBeDefined();
    editor.destroy();
  });

  it("edits, queries, selects, and undoes generic content in one transaction", () => {
    const { editor, blockId } = createTestEditor();
    const contentId = `${blockId}/content`;
    const selection: ContentSelection = {
      anchor: {
        kind: "gap",
        blockId,
        contentId,
        parentId: contentId,
        slot: "children",
        afterNodeId: null,
        affinity: "forward",
      },
      focus: {
        kind: "gap",
        blockId,
        contentId,
        parentId: contentId,
        slot: "children",
        afterNodeId: null,
        affinity: "forward",
      },
      lastUpdate: 42,
    };
    const broadcasts: Operation[][] = [];
    editor.setBroadcast((ops) => broadcasts.push(ops));

    expect(
      editor.change((change) => {
        change
          .editContent(blockId, contentId, [
            {
              kind: "document_init",
              document: authoritativeDocument(contentId),
            },
            {
              kind: "node_attr_set",
              nodeId: contentId,
              key: "label",
              value: "changed",
            },
          ])
          .selectContent(selection);
      }),
    ).toBe(true);

    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]).toHaveLength(2);
    expect(broadcasts[0].every((op) => op.op === "content_edit")).toBe(true);
    expect(editor.state.contentSelection).toEqual(selection);
    expect(editor.state.selection.range).toBeNull();

    const queried = editor.query.content(blockId, contentId);
    expect(queried?.nodes[contentId].attrs.label).toBe("changed");

    // The query boundary returns plain detached data, never the live CRDT value.
    (queried!.nodes[contentId].attrs as Record<string, unknown>).label =
      "mutated snapshot";
    expect(
      editor.query.content(blockId, contentId)?.nodes[contentId].attrs.label,
    ).toBe("changed");

    expect(editor.undo()).toBe(true);
    const undone = editor.query.content(blockId, contentId);
    expect(undone).not.toBeNull();
    expect(undone?.nodes[contentId]).toBeDefined();
    expect(undone?.nodes[contentId].attrs.label).toBeUndefined();
    // Initialization is monotonic; only the user attribute edit is inverted.
    expect(broadcasts[1]).toHaveLength(1);
    expect(broadcasts[1][0]).toMatchObject({
      op: "content_edit",
      edit: { kind: "node_attr_delete", nodeId: contentId, key: "label" },
    });

    editor.destroy();
  });

  it("rejects explicit flat text and mark ranges owned by block content", () => {
    const { editor, blockId } = createTestEditor();
    const contentId = `${blockId}/content`;
    editor.setBroadcast(() => {});
    editor.change((change) =>
      change.editContent(blockId, contentId, {
        kind: "document_init",
        document: authoritativeDocument(contentId),
      }),
    );

    const range = {
      from: { block: blockId, offset: 0 },
      to: { block: blockId, offset: 1 },
    } as const;
    expect(
      editor.change((change) => {
        change
          .insertText("X", range)
          .deleteRange(range)
          .setMark("strong", { active: true, range });
      }),
    ).toBe(false);
    expect(editor.query.block({ block: blockId })?.text).toBe("shadow");
    expect(editor.query.marks({ block: blockId, offset: 0 })).toEqual([]);

    editor.destroy();
  });

  it("routes explicit ChangeApi replacement and deletion through tree migration", () => {
    const edits: Array<{
      expected: string;
      apply(change: ChangeApi, range: DocRange): void;
    }> = [
      {
        expected: "$$\naXd\n$$",
        apply: (change, range) => {
          change.insertText("X", range);
        },
      },
      {
        expected: "$$\nad\n$$",
        apply: (change, range) => {
          change.deleteRange(range);
        },
      },
    ];
    for (const edit of edits) {
      const { editor, blockId } = createMathEditor("tree");
      const broadcasts: Operation[][] = [];
      editor.setBroadcast((ops) => broadcasts.push(ops));
      const range = {
        from: { block: blockId, offset: 1 },
        to: { block: blockId, offset: 3 },
      } as const;

      expect(editor.change((change) => edit.apply(change, range))).toBe(true);
      expect(editor.getMarkdown()).toBe(edit.expected);
      expect(broadcasts).toHaveLength(1);
      expect(
        broadcasts[0].some(
          (op) => op.op === "content_edit" && op.edit.kind === "document_init",
        ),
      ).toBe(true);
      editor.destroy();
    }
  });

  it("keeps explicit ChangeApi ranges flat in legacy math mode", () => {
    const { editor, blockId } = createMathEditor("legacy");
    const broadcasts: Operation[][] = [];
    editor.setBroadcast((ops) => broadcasts.push(ops));

    expect(
      editor.change((change) =>
        change.insertText("X", {
          from: { block: blockId, offset: 1 },
          to: { block: blockId, offset: 3 },
        }),
      ),
    ).toBe(true);
    expect(editor.getMarkdown()).toBe("$$\naXd\n$$");
    expect(broadcasts[0].some((op) => op.op === "content_edit")).toBe(false);
    editor.destroy();
  });

  it("treats peer-attached inline marks as atomic public-range and cut units", async () => {
    const deleted = createAttachedInlineMathEditor();
    expect(
      deleted.editor.change((change) =>
        change.deleteRange({
          from: { block: deleted.blockId, offset: 2 },
          to: { block: deleted.blockId, offset: 4 },
        }),
      ),
    ).toBe(true);
    expect(deleted.editor.query.block({ block: deleted.blockId })?.text).toBe(
      "a",
    );
    expect(deleted.editor.getMarkdown()).toBe("a");
    deleted.editor.destroy();

    const replaced = createAttachedInlineMathEditor();
    expect(
      replaced.editor.change((change) =>
        change.insertText("Q", {
          from: { block: replaced.blockId, offset: 0 },
          to: { block: replaced.blockId, offset: 2 },
        }),
      ),
    ).toBe(true);
    expect(replaced.editor.query.block({ block: replaced.blockId })?.text).toBe(
      "Qb",
    );
    expect(replaced.editor.getMarkdown()).toBe("Qb");
    replaced.editor.destroy();

    const { editor, blockId } = createAttachedInlineMathEditor();
    const unchanged = () => {
      expect(editor.query.block({ block: blockId })?.text).toBe("axyb");
      expect(editor.getMarkdown()).toBe("a$xy$b");
    };

    // Removing the ownership mark or morphing its host would still strand the
    // attachment, so those operations remain protected.
    expect(
      editor.change((change) =>
        change.setMark("math", {
          active: false,
          range: {
            from: { block: blockId, offset: 1 },
            to: { block: blockId, offset: 3 },
          },
        }),
      ),
    ).toBe(false);
    expect(
      editor.change((change) =>
        change.setBlock({ type: "heading1" }, { block: blockId }),
      ),
    ).toBe(false);
    unchanged();

    const clipboard: HostClipboard = {
      write: async () => {},
      read: async () => ({}),
    };
    editor.setClipboard(clipboard);
    editor.setSelection({
      from: { block: blockId, offset: 0 },
      to: { block: blockId, offset: 3 },
    });
    expect(await editor.cut()).toBe(true);
    expect(editor.query.block({ block: blockId })?.text).toBe("b");
    expect(editor.getMarkdown()).toBe("b");
    editor.destroy();
  });

  it("clones an attached mark when async multi-block paste moves its tail", async () => {
    const { editor, blockId } = createAttachedInlineMathEditor();
    const broadcasts: Operation[][] = [];
    editor.setBroadcast((ops) => broadcasts.push(ops));
    editor.setClipboard({
      write: async () => {},
      read: async () => ({ text: "first\n\nsecond" }),
    });
    editor.setCaret({ block: blockId, offset: 1 });

    await editor.paste();
    expect(editor.query.block({ block: blockId })?.text).toBe("afirst");
    expect(editor.getMarkdown()).toBe("afirst\n\nsecond$xy$b");

    const clonedInit = broadcasts[0].find(
      (op) => op.op === "content_edit" && op.edit.kind === "document_init",
    );
    expect(clonedInit?.op).toBe("content_edit");
    if (!clonedInit || clonedInit.op !== "content_edit") {
      throw new Error("paste did not initialize the cloned attachment");
    }
    expect(editor.query.block({ block: clonedInit.blockId })?.text).toBe(
      "secondxyb",
    );

    const clonedMark = broadcasts[0].find(
      (op) =>
        op.op === "mark_set" &&
        op.blockId === clonedInit.blockId &&
        op.format.type === "math",
    );
    const clonedContentId =
      clonedMark?.op === "mark_set"
        ? clonedMark.format.attrs?.contentId
        : undefined;
    if (typeof clonedContentId !== "string") {
      throw new Error("cloned mark did not reference its attachment");
    }
    expect(clonedContentId).toBe(clonedInit.contentId);
    expect(
      editor.query.content(clonedInit.blockId, clonedContentId!),
    ).not.toBeNull();

    expect(editor.undo()).toBe(true);
    expect(editor.getMarkdown()).toBe("a$xy$b");
    expect(editor.redo()).toBe(true);
    expect(editor.getMarkdown()).toBe("afirst\n\nsecond$xy$b");
    editor.destroy();
  });

  it("routes ChangeApi deleteRange(selection) through feature ownership", () => {
    const { editor, blockId } = createMathEditor("tree");
    editor.setSelection({
      from: { block: blockId, offset: 1 },
      to: { block: blockId, offset: 3 },
    });

    expect(editor.change((change) => change.deleteRange())).toBe(true);
    expect(editor.getMarkdown()).toBe("$$\nad\n$$");
    editor.destroy();
  });

  it("deletes an authoritative endpoint atomically in a cross-block range", () => {
    const { editor, blockIds } = createMathEditor(
      "tree",
      "$$\nabc\n$$\n\noutside",
    );
    editor.setSelection({
      from: { block: blockIds[0], offset: 1 },
      to: { block: blockIds[0], offset: 2 },
    });
    expect(editor.change((change) => change.deleteRange())).toBe(true);
    expect(editor.getMarkdown()).toBe("$$\nac\n$$\n\noutside");

    editor.setSelection({
      from: { block: blockIds[0], offset: 1 },
      to: { block: blockIds[2], offset: 2 },
    });

    expect(editor.change((change) => change.deleteRange())).toBe(true);
    expect(editor.getMarkdown()).toBe("tside");
    expect(editor.undo()).toBe(true);
    expect(editor.getMarkdown()).toBe("$$\nac\n$$\n\noutside");
    editor.destroy();
  });

  it("refuses a public block morph while structured content owns the block", () => {
    const { editor, blockId } = createMathEditor("tree");
    const broadcasts: Operation[][] = [];
    editor.setBroadcast((ops) => broadcasts.push(ops));

    // The first edit lazily migrates the legacy equation and leaves a nested
    // ContentSelection, i.e. no flat caret for setBlock's generic path.
    expect(
      editor.change((change) =>
        change.select({ block: blockId, offset: 2 }).insertText("X"),
      ),
    ).toBe(true);
    expect(editor.getMarkdown()).toBe("$$\nabXcd\n$$");
    const content = editor.state.contentSelection;
    expect(content).not.toBeNull();
    const contentId = content!.focus.contentId;
    expect(editor.query.content(blockId, contentId)).not.toBeNull();

    // Core cannot flatten an authoritative attachment losslessly. Refusing the
    // morph also means it contributes neither a broadcast nor an undo entry.
    expect(
      editor.change((change) => change.setBlock({ type: "paragraph" })),
    ).toBe(false);
    expect(editor.query.block({ block: blockId })?.type).toBe("math");
    expect(editor.query.content(blockId, contentId)).not.toBeNull();
    expect(broadcasts).toHaveLength(1);

    expect(editor.undo()).toBe(true);
    expect(editor.getMarkdown()).toBe("$$\nabcd\n$$");
    expect(editor.query.content(blockId, contentId)).not.toBeNull();
    expect(editor.redo()).toBe(true);
    expect(editor.getMarkdown()).toBe("$$\nabXcd\n$$");
    expect(editor.query.content(blockId, contentId)).not.toBeNull();
    editor.destroy();
  });

  it("refuses a flat block merge that would discard authoritative content", () => {
    const page = loadPage("before\nafter");
    const contentId = `${page.blocks[1].id}/owned`;
    page.blocks[1] = {
      ...page.blocks[1],
      structuredContent: {
        [contentId]: authoritativeDocument(contentId),
      },
    };
    let state = createInitialState(page, {
      crdtBinding: createCRDTbinding(page.id, "authority-merge"),
    });
    state = moveCursorToPosition(state, 0, "before".length);

    // Delete at the first block's end used to copy only the second block's
    // charRuns, tombstone that block, and thereby discard its authoritative
    // attachment. Both blocks now remain intact until a feature owns the join.
    const result = deleteForward(state);
    expect(result.ops).toEqual([]);
    expect(
      result.state.document.page.blocks.filter((block) => !block.deleted),
    ).toHaveLength(2);
    expect(
      result.state.document.page.blocks[1].structuredContent?.[contentId],
    ).toEqual(authoritativeDocument(contentId));
  });

  it("refuses the direct caret conversion path for authoritative blocks", () => {
    const page = loadPage("shadow");
    const blockId = page.blocks[0].id;
    const contentId = `${blockId}/owned`;
    page.blocks[0] = {
      ...page.blocks[0],
      structuredContent: {
        [contentId]: authoritativeDocument(contentId),
      },
    };
    let state = createInitialState(page, {
      crdtBinding: createCRDTbinding(page.id, "authority-convert"),
    });
    state = moveCursorToPosition(state, 0, 3);

    const result = convertBlockAtCursor(state, { type: "heading1" });
    expect(result.state).toBe(state);
    expect(result.ops).toEqual([]);
    expect(result.state.document.page.blocks[0].type).toBe("paragraph");
    expect(
      result.state.document.page.blocks[0].structuredContent?.[contentId],
    ).toEqual(authoritativeDocument(contentId));
  });
});
