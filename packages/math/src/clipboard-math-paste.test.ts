/**
 * Pasting LaTeX (`$…$`, `$$…$$`) must land as real equations, not as an
 * orphaned anchor character.
 *
 * The parse mints each equation's tree as a block-scoped attachment in the
 * parser's own namespace. Paste therefore has to re-address those attachments
 * onto whichever block ends up hosting them and rewrite the covering marks —
 * and emit the `content_edit` ops that carry them, the way it already emits
 * text and mark ops. Every case below asserts both halves: the local page shows
 * the equation, and replaying the emitted ops (a remote peer, or a rebuild from
 * the log) reconstructs the same document.
 */

import {
  createMathTestState,
  loadMathPage,
  mathTestSchema,
} from "./__testutils__/math";
import { pasteFromClipboardEvent } from "@tasfer/editor/actions/clipboard";
import { STRUCTURED_MARK_ANCHOR_CHAR } from "@tasfer/editor/feature-facets";
import { moveCursorToPosition } from "@tasfer/editor/selection";
import type { Block, Page } from "@tasfer/editor/serlization/loadPage";
import { serializeToMarkdown } from "@tasfer/editor/serlization/serializer";
import type { Operation } from "@tasfer/editor/state-types";
import { extractCounter } from "@tasfer/editor/sync/id";
import { invertOperations } from "@tasfer/editor/sync/inverse";
import { appendLocalOps, createOpLog } from "@tasfer/editor/sync/oplog";
import {
  applyOp,
  applyOps,
  getVisibleBlocks,
  rebuildState,
} from "@tasfer/editor/sync/reducer";
import { createCRDTbinding } from "@tasfer/editor/sync/sync";
import { describe, expect, it } from "vitest";

/** Paste `text` as plain text at `textIndex` of a one-paragraph document. */
function paste(host: string, textIndex: number, text: string) {
  const state = moveCursorToPosition(
    createMathTestState(loadMathPage(host)),
    0,
    textIndex,
  );
  const before = state.document.page;
  const result = pasteFromClipboardEvent(state, {} as ClipboardEvent, {
    html: "",
    text,
    imageFile: null,
  });
  if (!result) throw new Error("paste was not handled");
  const undone = applyOps(
    applyOps(before, result.ops, mathTestSchema.data),
    invertOperations(
      result.ops,
      before,
      (page, op) => applyOp(page, op, mathTestSchema.data),
      createCRDTbinding("page-1", "undo"),
      mathTestSchema.data,
    ),
    mathTestSchema.data,
  );
  return {
    ops: result.ops,
    local: result.state.document.page,
    replayed: applyOps(before, result.ops, mathTestSchema.data),
    before,
    undone,
  };
}

function markdown(page: Page): string {
  return serializeToMarkdown(getVisibleBlocks(page) as Block[], undefined, {
    schema: mathTestSchema.data,
  });
}

/**
 * The page a live `Doc` holds after ingesting a local batch. Unlike `applyOps`,
 * `appendLocalOps` skips any op the version vector already covers.
 */
function liveDocPage(before: Page, ops: readonly Operation[]): Page {
  return appendLocalOps(
    { ...createOpLog("page-1"), state: before },
    [...ops],
    mathTestSchema.data,
  ).state;
}

/** Every math mark on the page resolves to an attachment its block owns. */
function expectEveryEquationResolves(page: Page): void {
  for (const block of getVisibleBlocks(page)) {
    for (const span of "formats" in block ? block.formats : []) {
      if (span.format.type !== "math") continue;
      const contentId = span.format.attrs?.contentId as string;
      expect(block.structuredContent?.[contentId]).toBeDefined();
    }
  }
}

describe("pasting LaTeX with dollar signs", () => {
  it("keeps an inline equation pasted on its own", () => {
    const { local, replayed } = paste("Hello ", 6, "$x^2$");

    expect(markdown(local)).toBe("Hello ${x}^{2}$");
    expect(markdown(replayed)).toBe(markdown(local));
  });

  it("keeps an inline equation in the first line of a multi-line paste", () => {
    const { local, replayed } = paste("Hello ", 6, "$x^2$ tail\nsecond");

    expect(markdown(local)).toBe("Hello ${x}^{2}$ tail\nsecond");
    expect(markdown(replayed)).toBe(markdown(local));
  });

  it("keeps an inline equation in a following line of a multi-line paste", () => {
    const { local, replayed } = paste("Hello ", 6, "plain\ntail $x^2$ end");

    expect(markdown(local)).toBe("Hello plain\ntail ${x}^{2}$ end");
    expect(markdown(replayed)).toBe(markdown(local));
  });

  it("keeps two inline equations that share one pasted block", () => {
    const { local, replayed } = paste("", 0, "$a+b$ and $c+d$");

    expect(markdown(local)).toBe("$a+b$ and $c+d$");
    expect(markdown(replayed)).toBe(markdown(local));
  });

  it("merges inline equations pasted directly beside each other", () => {
    const { local, replayed } = paste(
      "",
      0,
      "${h}_{l}$$=f\\frac{l}{\\oslash}\\frac{{V}^{2}}{2g}$",
    );

    expect(markdown(local)).toBe(
      "${h}_{l}=f\\frac{l}{\\oslash}\\frac{{V}^{2}}{2g}$",
    );
    expect(markdown(replayed)).toBe(markdown(local));
  });

  it("inserts a display equation pasted on its own as a math block", () => {
    const { local, replayed } = paste("Hello ", 6, "$$\n\\frac{1}{2}\n$$");

    expect(getVisibleBlocks(local).map((b) => b.type)).toEqual([
      "paragraph",
      "math",
    ]);
    expect(markdown(local)).toBe("Hello \n$$\n\\frac{1}{2}\n$$\n");
    expect(markdown(replayed)).toBe(markdown(local));
  });

  it("keeps a display equation surrounded by pasted text", () => {
    const { local, replayed } = paste(
      "Hello ",
      6,
      "before\n$$\n\\frac{1}{2}\n$$\nafter",
    );

    expect(markdown(local)).toBe("Hello before\n$$\n\\frac{1}{2}\n$$\nafter");
    expect(markdown(replayed)).toBe(markdown(local));
  });

  // A display equation owns its content at block level, so it can never merge
  // into the host block's characters — at either end of the pasted range it
  // becomes a block of its own, and the host's tail spills after it.
  it("keeps a display equation that opens the pasted range", () => {
    const { local, replayed } = paste(
      "Hello ",
      6,
      "$$\n\\frac{1}{2}\n$$\nafter",
    );

    expect(getVisibleBlocks(local).map((b) => b.type)).toEqual([
      "paragraph",
      "math",
      "paragraph",
    ]);
    expect(markdown(local)).toBe("Hello \n$$\n\\frac{1}{2}\n$$\nafter");
    expect(markdown(replayed)).toBe(markdown(local));
  });

  it("keeps the host's tail when a display equation closes the paste", () => {
    const { local, replayed } = paste(
      "Hello tail",
      6,
      "before\n$$\n\\frac{1}{2}\n$$",
    );

    expect(markdown(local)).toBe("Hello before\n$$\n\\frac{1}{2}\n$$\ntail");
    expect(markdown(replayed)).toBe(markdown(local));
  });

  it("keeps the host's own equation when pasting into its tail", () => {
    // The caret sits between the host's equation and its trailing text, so the
    // tail (and the equation covering it) moves to a new block while the paste
    // brings an equation of its own — both attachments must survive.
    const { local, replayed } = paste("$a+b$ tail", 1, "one\ntwo $c+d$");

    expect(markdown(local)).toBe("$a+b$one\ntwo $c+d$ tail");
    expect(markdown(replayed)).toBe(markdown(local));
  });

  // Reload replays the whole op log HLC-sorted (`rebuildState`), not in
  // emission order — the case that turned pasted equations into bare `$￼$`
  // anchors after a refresh.
  it.each([
    ["an inline equation", "one $x^2$\ntwo $y^2$"],
    ["a display equation", "before\n$$\n\\frac{1}{2}\n$$\nafter"],
    ["an equation beside the host's tail", "one\ntwo $c+d$"],
  ])("survives a reload after pasting %s", (_label, pasted) => {
    const { ops } = paste("Hello tail", 6, pasted);
    const reloaded = rebuildState("page-1", [...ops], mathTestSchema.data);
    const text = markdown(reloaded);

    expect(text).not.toContain(STRUCTURED_MARK_ANCHOR_CHAR);
    expectEveryEquationResolves(reloaded);
  });

  // The live doc skips an op whose id is at or below the highest id it has seen
  // from that peer. A paste that emitted an attachment after the text minted
  // later than it lost that attachment from the live doc only — and from every
  // snapshot saved from it — while the log kept it. Each branch of the paste
  // below emits attachments in a different place.
  it.each([
    ["an inline equation into text", "Hello ", 6, "$x^2$"],
    [
      "an equation in a multi-line paste's first line",
      "Hello ",
      6,
      "$x^2$ a\nb",
    ],
    ["a display equation on its own", "Hello ", 6, "$$\n\\frac{1}{2}\n$$"],
    ["an equation beside the host's own", "$a+b$ tail", 1, "one\ntwo $c+d$"],
  ])("keeps %s in the live doc", (_label, host, index, pasted) => {
    const { ops, local, before } = paste(host, index, pasted);
    const live = liveDocPage(before, ops);

    const counters = ops.map((op) => extractCounter(op.id));
    expect(counters).toEqual([...counters].sort((a, b) => a - b));
    expect(markdown(live)).toBe(markdown(local));
    expectEveryEquationResolves(live);
  });

  // The attachments now travel as `content_edit` ops, so undo has to take them
  // back out with the rest of the paste rather than leave stray documents.
  it.each([
    ["an inline equation", "$x^2$"],
    ["a display equation", "$$\n\\frac{1}{2}\n$$"],
    ["mixed content", "before $x^2$\n$$\n\\frac{1}{2}\n$$\nafter"],
  ])("undoes a paste of %s", (_label, pasted) => {
    const { before, undone } = paste("Hello ", 6, pasted);

    expect(markdown(undone)).toBe(markdown(before));
    for (const block of getVisibleBlocks(undone)) {
      expect(block.structuredContent ?? {}).toEqual({});
    }
  });
});
