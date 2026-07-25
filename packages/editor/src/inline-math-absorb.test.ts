/**
 * Marking a selection as math when part of it ALREADY is.
 *
 * An inline chip projects into flat text as one content-free anchor char, so
 * "wrap this range in math" over a range containing a chip used to be refused
 * outright — the guard that protects a chip's attachment attrs from being
 * re-wrapped could not tell "re-wrap this formula" from "make this formula and
 * the text after it one bigger formula". The second is a real request, and the
 * covered chips are now absorbed into the new formula's source (their
 * attachments dying in the same transaction) rather than ignored.
 */
import { toggleFormat } from "./actions/actions";
import { wrapSelectionOnInput } from "./actions/wrap-selection";
import { resolveMarkRuns } from "./inline-math-spans";
import { mathExtension } from "./math-extension";
import { createMarkRegistry } from "./rendering/marks";
import { createNodeRegistry } from "./rendering/nodes";
import { baseSchema } from "./schema";
import { startSelection, updateSelectionFocus } from "./selection";
import { loadPage } from "./serlization/loadPage";
import { serializeToMarkdown } from "./serlization/serializer";
import type { EditorState } from "./state-types";
import { createInitialState } from "./state-utils";
import { isTextualBlock } from "./sync/block-registry";
import { getVisibleTextFromRuns } from "./sync/char-runs";
import { describe, expect, it } from "vitest";

const schema = baseSchema.use(mathExtension());

function pageState(markdown: string): EditorState {
  return createInitialState(loadPage(markdown, schema.data), {
    schema: schema.data,
    nodes: createNodeRegistry(schema.nodes),
    marks: createMarkRegistry(schema.marks),
  });
}

/** Select `[from, to)` of the first block; `to` defaults to its whole text. */
function select(state: EditorState, from: number, to?: number): EditorState {
  const block = state.document.page.blocks[0];
  if (!isTextualBlock(block)) throw new Error("expected a textual block");
  const end = to ?? getVisibleTextFromRuns(block.charRuns).length;
  return updateSelectionFocus(
    startSelection(state, { blockIndex: 0, textIndex: from }),
    { blockIndex: 0, textIndex: end },
  );
}

function markdownOf(state: EditorState): string {
  return serializeToMarkdown(state.document.page.blocks, undefined, {
    schema: state.schema,
  });
}

/** Attachments still reachable on the first block. */
function attachmentCount(state: EditorState): number {
  return Object.keys(state.document.page.blocks[0].structuredContent ?? {})
    .length;
}

describe("marking math over an existing chip", () => {
  it("absorbs a chip and the text after it into one formula", () => {
    const selected = select(pageState("$A = \\frac{x}{4}$ =2.83m^2"), 0);

    const result = toggleFormat(selected, "math");

    expect(markdownOf(result.state)).toBe("$A=\\frac{x}{4}=2.83{m}^{2}$");
    // One chip, one attachment — the absorbed one is not left unreachable.
    expect(resolveMarkRuns(result.state.document.page.blocks[0])).toHaveLength(
      1,
    );
    expect(attachmentCount(result.state)).toBe(1);
  });

  it("joins two chips and what sits between them", () => {
    const selected = select(pageState("$a$ plus $b$"), 0);

    const result = toggleFormat(selected, "math");

    expect(markdownOf(result.state)).toBe("$aplusb$");
    expect(attachmentCount(result.state)).toBe(1);
  });

  it("does the same for the typed `$` gesture", () => {
    const selected = select(pageState("$a$ tail"), 0);

    const result = wrapSelectionOnInput(selected, "$");

    expect(result && markdownOf(result.state)).toBe("$atail$");
  });

  it("still refuses to re-wrap a chip that is the whole selection", () => {
    const selected = select(pageState("$a$ tail"), 0, 1);

    const result = toggleFormat(selected, "math");

    expect(result.ops).toHaveLength(0);
    expect(result.state).toBe(selected);
  });

  it("leaves a composable mark over the same selection alone", () => {
    const selected = select(pageState("$a$ tail"), 0);

    const result = toggleFormat(selected, "strong");

    // Bold was never blocked by a chip and still marks the range's chars.
    expect(result.ops.length).toBeGreaterThan(0);
    expect(
      resolveMarkRuns(result.state.document.page.blocks[0]).map(
        (run) => run.name,
      ),
    ).toContain("math");
  });
});
