/**
 * Generic block morphs of a paragraph that carries an inline math chip.
 *
 * The chip's formula lives in a supplemental attachment addressed by the host
 * block's id, reached through the mark over its anchor char. A morph between
 * textual types keeps both — same block id, same text, same marks — so "turn
 * into a bullet list" (slash menu, toolbar, or a typed `- ` prefix) works on a
 * line containing a formula, and outdenting back to a paragraph returns it
 * intact. Only a target that clears the text or drops marks is refused; that
 * case lives in `inline-chip-promote.test.ts`.
 */
import {
  type InlineMathHostBlock,
  resolveStructuredInlineMathRuns,
} from "./inline-structured";
import { mathExtension } from "./math-extension";
import {
  convertBlockAtCursor,
  insertText,
  outdentListItem,
} from "@tasfer/editor/actions/actions";
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
import { hasStructuredContent } from "@tasfer/editor/sync/structured-content";
import { createCRDTbinding } from "@tasfer/editor/sync/sync";
import { describe, expect, it } from "vitest";

const treeMathSchema = baseSchema.use(mathExtension());

const LATEX = "x^2 + y";
// The chip's tree prints a canonical source, not the typed characters.
const CANONICAL = "{x}^{2}+y";
// The base Block union doesn't know extension types; widen at the seam.
const BULLET = "bullet_list" as Block["type"];

function emptyState(): EditorState {
  const binding = createCRDTbinding("default-page", "chip-list-test");
  return createInitialState(loadPage("", treeMathSchema.data), {
    schema: treeMathSchema.data,
    nodes: createNodeRegistry(treeMathSchema.nodes),
    marks: createMarkRegistry(treeMathSchema.marks),
    crdtBinding: binding,
  });
}

function typeString(state: EditorState, text: string): EditorState {
  for (const ch of text) state = insertText(state, ch).state;
  return state;
}

function visibleTextOf(block: Block): string {
  return getVisibleTextFromRuns(
    (block as never as { charRuns: [] }).charRuns ?? [],
  );
}

function chipLatexOf(block: Block): string | undefined {
  return resolveStructuredInlineMathRuns(
    block as never as InlineMathHostBlock,
  )[0]?.latex;
}

/** A paragraph reading `before ￼ after`, the chip embedded in prose. */
function proseWithChipState(): EditorState {
  let state = moveCursorToPosition(emptyState(), 0, 0);
  state = typeString(state, `before $${LATEX}$ after`);
  if (!hasStructuredContent(state.document.page.blocks[0])) {
    throw new Error("expected the chip to own a structured attachment");
  }
  return state;
}

/** Deep-clone a page snapshot so remote replay cannot alias local state. */
function snapshotPage(page: Page): Page {
  return JSON.parse(JSON.stringify(page)) as Page;
}

function replay(page: Page, ops: readonly unknown[]): Page {
  let next = page;
  for (const op of ops) {
    next = applyOp(next, op as never, treeMathSchema.data);
  }
  return next;
}

describe("inline chip host → list", () => {
  it("converts to a bullet list, keeping the formula", () => {
    const state = proseWithChipState();
    const before = state.document.page.blocks[0];
    const remoteStart = snapshotPage(state.document.page);

    const { state: converted, ops } = convertBlockAtCursor(state, {
      type: BULLET,
    });
    const block = converted.document.page.blocks[0];
    expect(block.type).toBe(BULLET);
    expect(visibleTextOf(block)).toBe(visibleTextOf(before));
    expect(chipLatexOf(block)).toBe(CANONICAL);
    expect(block.structuredContent).toEqual(before.structuredContent);

    const remoteBlock = replay(remoteStart, ops).blocks[0];
    expect(remoteBlock.type).toBe(BULLET);
    expect(remoteBlock.structuredContent).toEqual(block.structuredContent);
  });

  it("converts from a typed `- ` markdown prefix", () => {
    let state = proseWithChipState();
    const chipText = visibleTextOf(state.document.page.blocks[0]);
    state = moveCursorToPosition(state, 0, 0);
    state = typeString(state, "- ");

    const block = state.document.page.blocks[0];
    expect(block.type).toBe(BULLET);
    // The prefix is consumed, not left literal, and the chip survives it.
    expect(visibleTextOf(block)).toBe(chipText);
    expect(chipLatexOf(block)).toBe(CANONICAL);
  });

  it("returns the formula to a paragraph on outdent", () => {
    let state = proseWithChipState();
    const before = state.document.page.blocks[0];
    state = convertBlockAtCursor(state, { type: BULLET }).state;
    state = outdentListItem(state).state;

    const block = state.document.page.blocks[0];
    expect(block.type).toBe("paragraph");
    expect(visibleTextOf(block)).toBe(visibleTextOf(before));
    expect(chipLatexOf(block)).toBe(CANONICAL);
  });
});
