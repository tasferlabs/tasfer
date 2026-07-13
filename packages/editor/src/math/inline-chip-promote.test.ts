/**
 * Inline chip → display equation promote (CONVERT_STRUCTURED_BLOCK).
 *
 * A "turn into math" conversion (slash menu, context menu, public
 * `setBlock({ type: "math" })`) of a paragraph whose only content is one
 * inline math chip must survive the chip owning a structured attachment.
 * Core's generic conversion refuses blocks with structured content — a flat
 * morph would orphan the persisted document, and an attached chip's flat
 * characters are only a (possibly stale) compatibility projection — so it
 * offers the conversion through CONVERT_STRUCTURED_BLOCK, and MathNode claims
 * it: the supplemental tree becomes the block's display authority, losslessly.
 *
 * Regression: before this seam the conversion silently no-opped the moment the
 * chip had been structurally edited (its structured attachment persisted),
 * while an untouched `$…$` chip still converted through the textual path.
 */
import { convertBlockAtCursor, insertText } from "../actions/actions";
import { mathExtension } from "../math-extension";
import { createMarkRegistry } from "../rendering/marks";
import { createNodeRegistry } from "../rendering/nodes";
import { baseSchema } from "../schema";
import { moveCursorToPosition } from "../selection";
import { type Block, loadPage, type Page } from "../serlization/loadPage";
import type { EditorState } from "../state-types";
import { createInitialState } from "../state-utils";
import { getVisibleTextFromRuns } from "../sync/char-runs";
import { applyOp } from "../sync/reducer";
import { hasStructuredContent } from "../sync/structured-content";
import { createCRDTbinding } from "../sync/sync";
import {
  type InlineMathHostBlock,
  resolveStructuredInlineMathRuns,
} from "./inline-structured";
import { enterInlineMathTreeAtPosition } from "./inline-tree-state";
import { getStructuredMathSource, mathContentIdForBlock } from "./structured";
import { describe, expect, it } from "vitest";

const treeMathSchema = baseSchema.use(mathExtension());

function emptyState(): EditorState {
  const binding = createCRDTbinding("default-page", "promote-test");
  return createInitialState(loadPage("", treeMathSchema.data), {
    schema: treeMathSchema.data,
    nodes: createNodeRegistry(treeMathSchema.nodes),
    marks: createMarkRegistry(treeMathSchema.marks),
    crdtBinding: binding,
  });
}

function typeString(state: EditorState, text: string): EditorState {
  for (const ch of text) {
    state = insertText(state, ch).state;
  }
  return state;
}

/**
 * A paragraph whose only content is one inline chip that owns a persisted
 * structured attachment: type the `$…$` source, enter the chip (a click),
 * and make one tree edit so the attachment materializes and the flat chars
 * become a stale projection. Returns the state with a flat caret parked at
 * the block start (chip boundary), like a caret returning from prose.
 */
function attachedChipState(latex: string): EditorState {
  let state = emptyState();
  state = moveCursorToPosition(state, 0, 0);
  state = typeString(state, `$${latex}$`);
  const entered = enterInlineMathTreeAtPosition(state, 0, 5, {
    allowBoundary: true,
  });
  if (!entered) throw new Error("expected to enter the inline chip");
  state = insertText(entered.state, "b").state;
  const block = state.document.page.blocks[0];
  if (!hasStructuredContent(block)) {
    throw new Error("expected the chip edit to persist an attachment");
  }
  return moveCursorToPosition(state, 0, 0);
}

/** Deep-clone a page snapshot so remote replay cannot alias local state. */
function snapshotPage(page: Page): Page {
  return JSON.parse(JSON.stringify(page)) as Page;
}

const LATEX = "\\frac{\\sqrt{2}}{}{\\pm}^{}aa";

// The base Block union doesn't know extension types/fields; these tests read
// a math-schema page, so widen at the seams the way sibling suites do.
const MATH = "math" as Block["type"];

function visibleTextOf(block: Block): string {
  return getVisibleTextFromRuns(
    (block as never as { charRuns: [] }).charRuns ?? [],
  );
}

describe("inline chip → display equation promote", () => {
  it("promotes an attached chip to a tree-backed math block, losslessly", () => {
    const state = attachedChipState(LATEX);
    const before = state.document.page.blocks[0];
    const run = resolveStructuredInlineMathRuns(
      before as never as InlineMathHostBlock,
    )[0];
    // Canonical tree source (with the "b" edit) vs the stale projection.
    expect(run.latex).not.toBe(run.compatibilityLatex);

    const { state: converted, ops } = convertBlockAtCursor(state, {
      type: MATH,
    });
    const block = converted.document.page.blocks[0];
    expect(block.type).toBe(MATH);
    // The display tree carries the canonical source, not the stale chars.
    expect(getStructuredMathSource(block)).toBe(run.latex);
    // Flat text stays empty — a tree-backed equation has no legacy source.
    expect(visibleTextOf(block)).toBe("");
    // The chip's supplemental attachment is gone; only the display root remains.
    expect(Object.keys(block.structuredContent ?? {})).toEqual([
      mathContentIdForBlock(block.id),
    ]);
    // The caret continues inside the equation, at its end.
    expect(converted.document.contentSelection?.focus.contentId).toBe(
      mathContentIdForBlock(block.id),
    );
    expect(ops.length).toBeGreaterThan(0);
  });

  it("replays convergently on a remote peer from the emitted ops alone", () => {
    const state = attachedChipState(LATEX);
    const remoteStart = snapshotPage(state.document.page);

    const { state: converted, ops } = convertBlockAtCursor(state, {
      type: MATH,
    });

    let remote = remoteStart;
    for (const op of ops) {
      remote = applyOp(remote, op, treeMathSchema.data);
    }
    const localBlock = converted.document.page.blocks[0];
    const remoteBlock = remote.blocks[0];
    expect(remoteBlock.type).toBe(MATH);
    expect(getStructuredMathSource(remoteBlock)).toBe(
      getStructuredMathSource(localBlock),
    );
    expect(Object.keys(remoteBlock.structuredContent ?? {})).toEqual(
      Object.keys(localBlock.structuredContent ?? {}),
    );
    expect(visibleTextOf(remoteBlock)).toBe("");
  });

  it("tolerates whitespace around the chip (a slash command's separator)", () => {
    let state = attachedChipState(LATEX);
    // A trailing space outside the chip — what "` /math`" leaves after strip.
    state = moveCursorToPosition(
      state,
      0,
      visibleTextOf(state.document.page.blocks[0]).length,
    );
    state = insertText(state, " ").state;
    const { state: converted } = convertBlockAtCursor(state, { type: MATH });
    expect(converted.document.page.blocks[0].type).toBe(MATH);
  });

  it("refuses when prose surrounds the chip", () => {
    let state = attachedChipState(LATEX);
    state = moveCursorToPosition(
      state,
      0,
      visibleTextOf(state.document.page.blocks[0]).length,
    );
    state = insertText(state, " and more prose").state;
    const result = convertBlockAtCursor(state, { type: MATH });
    expect(result.ops).toEqual([]);
    expect(result.state.document.page.blocks[0].type).toBe("paragraph");
  });

  it("refuses a non-math target on a structured-content block", () => {
    const state = attachedChipState(LATEX);
    const result = convertBlockAtCursor(state, { type: "quote" });
    expect(result.ops).toEqual([]);
    expect(result.state.document.page.blocks[0].type).toBe("paragraph");
  });
});
