/**
 * Cut a line that carries an inline math chip, then undo/redo it repeatedly.
 *
 * Written to chase a report of "the math mark disappears, and repeating
 * undo/redo duplicates text". It never reproduced that: across every variant
 * below the cut/undo/redo cycle is byte-identical each time round, and an
 * independent op-log replica never diverges from local state. That is the point
 * of keeping the file — it pins the round-trip down so a future regression in
 * `crdt-undo` / `inverse` has to walk past twelve assertions.
 *
 * It did turn up two real findings, kept as L (fixed: the cut now retires the
 * mark span with its attachment) and K (documented, not fixed).
 *
 * Everything drives the real path the app takes: `deleteSelectionThroughOwner`
 * — the shared branch behind Cmd+X, `editor.cut()` and `deleteRange` — committed
 * through `recordUndoOps` exactly like `editor.executeAction`, then `undoState`
 * / `redoState`. Every op sequence is logged; run with
 * `--disable-console-intercept` to see the dumps.
 *
 * The schema here is the FULL `mathExtension()` (what the app installs), not
 * the compatibility schema in `__testutils__/math`, which filters the inline
 * tree input rules out.
 */

import { resolveStructuredInlineMathRuns } from "./inline-structured";
import { enterInlineMathTreeAtPosition } from "./inline-tree-state";
import { mathExtension } from "./math-extension";
import {
  deleteSelectionThroughOwner,
  insertText,
} from "@tasfer/editor/actions/actions";
import { STRUCTURED_MARK_ANCHOR_CHAR } from "@tasfer/editor/feature-facets";
import { resolveMarkRuns } from "@tasfer/editor/mark-runs";
import type { TextualBlock } from "@tasfer/editor/nodes/TextNode";
import { createMarkRegistry } from "@tasfer/editor/rendering/marks";
import { createNodeRegistry } from "@tasfer/editor/rendering/nodes";
import { baseSchema } from "@tasfer/editor/schema";
import { moveCursorToPosition } from "@tasfer/editor/selection";
import {
  type Block,
  loadPage,
  type MarkSpan,
} from "@tasfer/editor/serlization/loadPage";
import type {
  ActionResult,
  EditorState,
  Operation,
  Position,
} from "@tasfer/editor/state-types";
import { createInitialState } from "@tasfer/editor/state-utils";
import { isTextualBlock } from "@tasfer/editor/sync/block-registry";
import { getVisibleTextFromRuns } from "@tasfer/editor/sync/char-runs";
import {
  recordUndoOps,
  redoState,
  undoState,
} from "@tasfer/editor/sync/crdt-undo";
import { applyOps } from "@tasfer/editor/sync/reducer";
import { createCRDTbinding } from "@tasfer/editor/sync/sync";
import { describe, expect, it } from "vitest";

const schema = baseSchema.use(mathExtension());

/* ------------------------------------------------------------------ */
/* harness                                                             */
/* ------------------------------------------------------------------ */

function makeState(markdown: string, peer: string): EditorState {
  return createInitialState(loadPage(markdown, schema.data), {
    schema: schema.data,
    nodes: createNodeRegistry(schema.nodes),
    marks: createMarkRegistry(schema.marks),
    crdtBinding: createCRDTbinding("page", peer),
  });
}

function textOf(block: Block | undefined): string {
  if (!block || !("charRuns" in block)) return "<non-textual>";
  return getVisibleTextFromRuns(block.charRuns);
}

function visibleBlocks(state: EditorState): Block[] {
  return state.document.page.blocks.filter((b) => !b.deleted);
}

function visibleTexts(state: EditorState): string[] {
  return visibleBlocks(state).map(textOf);
}

/** Math mark runs resolved through the generic mark-run resolver. */
function mathMarkRuns(block: Block | undefined) {
  if (!block) return [];
  return resolveMarkRuns(block)
    .filter((run) => run.name === "math")
    .map((run) => ({
      start: run.startIndex,
      end: run.endIndex,
      contentId: (run.attrs as { contentId?: unknown }).contentId,
    }));
}

/** Math chips resolved through math's own inline resolver (what paints). */
function chipRuns(block: Block | undefined) {
  if (!block || !("charRuns" in block)) return [];
  return resolveStructuredInlineMathRuns(block as TextualBlock).map((run) => ({
    start: run.startIndex,
    end: run.endIndex,
    latex: run.latex,
  }));
}

function attachmentIds(block: Block | undefined): string[] {
  return Object.keys(block?.structuredContent ?? {}).sort();
}

function describeState(label: string, state: EditorState): string {
  const lines = [`--- ${label} ---`];
  state.document.page.blocks.forEach((block, i) => {
    lines.push(
      `  [${i}] ${block.id} deleted=${!!block.deleted} type=${block.type} text=${JSON.stringify(textOf(block))}`,
    );
    const spans: readonly MarkSpan[] = isTextualBlock(block)
      ? block.formats
      : [];
    for (const span of spans) {
      lines.push(
        `      span ${JSON.stringify(span.format)} ${span.startCharId}..${span.endCharId}`,
      );
    }
    lines.push(`      markRuns=${JSON.stringify(mathMarkRuns(block))}`);
    lines.push(`      chips=${JSON.stringify(chipRuns(block))}`);
    lines.push(`      attachments=${JSON.stringify(attachmentIds(block))}`);
  });
  return lines.join("\n");
}

function describeOps(label: string, ops: readonly Operation[]): string {
  const rows = ops.map((op) => {
    const o = op as unknown as Record<string, unknown>;
    const parts = [String(o.op)];
    if (o.blockId) parts.push(`block=${String(o.blockId)}`);
    if (o.contentId) parts.push(`content=${String(o.contentId)}`);
    if (o.text !== undefined) parts.push(`text=${JSON.stringify(o.text)}`);
    if (o.charIds) parts.push(`charIds=${JSON.stringify(o.charIds)}`);
    if (o.chars) parts.push(`chars=${JSON.stringify(o.chars).slice(0, 300)}`);
    if (o.afterCharId !== undefined)
      parts.push(`after=${String(o.afterCharId)}`);
    if (o.format) parts.push(`format=${JSON.stringify(o.format)}`);
    if (o.removed !== undefined) parts.push(`removed=${String(o.removed)}`);
    if (o.edit) parts.push(`edit=${JSON.stringify(o.edit).slice(0, 120)}`);
    return `    ${parts.join(" ")}`;
  });
  return `--- ${label} (${ops.length} ops) ---${rows.length ? "\n" + rows.join("\n") : ""}`;
}

/** The branch `cutSelectionToClipboard` takes once the copy succeeded. */
function cutLikeApp(state: EditorState): {
  result: ActionResult;
  branch: string;
} {
  // Call the real thing, so this probe can never test a private copy of the
  // branch that the app has since changed — which is the bug that produced the
  // two cut paths in the first place.
  const ownsInput = state.schema.ownsInput("before-insert", state, "");
  const collapsed = !state.document.selection?.isCollapsed === false;
  return {
    branch: `contentSelection=${!!state.document.contentSelection} ownsInput=${ownsInput} collapsed=${collapsed}`,
    result: deleteSelectionThroughOwner(state),
  };
}

/** Commit an action the way `editor.executeAction` does. */
function commit(prev: EditorState, result: ActionResult): EditorState {
  return result.ops.length > 0
    ? recordUndoOps(
        prev,
        result.state,
        result.ops,
        prev.CRDTbinding.getPeerId(),
      )
    : result.state;
}

function select(
  state: EditorState,
  anchor: Position,
  focus: Position,
): EditorState {
  return {
    ...state,
    document: {
      ...state.document,
      cursor: { position: focus, lastUpdate: 0 },
      selection: { anchor, focus, isForward: true, isCollapsed: false },
    },
  };
}

/**
 * Cut the given selection, then run `cycles` of undo → redo, asserting after
 * each half-step. Returns the running log so a failure can print it.
 */
function runCutUndoRedo(
  initial: EditorState,
  anchor: Position,
  focus: Position,
  cycles = 3,
): void {
  const log: string[] = [];
  log.push(`anchor char = ${JSON.stringify(STRUCTURED_MARK_ANCHOR_CHAR)}`);
  log.push(describeState("initial", initial));

  const before = visibleTexts(initial);
  const beforeChips = chipRuns(visibleBlocks(initial)[0]).length;
  const beforeAttachments = attachmentIds(visibleBlocks(initial)[0]).length;

  const selected = select(initial, anchor, focus);
  const { result, branch } = cutLikeApp(selected);
  log.push(`cut branch: ${branch}`);
  log.push(describeOps("cut ops", result.ops));
  let state = commit(selected, result);
  log.push(describeState("after cut", state));

  const afterCut = visibleTexts(state);

  const dump = () => log.join("\n");

  for (let cycle = 1; cycle <= cycles; cycle++) {
    const u = undoState(state);
    state = u.state;
    log.push(describeOps(`undo #${cycle} ops`, u.ops));
    log.push(describeState(`after undo #${cycle}`, state));

    const undoneTexts = visibleTexts(state);
    const target = visibleBlocks(state)[0];
    const undone = {
      cycle,
      phase: "undo",
      texts: undoneTexts,
      chips: chipRuns(target).length,
      attachments: attachmentIds(target).length,
    };
    const undoneExpected = {
      cycle,
      phase: "undo",
      texts: before,
      chips: beforeChips,
      attachments: beforeAttachments,
    };
    if (JSON.stringify(undone) !== JSON.stringify(undoneExpected)) {
      console.log(dump());
    }
    expect(undone).toEqual(undoneExpected);

    const r = redoState(state);
    state = r.state;
    log.push(describeOps(`redo #${cycle} ops`, r.ops));
    log.push(describeState(`after redo #${cycle}`, state));

    const redone = { cycle, phase: "redo", texts: visibleTexts(state) };
    const redoneExpected = { cycle, phase: "redo", texts: afterCut };
    if (JSON.stringify(redone) !== JSON.stringify(redoneExpected)) {
      console.log(dump());
    }
    expect(redone).toEqual(redoneExpected);
  }
  console.log(dump());
}

/* ------------------------------------------------------------------ */
/* variants                                                            */
/* ------------------------------------------------------------------ */

describe("cut a line with an inline math chip, then undo/redo repeatedly", () => {
  /**
   * A remaining rough edge, pinned as OBSERVED BEHAVIOUR, not as a contract.
   *
   * `deleteSelectionThroughOwner` routes on `document.contentSelection` alone
   * before it ever looks at the flat selection, so a still-active nested math
   * caret wins over a flat whole-line selection laid on top of it — and a
   * COLLAPSED nested caret gives the tree no range to delete, so the cut emits
   * zero ops: Cmd+X copies the line and deletes nothing.
   *
   * Deliberately NOT fixed here. This state is built by hand; in the live
   * editor `reconcileContentSelectionState` runs after every `executeAction`
   * and `extendSelectionOutOfStructuredMark` nulls `contentSelection`, so we
   * have not shown it is reachable through real gestures. Changing the
   * precedence is a selection-model change, not a clipboard one. If a user ever
   * reports "Cmd+X copied but didn't cut", start here.
   */
  it("K: a live nested content selection wins over the flat selection", () => {
    const initial = makeState("aa $x+y$ bb\ntail", "cut-k");
    const run = resolveStructuredInlineMathRuns(
      initial.document.page.blocks[0] as TextualBlock,
    )[0];
    const entered = enterInlineMathTreeAtPosition(initial, 0, run.endIndex, {
      allowBoundary: true,
    });
    if (!entered) throw new Error("inline math did not enter tree mode");
    expect(entered.state.document.contentSelection).not.toBeNull();

    const len = textOf(initial.document.page.blocks[0]).length;
    // Flat whole-line selection laid over the still-active nested caret.
    const selected = select(
      entered.state,
      { blockIndex: 0, textIndex: 0 },
      { blockIndex: 0, textIndex: len },
    );

    const { result, branch } = cutLikeApp(selected);
    console.log(`K cut branch: ${branch}`);
    console.log(describeOps("K cut ops", result.ops));
    console.log(describeState("K after cut", commit(selected, result)));

    expect(branch).toContain("contentSelection=true");
    expect(result.ops).toEqual([]);
    expect(visibleTexts(result.state)).toEqual(visibleTexts(initial));
  });

  /**
   * A cut takes BOTH halves of the chip with it. Before the fix the cut
   * tombstoned the anchor char and deleted the attachment but left the math
   * MarkSpan on the block, un-`removed`, still naming the now-deleted
   * `contentId` — a fossil that stays harmless only while the anchor char stays
   * tombstoned. `structuredMarkCleanupOps` now retires the span in the same
   * transaction, and the undo inverse puts it back.
   */
  it("L: the cut retires the mark span along with its attachment", () => {
    const initial = makeState("aa $x+y$ bb\ntail", "cut-l");
    const len = textOf(initial.document.page.blocks[0]).length;
    const selected = select(
      initial,
      { blockIndex: 0, textIndex: 0 },
      { blockIndex: 0, textIndex: len },
    );
    const { result } = cutLikeApp(selected);
    const state = commit(selected, result);
    const block = state.document.page.blocks[0];

    console.log(describeOps("L cut ops", result.ops));
    console.log(describeState("L after cut", state));

    const mathSpans = (block: Block): readonly MarkSpan[] =>
      isTextualBlock(block)
        ? block.formats.filter((span) => span.format.type === "math")
        : [];

    // The span dies with the chars, in the same transaction as the attachment.
    expect(result.ops.map((op) => op.op)).toContain("mark_set");
    expect(mathSpans(block)).toEqual([]);
    expect(attachmentIds(block)).toEqual([]);
    expect(chipRuns(block)).toEqual([]);

    // ...and undo restores span, attachment and chars together.
    const undone = undoState(state);
    const restored = undone.state.document.page.blocks[0];
    expect(mathSpans(restored)).toHaveLength(1);
    expect(attachmentIds(restored)).toHaveLength(1);
    expect(chipRuns(restored)).toHaveLength(1);
    expect(textOf(restored)).toBe(textOf(initial.document.page.blocks[0]));
  });

  it("A: chip mid-line, text-range selection over the whole line", () => {
    const state = makeState("aa $x+y$ bb\n\ntail", "cut-a");
    const len = textOf(state.document.page.blocks[0]).length;
    runCutUndoRedo(
      state,
      { blockIndex: 0, textIndex: 0 },
      { blockIndex: 0, textIndex: len },
    );
  });

  it("B: chip mid-line, selection spans the trailing line break", () => {
    const state = makeState("aa $x+y$ bb\n\ntail", "cut-b");
    runCutUndoRedo(
      state,
      { blockIndex: 0, textIndex: 0 },
      { blockIndex: 1, textIndex: 0 },
    );
  });

  it("C: the chip is the only content on the line", () => {
    const state = makeState("$x+y$\n\ntail", "cut-c");
    const len = textOf(state.document.page.blocks[0]).length;
    runCutUndoRedo(
      state,
      { blockIndex: 0, textIndex: 0 },
      { blockIndex: 0, textIndex: len },
    );
  });

  it("D: selection ends exactly after the chip (leaves trailing prose)", () => {
    const state = makeState("aa $x+y$ bb\n\ntail", "cut-d");
    const run = resolveStructuredInlineMathRuns(
      state.document.page.blocks[0] as TextualBlock,
    )[0];
    runCutUndoRedo(
      state,
      { blockIndex: 0, textIndex: 0 },
      { blockIndex: 0, textIndex: run.endIndex },
    );
  });

  it("E: two chips on one line, whole-line selection", () => {
    const state = makeState("$a$ mid $b$\n\ntail", "cut-e");
    const len = textOf(state.document.page.blocks[0]).length;
    runCutUndoRedo(
      state,
      { blockIndex: 0, textIndex: 0 },
      { blockIndex: 0, textIndex: len },
    );
  });

  it("F: single-newline page, selection swallows the line break (merge path)", () => {
    const state = makeState("aa $x+y$ bb\ntail", "cut-f");
    runCutUndoRedo(
      state,
      { blockIndex: 0, textIndex: 0 },
      { blockIndex: 1, textIndex: 0 },
    );
  });

  it("G: whole document selected", () => {
    const state = makeState("aa $x+y$ bb\ntail", "cut-g");
    runCutUndoRedo(
      state,
      { blockIndex: 0, textIndex: 0 },
      { blockIndex: 1, textIndex: 4 },
    );
  });

  /**
   * The realistic history: the chip is TYPED (`$x+y$` closes through the input
   * rule, emitting text_insert + content_edit + text_insert + text_delete +
   * mark_set as one group) rather than parsed out of markdown, so the cut's
   * inverse has to roll back against a chip that the op log itself created.
   */
  it("I: typed chip, then cut the line, then undo/redo cycles", () => {
    let state = makeState("", "cut-i");
    state = moveCursorToPosition(state, 0, 0);
    const typeLog: string[] = [];
    for (const ch of "aa $x+y$ bb") {
      const before = state;
      const r = insertText(state, ch);
      state = commit(before, r);
      typeLog.push(
        `    typed ${JSON.stringify(ch)} -> ${JSON.stringify(visibleTexts(state))} ops=${r.ops
          .map((o) => o.op)
          .join(",")}`,
      );
    }
    const log: string[] = [`--- typing ---`, ...typeLog];
    log.push(describeState("after typing", state));

    const len = textOf(state.document.page.blocks[0]).length;
    const before = visibleTexts(state);
    const beforeChips = chipRuns(state.document.page.blocks[0]).length;
    const beforeAttachments = attachmentIds(
      state.document.page.blocks[0],
    ).length;

    const selected = select(
      state,
      { blockIndex: 0, textIndex: 0 },
      { blockIndex: 0, textIndex: len },
    );
    const { result, branch } = cutLikeApp(selected);
    log.push(`cut branch: ${branch}`);
    log.push(describeOps("cut ops", result.ops));
    state = commit(selected, result);
    log.push(describeState("after cut", state));
    const afterCut = visibleTexts(state);

    for (let cycle = 1; cycle <= 4; cycle++) {
      const u = undoState(state);
      state = u.state;
      log.push(describeOps(`undo #${cycle} ops`, u.ops));
      log.push(describeState(`after undo #${cycle}`, state));

      const got = {
        cycle,
        texts: visibleTexts(state),
        chips: chipRuns(state.document.page.blocks[0]).length,
        attachments: attachmentIds(state.document.page.blocks[0]).length,
      };
      const want = {
        cycle,
        texts: before,
        chips: beforeChips,
        attachments: beforeAttachments,
      };
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        console.log(log.join("\n"));
      }
      expect(got).toEqual(want);

      const r = redoState(state);
      state = r.state;
      log.push(describeOps(`redo #${cycle} ops`, r.ops));
      log.push(describeState(`after redo #${cycle}`, state));

      const redone = { cycle, texts: visibleTexts(state) };
      if (JSON.stringify(redone.texts) !== JSON.stringify(afterCut)) {
        console.log(log.join("\n"));
      }
      expect(redone).toEqual({ cycle, texts: afterCut });
    }
    console.log(log.join("\n"));
  });

  /**
   * Typed chip + cut, then walk the WHOLE undo stack down and back up twice —
   * the "repeatedly" in the report, across more than one undo group.
   */
  it("J: typed chip + cut, full undo sweep down and redo sweep back up", () => {
    let state = makeState("", "cut-j");
    state = moveCursorToPosition(state, 0, 0);
    for (const ch of "aa $x+y$ bb") {
      const before = state;
      state = commit(before, insertText(state, ch));
    }
    const typedTexts = visibleTexts(state);
    const typedChips = chipRuns(state.document.page.blocks[0]).length;

    const len = textOf(state.document.page.blocks[0]).length;
    const selected = select(
      state,
      { blockIndex: 0, textIndex: 0 },
      { blockIndex: 0, textIndex: len },
    );
    const { result } = cutLikeApp(selected);
    state = commit(selected, result);

    const log: string[] = [];
    const depth = state.undoManager.undoStack.length;
    log.push(`undo stack depth after cut: ${depth}`);
    log.push(describeState("after cut", state));

    for (let sweep = 1; sweep <= 2; sweep++) {
      // All the way down.
      for (let i = 0; i < depth; i++) {
        const u = undoState(state);
        state = u.state;
        log.push(
          `  sweep ${sweep} undo ${i + 1}/${depth}: ${JSON.stringify(visibleTexts(state))} ops=${u.ops.map((o) => o.op).join(",")}`,
        );
      }
      const bottom = visibleTexts(state);
      if (JSON.stringify(bottom) !== JSON.stringify([""])) {
        console.log(log.join("\n"));
        console.log(describeState(`sweep ${sweep} bottom`, state));
      }
      expect({ sweep, bottom }).toEqual({ sweep, bottom: [""] });

      // All the way back up.
      for (let i = 0; i < depth; i++) {
        const r = redoState(state);
        state = r.state;
        log.push(
          `  sweep ${sweep} redo ${i + 1}/${depth}: ${JSON.stringify(visibleTexts(state))} ops=${r.ops.map((o) => o.op).join(",")}`,
        );
      }
      const top = visibleTexts(state);
      if (JSON.stringify(top) !== JSON.stringify([""])) {
        console.log(log.join("\n"));
        console.log(describeState(`sweep ${sweep} top`, state));
      }
      expect({ sweep, top }).toEqual({ sweep, top: [""] });

      // One undo from the top must bring the typed line (chip included) back.
      const u = undoState(state);
      state = u.state;
      const restored = {
        sweep,
        texts: visibleTexts(state),
        chips: chipRuns(state.document.page.blocks[0]).length,
      };
      if (
        JSON.stringify(restored) !==
        JSON.stringify({ sweep, texts: typedTexts, chips: typedChips })
      ) {
        console.log(log.join("\n"));
        console.log(describeState(`sweep ${sweep} restored`, state));
      }
      expect(restored).toEqual({ sweep, texts: typedTexts, chips: typedChips });

      // Redo back to the cut so the next sweep starts from the same place.
      state = redoState(state).state;
    }
    console.log(log.join("\n"));
  });

  /**
   * The op-log replay invariant: whatever the editor holds locally after the
   * cut/undo/redo dance must equal a replica that only ever saw the emitted
   * ops. A divergence here is exactly the reported "text duplicates" shape —
   * the local page looks right while the broadcast/persisted log does not.
   */
  it("H: local state agrees with an op-log replica across undo/redo cycles", () => {
    const initial = makeState("aa $x+y$ bb\ntail", "cut-h");
    const log: string[] = [];
    log.push(describeState("initial", initial));

    let replicaPage = structuredClone(initial.document.page);
    const replay = (label: string, ops: readonly Operation[]) => {
      replicaPage = applyOps(replicaPage, ops as Operation[], initial.schema);
      log.push(describeOps(label, ops));
      log.push(
        `    replica texts = ${JSON.stringify(
          replicaPage.blocks.filter((b) => !b.deleted).map(textOf),
        )}`,
      );
    };

    const len = textOf(initial.document.page.blocks[0]).length;
    const selected = select(
      initial,
      { blockIndex: 0, textIndex: 0 },
      { blockIndex: 0, textIndex: len },
    );
    const { result, branch } = cutLikeApp(selected);
    log.push(`cut branch: ${branch}`);
    let state = commit(selected, result);
    replay("cut ops", result.ops);
    log.push(describeState("after cut", state));

    const compare = (step: string) => {
      const local = visibleTexts(state);
      const replica = replicaPage.blocks.filter((b) => !b.deleted).map(textOf);
      if (JSON.stringify(local) !== JSON.stringify(replica)) {
        console.log(log.join("\n"));
      }
      expect({ step, replica }).toEqual({ step, replica: local });
    };
    compare("after cut");

    for (let cycle = 1; cycle <= 3; cycle++) {
      const u = undoState(state);
      state = u.state;
      replay(`undo #${cycle} ops`, u.ops);
      log.push(describeState(`after undo #${cycle}`, state));
      compare(`undo #${cycle}`);

      const r = redoState(state);
      state = r.state;
      replay(`redo #${cycle} ops`, r.ops);
      log.push(describeState(`after redo #${cycle}`, state));
      compare(`redo #${cycle}`);
    }
    console.log(log.join("\n"));
  });
});
