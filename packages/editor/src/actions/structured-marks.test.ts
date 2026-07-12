import { createMathTestState, loadMathPage } from "../__testutils__/math";
import { resolveMarkRuns } from "../inline-math-spans";
import { parseLegacyMathDocumentInit } from "../math/structured";
import { moveCursorToPosition, updateSelection } from "../selection";
import { serializeToHTMLFragment } from "../serlization/htmlSerializer";
import { serializeToMarkdown } from "../serlization/serializer";
import type { EditorState } from "../state-types";
import { recordUndoOps, redoState, undoState } from "../sync/crdt-undo";
import { applyOps } from "../sync/reducer";
import { mergeBlocksOps, splitBlock } from "./actions";
import {
  createFeatureMarkInRange,
  expandSelectionAroundStructuredMarks,
  selectionPartiallyIntersectsStructuredMark,
} from "./structured-marks";
import { describe, expect, it } from "vitest";

function attach(state: EditorState) {
  const block = state.document.page.blocks[0];
  const result = createFeatureMarkInRange(
    state.document.page,
    block.id,
    0,
    1,
    { type: "math" },
    state.CRDTbinding,
    state.schema,
  );
  return {
    result,
    state: {
      ...state,
      document: { ...state.document, page: result.newPage },
    } satisfies EditorState,
  };
}

function attachRange(
  state: EditorState,
  blockIndex: number,
  from: number,
  to: number,
) {
  const block = state.document.page.blocks[blockIndex];
  const result = createFeatureMarkInRange(
    state.document.page,
    block.id,
    from,
    to,
    { type: "math" },
    state.CRDTbinding,
    state.schema,
  );
  return {
    result,
    state: {
      ...state,
      document: { ...state.document, page: result.newPage },
    } satisfies EditorState,
  };
}

describe("structured mark creation seam", () => {
  it("emits one supplemental initializer and its referencing mark atomically", () => {
    const before = createMathTestState(loadMathPage("x"));
    const { result, state } = attach(before);

    expect(result.ops.map((op) => op.op)).toEqual(["content_edit", "mark_set"]);
    const run = resolveMarkRuns(state.document.page.blocks[0])[0];
    const contentId = run.attrs.contentId;
    expect(typeof contentId).toBe("string");
    if (typeof contentId !== "string") return;
    const document =
      state.document.page.blocks[0].structuredContent?.[contentId];
    expect(document?.rootId).toBe(contentId);
    expect(document?.kind).toBe("math");
    expect(document?.authority).toBeUndefined();
    expect(
      serializeToMarkdown(state.document.page.blocks, undefined, {
        schema: state.schema,
      }),
    ).toBe("$x$");
  });

  it("replays to the same page and retains add-only attachment infrastructure on undo", () => {
    const before = createMathTestState(loadMathPage("x"));
    const { result, state: after } = attach(before);
    const replayed = applyOps(before.document.page, result.ops, before.schema);
    expect(replayed).toEqual(result.newPage);

    const recorded = recordUndoOps(
      before,
      after,
      result.ops,
      before.CRDTbinding.getPeerId(),
    );
    const undone = undoState(recorded).state;
    expect(resolveMarkRuns(undone.document.page.blocks[0])).toEqual([]);
    expect(undone.document.page.blocks[0].structuredContent).toBeDefined();
    expect(
      serializeToMarkdown(undone.document.page.blocks, undefined, {
        schema: undone.schema,
      }),
    ).toBe("x");

    const redone = redoState(undone).state;
    expect(resolveMarkRuns(redone.document.page.blocks[0])[0]?.name).toBe(
      "math",
    );
    expect(
      serializeToMarkdown(redone.document.page.blocks, undefined, {
        schema: redone.schema,
      }),
    ).toBe("$x$");
  });

  it("lets serializers resolve canonical tree source through the generic facet", () => {
    const before = createMathTestState(loadMathPage("x"));
    const { state } = attach(before);
    const block = state.document.page.blocks[0];
    const contentId = resolveMarkRuns(block)[0]?.attrs.contentId;
    expect(typeof contentId).toBe("string");
    if (typeof contentId !== "string") return;

    const canonical = parseLegacyMathDocumentInit("\\frac{a}{b}", {
      contentId,
      authority: "supplemental",
    }).document;
    const page = {
      ...state.document.page,
      blocks: [
        {
          ...block,
          structuredContent: {
            ...(block.structuredContent ?? {}),
            [contentId]: canonical,
          },
        },
      ],
    };
    const seen: string[] = [];

    expect(
      serializeToMarkdown(page.blocks, undefined, { schema: state.schema }),
    ).toBe("$\\frac{a}{b}$");
    expect(
      serializeToHTMLFragment(page.blocks, {
        schema: state.schema,
        renderReplacement: (_type, source) => {
          seen.push(source);
          return `<math>${source}</math>`;
        },
      }),
    ).toContain("<math>\\frac{a}{b}</math>");
    expect(seen).toEqual(["\\frac{a}{b}"]);
    // Compatibility characters remain intact for older clients.
    expect(resolveMarkRuns(page.blocks[0])[0]?.text).toBe("x");
  });

  it("expands clipped flat range edges to whole structured marks", () => {
    const initial = createMathTestState(loadMathPage("axyb"));
    const attached = attachRange(initial, 0, 1, 3).state;
    const forward = updateSelection(attached, {
      anchor: { blockIndex: 0, textIndex: 0 },
      focus: { blockIndex: 0, textIndex: 2 },
    });
    expect(selectionPartiallyIntersectsStructuredMark(forward)).toBe(true);
    const expandedForward = expandSelectionAroundStructuredMarks(forward);
    expect(expandedForward.document.selection).toMatchObject({
      anchor: { blockIndex: 0, textIndex: 0 },
      focus: { blockIndex: 0, textIndex: 3 },
      isForward: true,
    });
    expect(selectionPartiallyIntersectsStructuredMark(expandedForward)).toBe(
      false,
    );

    const backward = updateSelection(attached, {
      anchor: { blockIndex: 0, textIndex: 4 },
      focus: { blockIndex: 0, textIndex: 2 },
    });
    const expandedBackward = expandSelectionAroundStructuredMarks(backward);
    expect(expandedBackward.document.selection).toMatchObject({
      anchor: { blockIndex: 0, textIndex: 4 },
      focus: { blockIndex: 0, textIndex: 1 },
      isForward: false,
    });
  });

  it("does not split a supplemental attachment away from its owning block", () => {
    const initial = createMathTestState(loadMathPage("axyb"));
    const attached = attachRange(initial, 0, 1, 3).state;

    for (const splitAt of [0, 1, 2]) {
      const before = moveCursorToPosition(attached, 0, splitAt);
      const result = splitBlock(before);
      expect(result.ops).toEqual([]);
      expect(result.state.document.page).toBe(before.document.page);
      expect(
        serializeToMarkdown(result.state.document.page.blocks, undefined, {
          schema: result.state.schema,
        }),
      ).toBe("a$xy$b");
    }

    // Once every attached run remains on the original block, splitting the
    // trailing prose is safe and keeps the canonical document reachable.
    const safe = splitBlock(moveCursorToPosition(attached, 0, 3));
    expect(safe.ops.length).toBeGreaterThan(0);
    expect(
      serializeToMarkdown(safe.state.document.page.blocks, undefined, {
        schema: safe.state.schema,
      }),
    ).toBe("a$xy$\nb");
  });

  it("clones and re-addresses supplemental attachments when joining blocks", () => {
    const initial = createMathTestState(loadMathPage("before\nxy"));
    const attached = attachRange(initial, 1, 0, 2).state;
    const [target, source] = attached.document.page.blocks;
    const result = mergeBlocksOps(
      attached.document.page,
      source,
      target,
      attached.CRDTbinding,
      attached.schema,
    );

    expect(result.ops.map((op) => op.op)).toEqual([
      "content_edit",
      "text_insert",
      "mark_set",
      "block_delete",
    ]);
    expect(
      result.newPage.blocks.filter((block) => !block.deleted),
    ).toHaveLength(1);
    expect(
      serializeToMarkdown(result.newPage.blocks, undefined, {
        schema: attached.schema,
      }),
    ).toBe("before$xy$");

    const joined = result.newPage.blocks.find(
      (block) => block.id === target.id && !block.deleted,
    );
    expect(joined).toBeDefined();
    const run = joined ? resolveMarkRuns(joined)[0] : undefined;
    const sourceContentId = resolveMarkRuns(source)[0]?.attrs.contentId;
    const joinedContentId = run?.attrs.contentId;
    expect(typeof joinedContentId).toBe("string");
    expect(joinedContentId).not.toBe(sourceContentId);
    if (typeof joinedContentId === "string") {
      expect(joined?.structuredContent?.[joinedContentId]?.rootId).toBe(
        joinedContentId,
      );
    }

    const after: EditorState = {
      ...attached,
      document: { ...attached.document, page: result.newPage },
    };
    const recorded = recordUndoOps(
      attached,
      after,
      result.ops,
      attached.CRDTbinding.getPeerId(),
    );
    const undone = undoState(recorded).state;
    expect(
      serializeToMarkdown(undone.document.page.blocks, undefined, {
        schema: undone.schema,
      }),
    ).toBe("before\n$xy$");
    const redone = redoState(undone).state;
    expect(
      serializeToMarkdown(redone.document.page.blocks, undefined, {
        schema: redone.schema,
      }),
    ).toBe("before$xy$");
  });

  it("preserves distinct attachments when both joined blocks contain structured marks", () => {
    const initial = createMathTestState(loadMathPage("a\nb"));
    const targetAttached = attachRange(initial, 0, 0, 1).state;
    const attached = attachRange(targetAttached, 1, 0, 1).state;
    const [target, source] = attached.document.page.blocks;
    const result = mergeBlocksOps(
      attached.document.page,
      source,
      target,
      attached.CRDTbinding,
      attached.schema,
    );

    expect(
      serializeToMarkdown(result.newPage.blocks, undefined, {
        schema: attached.schema,
      }),
    ).toBe("$a$$b$");
    const joined = result.newPage.blocks.find(
      (block) => block.id === target.id && !block.deleted,
    );
    expect(joined).toBeDefined();
    const contentIds = joined
      ? resolveMarkRuns(joined).map((run) => run.attrs.contentId)
      : [];
    expect(contentIds).toHaveLength(2);
    expect(new Set(contentIds).size).toBe(2);
    for (const contentId of contentIds) {
      expect(typeof contentId).toBe("string");
      if (typeof contentId === "string") {
        expect(joined?.structuredContent?.[contentId]?.rootId).toBe(contentId);
      }
    }
    expect(
      applyOps(attached.document.page, result.ops, attached.schema),
    ).toEqual(result.newPage);
  });
});
