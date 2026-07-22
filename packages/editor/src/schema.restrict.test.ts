/**
 * The ProseMirror-style authoring allow-list (`Schema.restrict`).
 *
 * Three layers are pinned here:
 *  1. Core — restrict() narrows what is CREATABLE while keeping the full
 *     registry (rendering) intact, always keeps the paragraph fallback, and is
 *     immutable.
 *  2. Normalization — `normalizeBlocks` coerces/drops/strips paste & import
 *     content to the allow-list, and is a strict no-op when unrestricted.
 *  3. Authoring enforcement — actions (convert/split/list/toggle/markdown-prefix)
 *     refuse to MINT a disallowed type/mark, while the reducer stays agnostic so
 *     a restricted peer still MATERIALIZES a disallowed-but-registered type that
 *     arrives via sync (convergence).
 */

import {
  convertBlockAtCursor,
  convertToList,
  insertText,
  splitBlock,
  toggleFormat,
} from "./actions/actions";
import { createDoc } from "./doc";
import { mathExtension } from "./math-extension";
import { baseSchema } from "./schema";
import type { Block, MarkSpan, Page } from "./serlization/loadPage";
import { normalizeBlocks } from "./serlization/normalize";
import type { BlockInsert, CursorState, EditorState } from "./state-types";
import { createInitialState } from "./state-utils";
import { getVisibleTextFromRuns } from "./sync/char-runs";
import { describe, expect, it } from "vitest";

// ── fixtures ──────────────────────────────────────────────────────────────

/** A title-like schema: only heading1 is creatable, no marks. */
const fullSchema = baseSchema.use(mathExtension());
const titleSchema = fullSchema.restrict({ blocks: ["heading1"], marks: [] });
/** A plain-text field: only the paragraph fallback, no marks. */
const plainSchema = fullSchema.restrict({ blocks: [], marks: [] });

function textual(
  type: Block["type"],
  id: string,
  orderKey: string,
  text: string,
  extra: Record<string, unknown> = {},
): Block {
  return {
    id,
    orderKey,
    deleted: false,
    type,
    charRuns: text ? [{ peerId: "peer", startCounter: 0, text }] : [],
    formats: [],
    ...extra,
  } as unknown as Block;
}

function pageWith(...blocks: Block[]): Page {
  return { id: "page-1", title: "t", blocks };
}

function cursorAt(blockIndex: number, textIndex: number): CursorState {
  return { position: { blockIndex, textIndex }, lastUpdate: 0 };
}

function stateWith(
  schema: { data: EditorState["schema"] },
  page: Page,
  cursor: CursorState,
): EditorState {
  const base = createInitialState(page, { schema: schema.data });
  return { ...base, document: { ...base.document, cursor } };
}

function text(block: Block): string {
  return getVisibleTextFromRuns((block as { charRuns?: [] }).charRuns);
}

// ── 1. Core restrict() ──────────────────────────────────────────────────────

describe("Schema.restrict — core", () => {
  it("narrows the creatable block set but keeps the fallback", () => {
    const d = titleSchema.data;
    expect(d.isBlockAllowed("heading1")).toBe(true);
    expect(d.isBlockAllowed("paragraph")).toBe(true); // fallback, auto-kept
    expect(d.isBlockAllowed("image")).toBe(false);
    expect(d.isBlockAllowed("bullet_list")).toBe(false);
  });

  it("never lets the paragraph fallback be excluded", () => {
    const d = baseSchema.restrict({ blocks: ["image"] }).data;
    expect(d.isBlockAllowed("paragraph")).toBe(true);
    expect(d.isBlockAllowed("image")).toBe(true);
    expect(d.isBlockAllowed("heading1")).toBe(false);
  });

  it("marks: [] forbids every mark; a named list allows only those", () => {
    expect(titleSchema.data.isMarkAllowed("strong")).toBe(false);
    const oneMark = baseSchema.restrict({ marks: ["strong"] }).data;
    expect(oneMark.isMarkAllowed("strong")).toBe(true);
    expect(oneMark.isMarkAllowed("emphasis")).toBe(false);
  });

  it("keeps the FULL registry (rendering) after restrict", () => {
    // A disallowed type is still registered — it renders and materializes.
    expect(titleSchema.data.hasBlock("image")).toBe(true);
    expect(titleSchema.data.hasBlock("bullet_list")).toBe(true);
    expect(titleSchema.data.getDescriptor("image")).toBeDefined();
  });

  it("is immutable — the base schema is unaffected", () => {
    expect(baseSchema.data.isBlockAllowed("image")).toBe(true);
    expect(baseSchema.data.allowedBlocks).toBeUndefined();
    expect(titleSchema.data.allowedBlocks).toBeDefined();
    expect(titleSchema).not.toBe(baseSchema);
  });

  it("coerceCreatable clamps a disallowed type to the fallback", () => {
    const d = titleSchema.data;
    expect(d.coerceCreatable("heading1")).toBe("heading1");
    expect(d.coerceCreatable("image")).toBe("paragraph");
    expect(d.coerceCreatable("bullet_list")).toBe("paragraph");
  });

  it("throws on an unregistered name", () => {
    expect(() =>
      baseSchema.restrict({ blocks: ["nope" as "paragraph"] }),
    ).toThrow(/not registered/);
    expect(() => baseSchema.restrict({ marks: ["nope" as "strong"] })).toThrow(
      /not registered/,
    );
  });

  it("extend() carries the allow-list through unchanged", () => {
    const extended = titleSchema.extend({ nodes: [] });
    expect(extended.data.isBlockAllowed("heading1")).toBe(true);
    expect(extended.data.isBlockAllowed("image")).toBe(false);
  });

  it("is a no-op predicate when unrestricted", () => {
    expect(baseSchema.data.isBlockAllowed("image")).toBe(true);
    expect(baseSchema.data.isMarkAllowed("strong")).toBe(true);
    expect(baseSchema.data.isBlockAllowed("nonexistent")).toBe(false);
  });
});

// ── 2. normalizeBlocks ───────────────────────────────────────────────────────

describe("normalizeBlocks", () => {
  it("coerces a disallowed heading to a paragraph, preserving text + identity", () => {
    const [out] = normalizeBlocks(
      [textual("heading1", "h-1", "a5", "Hello")],
      plainSchema.data,
    );
    expect(out.type).toBe("paragraph");
    expect(out.id).toBe("h-1");
    expect(out.orderKey).toBe("a5");
    expect(text(out)).toBe("Hello");
  });

  it("drops a disallowed void/atomic block (image, line, code)", () => {
    const out = normalizeBlocks(
      [
        textual("paragraph", "p-1", "a0", "keep"),
        {
          id: "i-1",
          orderKey: "a1",
          deleted: false,
          type: "image",
          url: "x",
        } as unknown as Block,
        textual("code", "c-1", "a2", "code"),
      ],
      plainSchema.data,
    );
    expect(out.map((b) => b.type)).toEqual(["paragraph"]);
    expect(out.map((b) => b.id)).toEqual(["p-1"]);
  });

  it("strips disallowed inline marks from a surviving block", () => {
    const withMark: Block = {
      id: "p-1",
      orderKey: "a0",
      deleted: false,
      type: "paragraph",
      charRuns: [{ peerId: "peer", startCounter: 0, text: "hi" }],
      formats: [
        {
          startCharId: "peer:0",
          endCharId: "peer:1",
          format: { type: "strong" },
          clock: { counter: 0, peerId: "peer" },
        },
      ],
    } as unknown as Block;
    const [out] = normalizeBlocks([withMark], plainSchema.data);
    expect((out as { formats: MarkSpan[] }).formats).toEqual([]);
  });

  it("coerces a disallowed math block, keeping its LaTeX as text", () => {
    const [out] = normalizeBlocks(
      [
        textual("math" as Block["type"], "m-1", "a0", "x^2", {
          displayMode: true,
        }),
      ],
      plainSchema.data,
    );
    expect(out.type).toBe("paragraph");
    expect(text(out)).toBe("x^2");
  });

  it("is a strict no-op when the schema is unrestricted", () => {
    const blocks = [
      textual("heading1", "h-1", "a0", "H"),
      {
        id: "i-1",
        orderKey: "a1",
        deleted: false,
        type: "image",
        url: "x",
      } as unknown as Block,
    ];
    const out = normalizeBlocks(blocks, baseSchema.data);
    expect(out).toEqual(blocks);
    expect(out[0]).toBe(blocks[0]); // same references
  });
});

// ── 3. Authoring enforcement ─────────────────────────────────────────────────

describe("authoring enforcement", () => {
  it("convertBlockAtCursor to a disallowed type is a no-op", () => {
    const state = stateWith(
      plainSchema,
      pageWith(textual("paragraph", "p-1", "a0", "hi")),
      cursorAt(0, 2),
    );
    const r = convertBlockAtCursor(state, { type: "heading1" });
    expect(r.ops).toEqual([]);
    expect(r.state.document.page.blocks[0].type).toBe("paragraph");
  });

  it("convertBlockAtCursor to an allowed type still works under restriction", () => {
    const state = stateWith(
      titleSchema,
      pageWith(textual("paragraph", "p-1", "a0", "hi")),
      cursorAt(0, 2),
    );
    const r = convertBlockAtCursor(state, { type: "heading1" });
    expect(r.state.document.page.blocks[0].type).toBe("heading1");
    expect(r.ops.some((o) => o.op === "block_set" && o.field === "type")).toBe(
      true,
    );
  });

  it("convertToList to a disallowed list type is a no-op", () => {
    const state = stateWith(
      plainSchema,
      pageWith(textual("paragraph", "p-1", "a0", "hi")),
      cursorAt(0, 2),
    );
    const r = convertToList(state, "bullet_list");
    expect(r.ops).toEqual([]);
    expect(r.state.document.page.blocks[0].type).toBe("paragraph");
  });

  it("toggleFormat for a disallowed mark is a no-op", () => {
    const page = pageWith(textual("paragraph", "p-1", "a0", "hello"));
    const state: EditorState = {
      ...stateWith(plainSchema, page, cursorAt(0, 5)),
    };
    // Select the whole word so the toggle has a range to act on.
    const withSel: EditorState = {
      ...state,
      document: {
        ...state.document,
        selection: {
          anchor: { blockIndex: 0, textIndex: 0 },
          focus: { blockIndex: 0, textIndex: 5 },
          isCollapsed: false,
        } as EditorState["document"]["selection"],
      },
    };
    const r = toggleFormat(withSel, "strong");
    expect(r.ops).toEqual([]);
  });

  it("markdown prefix '# ' stays literal when headings are disallowed", () => {
    const state = stateWith(
      plainSchema,
      pageWith(textual("paragraph", "p-1", "a0", "#")),
      cursorAt(0, 1),
    );
    const r = insertText(state, " ");
    const block = r.state.document.page.blocks[0];
    expect(block.type).toBe("paragraph");
    expect(text(block)).toBe("# ");
    expect(r.ops.some((o) => o.op === "block_set" && o.field === "type")).toBe(
      false,
    );
  });

  it("markdown prefix '# ' still promotes to heading1 when allowed", () => {
    const state = stateWith(
      titleSchema,
      pageWith(textual("paragraph", "p-1", "a0", "#")),
      cursorAt(0, 1),
    );
    const r = insertText(state, " ");
    expect(r.state.document.page.blocks[0].type).toBe("heading1");
  });

  it("splitting a disallowed heading coerces the EMITTED continuation to paragraph", () => {
    // A heading1 exists (e.g. arrived from a permissive peer) in a plain-text
    // field. Splitting mid-text must not MINT another heading.
    const state = stateWith(
      plainSchema,
      pageWith(textual("heading1", "h-1", "a0", "abcd")),
      cursorAt(0, 2),
    );
    const r = splitBlock(state);
    const insert = r.ops.find((o): o is BlockInsert => o.op === "block_insert");
    expect(insert).toBeDefined();
    expect(insert!.blockType).toBe("paragraph"); // emitted op, not just local state
  });
});

// ── 4. Convergence — the reducer ignores the allow-list ──────────────────────

describe("reducer stays agnostic to the allow-list", () => {
  it("a restricted schema still MATERIALIZES a disallowed-but-registered block", () => {
    // Model a remote peer's op arriving at a restricted replica.
    const doc = createDoc({ pageId: "pg", ops: [], schema: plainSchema.data });
    const insert: BlockInsert = {
      op: "block_insert",
      id: "pR:1",
      clock: { counter: 1, peerId: "pR" },
      pageId: "pg",
      orderKey: "a0",
      blockId: "blk-h",
      blockType: "heading1",
    };
    doc.applyUpdate([insert]);
    const materialized = doc
      .getRawBlocks()
      .find((b) => b.id === "blk-h" && !b.deleted);
    // Registered → rendered, even though heading1 is not authorable here.
    expect(materialized?.type).toBe("heading1");
    doc.destroy();
  });
});
