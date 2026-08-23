/**
 * Behavior the engine can only exhibit once the code node is installed.
 *
 * These cases used to live in the editor package; they moved here with the node
 * because each one turns on something the node itself contributes — its card
 * `joinGroup`, and its multi-line wrapping — neither of which core knows about
 * now that the `code` type ships without a painter.
 */

import { codeExtension } from "./code-extension";
import { createNodeRegistry } from "@tasfer/editor";
import {
  escapeAboveSelfContainedBlock,
  escapeBelowSelfContainedBlock,
} from "@tasfer/editor/actions/edit-actions";
import { baseSchema } from "@tasfer/editor/schema";
import type { Block } from "@tasfer/editor/serlization/loadPage";
import { loadPage } from "@tasfer/editor/serlization/loadPage";
import type {
  CursorState,
  EditorState,
  ViewportState,
} from "@tasfer/editor/state-types";
import { createInitialState } from "@tasfer/editor/state-utils";
import { cardJoinFlags } from "@tasfer/editor/sync/reducer";
import { describe, expect, it } from "vitest";

const codeSchema = baseSchema.use(codeExtension());
const nodes = createNodeRegistry(codeSchema.nodes);

const VIEWPORT: ViewportState = {
  scrollY: 0,
  width: 800,
  height: 600,
  documentHeight: 600,
};

function stateFrom(markdown: string): EditorState {
  return createInitialState(loadPage(markdown, codeSchema.data), { nodes });
}

function withCaret(
  s: EditorState,
  blockIndex: number,
  textIndex: number,
): EditorState {
  const cursor: CursorState = {
    position: { blockIndex, textIndex },
    lastUpdate: 0,
  };
  return { ...s, document: { ...s.document, cursor } };
}

describe("card tiling", () => {
  const card =
    (type: string) =>
    (id: string): Block =>
      ({ id, type, charRuns: [], formats: [] }) as Block;
  const code = card("code");
  const quote = card("quote");
  const para = card("paragraph");
  const join = (blocks: Block[], index: number) =>
    cardJoinFlags(nodes, blocks, index);

  it("joins a run of code blocks: first joins down, last joins up", () => {
    const blocks = [code("c0"), code("c1"), code("c2")];
    expect(join(blocks, 0)).toEqual({ joinTop: false, joinBottom: true });
    expect(join(blocks, 1)).toEqual({ joinTop: true, joinBottom: true });
    expect(join(blocks, 2)).toEqual({ joinTop: true, joinBottom: false });
  });

  it("tiles across card types — a code block meets an adjacent quote", () => {
    const blocks = [quote("q0"), code("c1"), quote("q2")];
    expect(join(blocks, 1)).toEqual({ joinTop: true, joinBottom: true });
  });

  it("does not join across a paragraph", () => {
    const blocks = [code("c0"), para("p1"), code("c2")];
    expect(join(blocks, 0)).toEqual({ joinTop: false, joinBottom: false });
    expect(join(blocks, 2)).toEqual({ joinTop: false, joinBottom: false });
  });
});

describe("escaping a self-contained code block", () => {
  it("does not escape downward from an inner line of a multi-line block", () => {
    const s = stateFrom("```\nfirst\nsecond\n```");
    const edge = escapeBelowSelfContainedBlock(
      withCaret(s, 0, 0),
      true,
      s.document.page.blocks[0],
      VIEWPORT,
    );
    expect(edge.kind).toBe("fallthrough");
  });

  it("does not escape upward from an inner line of a multi-line block", () => {
    const s = stateFrom("```\nfirst\nsecond\n```");
    const text = "first\nsecond";
    const edge = escapeAboveSelfContainedBlock(
      withCaret(s, 0, text.length),
      true,
      s.document.page.blocks[0],
      VIEWPORT,
    );
    expect(edge.kind).toBe("fallthrough");
  });

  it("escapes downward from the last line of a trailing block", () => {
    const s = stateFrom("```\ncode\n```");
    const edge = escapeBelowSelfContainedBlock(
      withCaret(s, 0, "code".length),
      true,
      s.document.page.blocks[0],
      VIEWPORT,
    );
    expect(edge.kind).toBe("break");
    if (edge.kind !== "break") return;
    expect(edge.state.document.page.blocks[1].type).toBe("paragraph");
  });
});
