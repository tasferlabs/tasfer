import { createDeterministicIdentityAllocator } from "../sync/id";
import { applyStructuredEdit } from "../sync/structured-content";
import {
  mathDocumentToStructured,
  parseMathDocumentInit,
  structuredToMathDocument,
  validateStructuredMathDocument,
} from "./structured";
import {
  type MathDocument,
  mathDocumentsSemanticallyEqual,
  type MathNode,
  type MathRow,
  parseMathDocument,
  printMathDocument,
} from "@cypherkit/tex";
import { describe, expect, it } from "vitest";

describe("structured math adapter", () => {
  it("round-trips every math node kind and keeps matrix identities", () => {
    const math = everyNodeKindDocument();
    const structured = mathDocumentToStructured(math);
    const projected = structuredToMathDocument(structured);

    expect(projected).toEqual(math);
    expect(structured.nodes["matrix-row"]).toMatchObject({
      id: "matrix-row",
      type: "matrix-row",
    });
    expect(structured.nodes["matrix-cell"]).toMatchObject({
      id: "matrix-cell",
      type: "matrix-cell",
    });

    const topLevel = Object.values(structured.nodes)
      .filter(
        (node) =>
          node.placement.parentId === "body" &&
          node.placement.slot === "children",
      )
      .sort((a, b) => a.placement.orderKey.localeCompare(b.placement.orderKey));
    const orderKeys = topLevel.map((node) => node.placement.orderKey);
    expect(orderKeys).toEqual([...orderKeys].sort());
    expect(orderKeys.every((key) => key.length > 0)).toBe(true);
    expect(mathDocumentToStructured(math)).toEqual(structured);
  });

  it("stores every free-form editable string in character CRDT fields", () => {
    const structured = mathDocumentToStructured(everyNodeKindDocument());

    expect(Object.keys(structured.nodes.raw.textFields)).toEqual(["text"]);
    expect(Object.keys(structured.nodes.symbol.textFields).sort()).toEqual([
      "command",
      "value",
    ]);
    expect(Object.keys(structured.nodes.fraction.textFields)).toEqual([
      "leftDelimiter",
    ]);
    expect(Object.keys(structured.nodes.delimited.textFields).sort()).toEqual([
      "left",
      "right",
    ]);
    expect(Object.keys(structured.nodes.matrix.textFields)).toEqual([
      "environment",
    ]);
    expect(Object.keys(structured.nodes.text.textFields)).toEqual(["text"]);
    expect(Object.keys(structured.nodes.operator.textFields)).toEqual(["name"]);
    expect(Object.keys(structured.nodes["raw-latex"].textFields)).toEqual([
      "latex",
    ]);
    expect(structured.nodes.raw.attrs).not.toHaveProperty("text");
    expect(structured.nodes.fraction.attrs).toMatchObject({
      leftDelimiterPresent: true,
      rightDelimiterPresent: false,
    });
  });

  it("projects character-CRDT edits back into semantic LaTeX", () => {
    const mutation = parseMathDocumentInit("ab", {
      contentId: "content:9",
      identityAllocator: createDeterministicIdentityAllocator("projection"),
    });
    const raw = Object.values(mutation.document.nodes).find(
      (node) => node.type === "raw-text",
    );
    if (!raw) throw new Error("expected raw-text node");
    const run = raw.textFields.text[0];
    const afterCharId = `${run.peerId}:${run.startCounter + run.text.length - 1}`;

    const edited = applyStructuredEdit(mutation.document, {
      kind: "text_insert",
      nodeId: raw.id,
      field: "text",
      afterCharId,
      charRuns: [{ peerId: "edit", startCounter: 0, text: "c" }],
    });
    const projected = structuredToMathDocument(edited);

    expect(projected).toBeDefined();
    expect(printMathDocument(projected!)).toBe("abc");

    const deleted = applyStructuredEdit(edited, {
      kind: "text_delete",
      nodeId: raw.id,
      field: "text",
      charIds: [`${run.peerId}:${run.startCounter}`],
    });
    expect(printMathDocument(structuredToMathDocument(deleted)!)).toBe("bc");
  });

  it("creates a deterministic atomic initializer from one identity allocator", () => {
    const latex = String.raw`x+\frac{a}{b}`;
    const options = {
      contentId: "content:7",
      identityAllocator: createDeterministicIdentityAllocator("import"),
    };
    const mutation = parseMathDocumentInit(latex, options);

    expect(mutation.kind).toBe("document_init");
    expect(mutation.document.rootId).toBe("content:7");
    expect(mutation.document.nodes["content:7"].type).toBe("root");
    expect(mutation.document.nodes["import:0"].type).toBe("row");
    expect(
      Object.values(mutation.document.nodes)
        .flatMap((node) => Object.values(node.textFields))
        .flatMap((runs) => runs)
        .every((run) => run.peerId === "import"),
    ).toBe(true);
    // Parse-time creation (markdown import) leans on determinism: re-parsing
    // the same source with an equally-seeded allocator is byte-identical.
    expect(
      parseMathDocumentInit(latex, {
        ...options,
        identityAllocator: createDeterministicIdentityAllocator("import"),
      }).document,
    ).toEqual(mutation.document);

    const projected = structuredToMathDocument(mutation.document);
    expect(projected).toBeDefined();
    expect(
      mathDocumentsSemanticallyEqual(
        projected!,
        parseMathDocument(latex, {
          identityAllocator: createDeterministicIdentityAllocator("comparison"),
        }),
      ),
    ).toBe(true);
  });

  it("keeps projecting when a race-losing edit orphans a node", () => {
    const contentId = "content:7";
    const { document } = parseMathDocumentInit("a+b", { contentId });
    const orphaned = applyStructuredEdit(document, {
      kind: "node_insert",
      node: {
        id: "loser:0",
        type: "row",
        placement: { parentId: "ghost:0", slot: "children", orderKey: "a0" },
      },
    });

    expect(orphaned.nodes["loser:0"]).toBeDefined();
    const validated = validateStructuredMathDocument(orphaned);
    expect(validated).toBeDefined();
    expect(printMathDocument(structuredToMathDocument(orphaned)!)).toBe("a+b");
  });

  it("rejects invalid feature shapes without discarding the generic snapshot", () => {
    const structured = mathDocumentToStructured(everyNodeKindDocument());
    const invalidAttribute = {
      ...structured,
      nodes: {
        ...structured.nodes,
        fraction: {
          ...structured.nodes.fraction,
          attrs: { ...structured.nodes.fraction.attrs, bar: "broken" },
        },
      },
    };
    const visibleExtra = {
      ...structured,
      nodes: {
        ...structured.nodes,
        extra: {
          id: "extra",
          type: "raw-text",
          placement: {
            parentId: structured.rootId,
            slot: "unexpected",
            orderKey: "a0",
          },
          attrs: {},
          textFields: { text: [] },
        },
      },
    };

    expect(structuredToMathDocument(invalidAttribute)).toBeUndefined();
    expect(validateStructuredMathDocument(invalidAttribute)).toBeUndefined();
    expect(structuredToMathDocument(visibleExtra)).toBeUndefined();
    expect(visibleExtra.nodes.extra).toBeDefined();
  });

  it("rejects malformed or colliding injected character identities", () => {
    const math = parseMathDocument("x", {
      identityAllocator: createDeterministicIdentityAllocator("nodes"),
    });
    expect(() =>
      mathDocumentToStructured(math, {
        identityAllocator: { nextId: () => "not-an-id" },
      }),
    ).toThrow(/character identity/);
    expect(() =>
      mathDocumentToStructured(math, {
        identityAllocator: {
          nextId: () => math.root.body.children[0].id,
        },
      }),
    ).toThrow(/character identity|Duplicate/);
  });
});

function everyNodeKindDocument(): MathDocument {
  return {
    version: 1,
    root: {
      type: "root",
      id: "root",
      body: row("body", [
        { type: "raw-text", id: "raw", text: "xy" },
        {
          type: "symbol",
          id: "symbol",
          value: "α",
          command: "alpha",
          symbolClass: "mathord",
        },
        {
          type: "fraction",
          id: "fraction",
          numerator: row("numerator"),
          denominator: row("denominator"),
          bar: "rule",
          style: "display",
          continued: false,
          leftDelimiter: "(",
          rightDelimiter: null,
        },
        {
          type: "radical",
          id: "radical",
          index: row("radical-index"),
          radicand: row("radicand"),
        },
        {
          type: "scripts",
          id: "scripts",
          base: row("script-base"),
          superscript: row("superscript"),
          subscript: null,
        },
        {
          type: "delimited",
          id: "delimited",
          left: String.raw`\langle`,
          right: String.raw`\rangle`,
          body: row("delimited-body"),
        },
        {
          type: "matrix",
          id: "matrix",
          environment: "array",
          columnAlignment: ["l", "r"],
          rows: [
            {
              type: "matrix-row",
              id: "matrix-row",
              cells: [
                {
                  type: "matrix-cell",
                  id: "matrix-cell",
                  body: row("matrix-cell-body"),
                },
              ],
            },
          ],
        },
        { type: "text", id: "text", text: "hello", variant: "bold" },
        { type: "operator", id: "operator", name: "rank", limits: true },
        {
          type: "raw-latex",
          id: "raw-latex",
          latex: String.raw`\widehat{x}`,
        },
      ]),
    },
  };
}

function row(id: string, children: readonly MathNode[] = []): MathRow {
  return { type: "row", id, children };
}
