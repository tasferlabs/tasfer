/**
 * Taking back a markdown auto-format.
 *
 * The rules fire on the keystroke that completes them ("# " → heading), which
 * leaves no way to type that syntax literally. `revertInputRule` is that way:
 * it restores the block/mark state and re-inserts the syntax as a FORWARD edit,
 * then suppresses the rule so the next keystroke doesn't promote it right back.
 *
 * Pinned here: the round-trip is exact, the suppression holds across every
 * content edit (not just the next keystroke, and not just inside the block),
 * and it lifts once the restored syntax is gone.
 */

import { baseSchema } from "../schema";
import { moveCursorToPosition } from "../selection";
import type { Block, Page } from "../serlization/loadPage";
import type { CursorState, EditorState } from "../state-types";
import { createInitialState } from "../state-utils";
import { getVisibleTextFromRuns } from "../sync/char-runs";
import { deleteText, insertText, revertInputRule } from "./actions";
import { describe, expect, it } from "vitest";

function paragraph(id: string, orderKey: string, text: string): Block {
  return {
    id,
    orderKey,
    deleted: false,
    type: "paragraph",
    charRuns: text ? [{ peerId: "peer", startCounter: 0, text }] : [],
    formats: [],
  } as unknown as Block;
}

function cursorAt(blockIndex: number, textIndex: number): CursorState {
  return { position: { blockIndex, textIndex }, lastUpdate: 0 };
}

function stateWith(page: Page, cursor: CursorState): EditorState {
  const base = createInitialState(page, { schema: baseSchema.data });
  return { ...base, document: { ...base.document, cursor } };
}

function text(block: Block): string {
  return getVisibleTextFromRuns((block as { charRuns?: [] }).charRuns);
}

/** Type `input` one character at a time, threading state through. */
function type(state: EditorState, input: string): EditorState {
  let s = state;
  for (const ch of input) s = insertText(s, ch).state;
  return s;
}

describe("reverting a block-prefix rule", () => {
  it("restores the paragraph and the literal syntax", () => {
    const promoted = type(stateWith(pageOf(""), cursorAt(0, 0)), "# ");
    expect(promoted.document.page.blocks[0].type).toBe("heading1");
    expect(text(promoted.document.page.blocks[0])).toBe("");

    const reverted = revertInputRule(promoted);
    expect(reverted).not.toBeNull();
    const block = reverted!.state.document.page.blocks[0];
    expect(block.type).toBe("paragraph");
    expect(text(block)).toBe("# ");
    expect(reverted!.state.document.cursor?.position.textIndex).toBe(2);
  });

  it("emits forward ops, never the transform's inverses", () => {
    const promoted = type(stateWith(pageOf(""), cursorAt(0, 0)), "# ");
    const reverted = revertInputRule(promoted)!;
    // A block_set back to paragraph plus a text_insert of the literal prefix.
    expect(reverted.ops.map((o) => o.op).sort()).toEqual([
      "block_set",
      "text_insert",
    ]);
  });

  it("does not re-fire on the next keystroke", () => {
    const promoted = type(stateWith(pageOf(""), cursorAt(0, 0)), "# ");
    const reverted = revertInputRule(promoted)!.state;
    const after = type(reverted, "hi");
    const block = after.document.page.blocks[0];
    expect(block.type).toBe("paragraph");
    expect(text(block)).toBe("# hi");
  });

  it("a reverted todo prefix is not then claimed by the bullet rule", () => {
    // "- [ ] " still starts with "- ", so suppressing only the rule that fired
    // would just hand the block to the next rule down the chain.
    // Seeded rather than typed: typing "- " promotes to a bullet first, so the
    // todo branch is only reachable when the text arrives some other way.
    const promoted = type(stateWith(pageOf("- [ ]"), cursorAt(0, 5)), " ");
    expect(promoted.document.page.blocks[0].type).toBe("todo_list");

    const reverted = revertInputRule(promoted)!.state;
    const after = type(reverted, "x");
    const block = after.document.page.blocks[0];
    expect(block.type).toBe("paragraph");
    expect(text(block)).toBe("- [ ] x");
  });

  it("only arms for one caret position", () => {
    const promoted = type(stateWith(pageOf(""), cursorAt(0, 0)), "# ");
    const typedOn = type(promoted, "x");
    expect(typedOn.ui.revertibleInputRule).toBeNull();
    expect(revertInputRule(typedOn)).toBeNull();
  });

  it("does not re-fire on a delete either", () => {
    // Prefix promotion is re-asserted after every content edit, not just after
    // typing — so Backspace has to honour the suppression too, or the heading
    // comes straight back the moment the user edits the text they kept.
    const promoted = type(stateWith(pageOf(""), cursorAt(0, 0)), "# ");
    const typedOn = type(revertInputRule(promoted)!.state, "abc");
    const deleted = deleteText(typedOn).state;
    const block = deleted.document.page.blocks[0];
    expect(block.type).toBe("paragraph");
    expect(text(block)).toBe("# ab");
  });

  it("survives leaving the block and coming back", () => {
    const promoted = type(
      stateWith(pageOf("", "second"), cursorAt(0, 0)),
      "# ",
    );
    const reverted = revertInputRule(promoted)!.state;

    const away = moveCursorToPosition(reverted, 1, 0);
    const back = moveCursorToPosition(away, 0, 2);
    const typed = type(back, "hi");
    const block = typed.document.page.blocks[0];
    expect(block.type).toBe("paragraph");
    expect(text(block)).toBe("# hi");
  });

  it("releases once the restored syntax is gone", () => {
    // Suppression lasts exactly as long as the literal text it protects. Delete
    // that text and the rule is live again, so retyping the trigger works.
    const promoted = type(stateWith(pageOf(""), cursorAt(0, 0)), "- ");
    let s = revertInputRule(promoted)!.state;
    s = deleteText(s).state; // "-"
    s = deleteText(s).state; // ""
    expect(s.ui.suppressedInputRule).toBeNull();

    expect(type(s, "- ").document.page.blocks[0].type).toBe("bullet_list");
  });

  it("ignores an edit made far from the syntax", () => {
    // A block can already start with "# " without the rule ever having fired:
    // pasted, merged, or arrived from a peer. Promotion is re-asserted after
    // every content edit, so without a caret gate, typing at the END of such a
    // block would morph it and swallow the prefix — an undo the user never
    // asked to spend, at a spot they weren't even looking at.
    const typed = type(stateWith(pageOf("# foo"), cursorAt(0, 5)), "x");
    const block = typed.document.page.blocks[0];
    expect(block.type).toBe("paragraph");
    expect(text(block)).toBe("# foox");
    expect(typed.document.cursor?.position.textIndex).toBe(6);
  });

  it("still fires for an edit on the syntax itself", () => {
    // The gate is about where the user is working, not about how the text got
    // there: completing "# " at the caret promotes even in a block whose text
    // predates the edit.
    const typed = type(stateWith(pageOf("#foo"), cursorAt(0, 1)), " ");
    const block = typed.document.page.blocks[0];
    expect(block.type).toBe("heading1");
    expect(text(block)).toBe("foo");
    // And it is still one Backspace away from the literal text.
    expect(text(revertInputRule(typed)!.state.document.page.blocks[0])).toBe(
      "# foo",
    );
  });

  it("reverts a list, leaving no stale list fields behind", () => {
    const promoted = type(stateWith(pageOf(""), cursorAt(0, 0)), "- ");
    expect(promoted.document.page.blocks[0].type).toBe("bullet_list");

    const reverted = revertInputRule(promoted)!;
    const block = reverted.state.document.page.blocks[0];
    expect(block.type).toBe("paragraph");
    expect(text(block)).toBe("- ");
    // `indent` isn't a paragraph field, so the revert doesn't restore it (and
    // doesn't broadcast a set the reducer would drop).
    expect((block as unknown as { indent?: number }).indent).toBeUndefined();
    expect(
      reverted.ops.filter((o) => o.op === "block_set" && o.field === "indent"),
    ).toHaveLength(0);
  });
});

describe("reverting an inline-wrap rule", () => {
  it("removes the mark and puts both delimiters back", () => {
    const wrapped = type(stateWith(pageOf(""), cursorAt(0, 0)), "**bold**");
    const block = wrapped.document.page.blocks[0];
    expect(text(block)).toBe("bold");
    expect(
      (block as unknown as { formats: unknown[] }).formats.length,
    ).toBeGreaterThan(0);

    const reverted = revertInputRule(wrapped)!;
    const after = reverted.state.document.page.blocks[0];
    expect(text(after)).toBe("**bold**");
    expect((after as unknown as { formats: unknown[] }).formats).toHaveLength(
      0,
    );
    expect(reverted.state.document.cursor?.position.textIndex).toBe(8);
  });

  it("needs no suppression — the rule only matches at the caret", () => {
    const wrapped = type(stateWith(pageOf(""), cursorAt(0, 0)), "`code`");
    const reverted = revertInputRule(wrapped)!.state;
    const after = type(reverted, "x");
    const block = after.document.page.blocks[0];
    expect(text(block)).toBe("`code`x");
    expect((block as unknown as { formats: unknown[] }).formats).toHaveLength(
      0,
    );
  });
});

function pageOf(...texts: string[]): Page {
  return {
    id: "page-1",
    title: "t",
    blocks: texts.map((t, i) => paragraph(`p-${i}`, `a${i}`, t)),
  };
}
