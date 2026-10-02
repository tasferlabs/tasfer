import { codeExtension } from "./code-extension";
import { codeSelectionRungs } from "./code-selection";
import { createNodeRegistry } from "@tasfer/editor";
import {
  EXPAND_SELECTION,
  nextEnclosingRange,
  SHRINK_SELECTION,
} from "@tasfer/editor/actions/selection-expansion";
import type { CodeBlock } from "@tasfer/editor/nodes/code-block";
import { baseSchema } from "@tasfer/editor/schema";
import type { Page } from "@tasfer/editor/serlization/loadPage";
import type { EditorState } from "@tasfer/editor/state-types";
import { createInitialState } from "@tasfer/editor/state-utils";
import { describe, expect, it } from "vitest";

/** Every rung from a caret at `at`, in the order expand takes them. */
function ladder(text: string, at: number): string[] {
  const out: string[] = [];
  let current = { from: at, to: at };
  for (;;) {
    const next = nextEnclosingRange(
      codeSelectionRungs(text, current.from, current.to),
      current,
    );
    if (!next) return out;
    out.push(text.slice(next.from, next.to));
    current = next;
  }
}

describe("codeSelectionRungs", () => {
  it("climbs word → brackets → trimmed line → line → block", () => {
    const text = "if (x) {\n  call(a, b);\n}";
    expect(ladder(text, text.indexOf("a,"))).toEqual([
      "a",
      "a, b",
      "(a, b)",
      "call(a, b);",
      "  call(a, b);",
      "\n  call(a, b);\n",
      "{\n  call(a, b);\n}",
      text,
    ]);
  });

  it("takes the inside of quotes before the quotes themselves", () => {
    const text = 'log("hello world")';
    expect(ladder(text, text.indexOf("world"))).toEqual([
      "world",
      "hello world",
      '"hello world"',
      '("hello world")',
      text,
    ]);
  });

  it("ignores brackets inside a string", () => {
    const text = 'f(")", y)';
    expect(ladder(text, text.indexOf("y"))).toEqual([
      "y",
      '")", y',
      '(")", y)',
      text,
    ]);
  });

  it("does not pair quotes across lines", () => {
    const text = "a = 'x\nb = y'";
    expect(ladder(text, text.indexOf("y"))).toEqual(["y", "b = y'", text]);
  });

  it("an empty block has nowhere to go", () => {
    expect(ladder("", 0)).toEqual([]);
  });
});

describe("code block — expand / shrink selection", () => {
  const schema = baseSchema.use(codeExtension());

  function state(text: string, at: number): EditorState {
    const code: CodeBlock = {
      id: "code-1",
      orderKey: "a0",
      deleted: false,
      type: "code",
      charRuns: [{ peerId: "peer", startCounter: 0, text }],
      formats: [],
      language: "",
    };
    const paragraph = {
      id: "p-1",
      orderKey: "a1",
      deleted: false as const,
      type: "paragraph" as const,
      charRuns: [{ peerId: "peer", startCounter: 50, text: "after" }],
      formats: [],
    };
    const page: Page = { id: "page-1", title: "t", blocks: [code, paragraph] };
    const s = createInitialState(page, {
      nodes: createNodeRegistry(schema.nodes),
    });
    return {
      ...s,
      document: {
        ...s.document,
        cursor: { position: { blockIndex: 0, textIndex: at }, lastUpdate: 0 },
      },
    };
  }

  const expand = (s: EditorState) =>
    s.actionBus.dispatchState(EXPAND_SELECTION, s).state;
  const shrink = (s: EditorState) =>
    s.actionBus.dispatchState(SHRINK_SELECTION, s).state;
  const span = (s: EditorState) => {
    const sel = s.document.selection!;
    return [
      sel.anchor.blockIndex,
      sel.anchor.textIndex,
      sel.focus.blockIndex,
      sel.focus.textIndex,
    ];
  };

  it("climbs the code's rungs, then the whole document", () => {
    const text = "f(a)";
    const s1 = expand(state(text, 2));
    expect(span(s1)).toEqual([0, 2, 0, 3]); // a
    const s2 = expand(s1);
    expect(span(s2)).toEqual([0, 1, 0, 4]); // (a)
    const s3 = expand(s2);
    expect(span(s3)).toEqual([0, 0, 0, 4]); // the whole block
    const s4 = expand(s3);
    expect(span(s4)).toEqual([0, 0, 1, 5]); // the document
    expect(span(shrink(s4))).toEqual([0, 0, 0, 4]);
    expect(span(shrink(shrink(s4)))).toEqual([0, 1, 0, 4]);
  });
});
