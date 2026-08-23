/**
 * Enter inside a list item takes the same split path as any other textual
 * block. The list family used to run a private, simplified split that moved
 * bare characters: marks were dropped, and a supplemental structured mark (an
 * inline math chip) could not be moved at all, so the split was refused
 * outright — Enter did nothing in a bulleted line containing a formula.
 *
 * The generic path carries formats, clones the chip's attachment onto the new
 * block, and the list's own properties (indent, and an unchecked todo) ride
 * along as the continuation's initialProps.
 */
import {
  type InlineMathHostBlock,
  resolveStructuredInlineMathRuns,
} from "./inline-structured";
import { mathExtension } from "./math-extension";
import { insertText, splitBlock } from "@tasfer/editor/actions/actions";
import { STRUCTURED_MARK_ANCHOR_CHAR } from "@tasfer/editor/feature-facets";
import { createMarkRegistry } from "@tasfer/editor/rendering/marks";
import { createNodeRegistry } from "@tasfer/editor/rendering/nodes";
import { baseSchema } from "@tasfer/editor/schema";
import { moveCursorToPosition } from "@tasfer/editor/selection";
import {
  type Block,
  loadPage,
  type Page,
} from "@tasfer/editor/serlization/loadPage";
import type { EditorState } from "@tasfer/editor/state-types";
import { createInitialState } from "@tasfer/editor/state-utils";
import { getVisibleTextFromRuns } from "@tasfer/editor/sync/char-runs";
import { applyOp } from "@tasfer/editor/sync/reducer";
import { createCRDTbinding } from "@tasfer/editor/sync/sync";
import { describe, expect, it } from "vitest";

const treeMathSchema = baseSchema.use(mathExtension());

const LATEX = "x^2";
/** The chip's tree prints a canonical source, not the typed characters. */
const CANONICAL = "{x}^{2}";

function stateFrom(markdown: string): EditorState {
  return createInitialState(loadPage(markdown, treeMathSchema.data), {
    schema: treeMathSchema.data,
    nodes: createNodeRegistry(treeMathSchema.nodes),
    marks: createMarkRegistry(treeMathSchema.marks),
    crdtBinding: createCRDTbinding("split-list-item", "peer-1"),
  });
}

/** Same state, but the first block is rewritten with the given fields. */
function withBlockFields(
  state: EditorState,
  fields: Partial<Block>,
): EditorState {
  const blocks = [...state.document.page.blocks];
  blocks[0] = { ...blocks[0], ...fields } as Block;
  return {
    ...state,
    document: { ...state.document, page: { ...state.document.page, blocks } },
  };
}

function textOf(block: Block): string {
  return getVisibleTextFromRuns(
    (block as never as { charRuns: [] }).charRuns ?? [],
  );
}

function chipLatexOf(block: Block): string | undefined {
  return resolveStructuredInlineMathRuns(
    block as never as InlineMathHostBlock,
  )[0]?.latex;
}

function markTypesOf(block: Block): string[] {
  return (
    block as never as { formats: { format: { type: string } }[] }
  ).formats.map((span) => span.format.type);
}

/** Deep-clone a page snapshot so remote replay cannot alias local state. */
function snapshotPage(page: Page): Page {
  return JSON.parse(JSON.stringify(page)) as Page;
}

function replay(page: Page, ops: readonly unknown[]): Page {
  let next = page;
  for (const op of ops) next = applyOp(next, op as never, treeMathSchema.data);
  return next;
}

function visible(state: EditorState): Block[] {
  return state.document.page.blocks.filter((block) => !block.deleted);
}

describe("splitting a list item that carries an inline math chip", () => {
  it("splits before the chip, moving the formula to the new item", () => {
    // `alpha ￼ beta` — the caret sits after "alpha ", so the whole chip and
    // the text after it belong to the second item.
    const state = moveCursorToPosition(
      stateFrom(`- alpha $${LATEX}$ beta`),
      0,
      6,
    );
    const remoteStart = snapshotPage(state.document.page);

    const { state: next, ops } = splitBlock(state);
    const blocks = visible(next);

    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe("bullet_list");
    expect(blocks[1].type).toBe("bullet_list");
    expect(textOf(blocks[0])).toBe("alpha ");
    expect(chipLatexOf(blocks[1])).toBe(CANONICAL);
    // The chip's attachment is cloned onto the new block, not left behind as a
    // reference into the block it was split away from.
    expect(chipLatexOf(blocks[0])).toBeUndefined();
    expect(next.document.cursor?.position).toEqual({
      blockIndex: 1,
      textIndex: 0,
    });

    // A remote peer replaying the ops lands on the same two items.
    const remote = replay(remoteStart, ops).blocks.filter((b) => !b.deleted);
    expect(remote.map((b) => b.type)).toEqual(["bullet_list", "bullet_list"]);
    expect(remote.map(textOf)).toEqual(blocks.map(textOf));
    expect(remote[1].structuredContent).toEqual(blocks[1].structuredContent);
  });

  it("splits after the chip, leaving the formula on the first item", () => {
    let state = stateFrom(`- alpha $${LATEX}$ beta`);
    const length = textOf(state.document.page.blocks[0]).length;
    state = moveCursorToPosition(state, 0, length);

    const blocks = visible(splitBlock(state).state);
    expect(blocks).toHaveLength(2);
    expect(chipLatexOf(blocks[0])).toBe(CANONICAL);
    expect(textOf(blocks[1])).toBe("");
  });

  it("splits at either chip edge without losing the formula", () => {
    // The flat caret snaps to a chip's boundaries; both edges are legal split
    // points, and the chip must survive on exactly one side.
    const state = stateFrom(`- alpha $${LATEX}$ beta`);
    const chipStart = textOf(state.document.page.blocks[0]).indexOf(
      STRUCTURED_MARK_ANCHOR_CHAR,
    );

    for (const index of [chipStart, chipStart + 1]) {
      const blocks = visible(
        splitBlock(moveCursorToPosition(state, 0, index)).state,
      );
      expect(blocks).toHaveLength(2);
      expect(blocks.map(chipLatexOf).filter(Boolean)).toEqual([CANONICAL]);
    }
  });
});

describe("splitting a list item preserves its marks and list properties", () => {
  it("carries a mark spanning the trailing text onto the new item", () => {
    // Only the trailing half is bold, so the mark must ride to the new item —
    // the old list-only path moved bare characters and dropped it.
    let state = stateFrom("- alpha **bold**");
    expect(markTypesOf(state.document.page.blocks[0])).toEqual(["strong"]);
    state = moveCursorToPosition(state, 0, 6);

    const blocks = visible(splitBlock(state).state);
    expect(blocks).toHaveLength(2);
    expect(textOf(blocks[1])).toBe("bold");
    expect(markTypesOf(blocks[1])).toEqual(["strong"]);
  });

  it("continues an indented item at the same indent", () => {
    let state = stateFrom("- alpha beta");
    state = withBlockFields(state, { indent: 2 } as Partial<Block>);
    state = moveCursorToPosition(state, 0, 6);

    const blocks = visible(splitBlock(state).state);
    expect(blocks).toHaveLength(2);
    expect((blocks[1] as never as { indent: number }).indent).toBe(2);
  });

  it("starts a todo item's continuation unchecked", () => {
    let state = stateFrom("- [x] alpha beta");
    expect(state.document.page.blocks[0].type).toBe("todo_list");
    state = moveCursorToPosition(state, 0, 6);

    const blocks = visible(splitBlock(state).state);
    expect(blocks).toHaveLength(2);
    expect((blocks[1] as never as { checked: boolean }).checked).toBe(false);
  });

  it("leaves the list on Enter in an empty item", () => {
    // Unchanged behavior: an empty item outdents, or drops to a paragraph at
    // base indent, rather than minting another empty item.
    const nested = withBlockFields(stateFrom("- "), {
      indent: 1,
    } as Partial<Block>);
    const outdented = splitBlock(moveCursorToPosition(nested, 0, 0)).state;
    expect(visible(outdented)).toHaveLength(1);
    expect((visible(outdented)[0] as never as { indent: number }).indent).toBe(
      0,
    );

    const base = splitBlock(moveCursorToPosition(stateFrom("- "), 0, 0)).state;
    expect(visible(base)).toHaveLength(1);
    expect(visible(base)[0].type).toBe("paragraph");
  });

  it("keeps typing into the continuation as a list item", () => {
    let state = moveCursorToPosition(stateFrom("- alpha"), 0, 7);
    state = splitBlock(state).state;
    state = insertText(state, "b").state;

    const blocks = visible(state);
    expect(blocks[1].type).toBe("bullet_list");
    expect(textOf(blocks[1])).toBe("b");
  });
});
