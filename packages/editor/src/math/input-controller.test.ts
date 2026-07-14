/**
 * The `\` autocomplete menu reads its query through this run detector, straight
 * from the raw-text field the caret sits in. It must stay independent of the
 * canonical source projection, which is not a faithful echo of what was typed:
 * a pending lone `\` projects as `\backslash`, so any source-slicing approach
 * misreads the run (that regression once killed the menu on its opening tick).
 */
import { createDeterministicIdentityAllocator } from "../sync/id";
import {
  applyStructuredEdits,
  getStructuredChildren,
  type StructuredDocument,
} from "../sync/structured-content";
import { trailingMathCommandRun } from "./input-controller";
import { mathDocumentToStructured } from "./structured";
import { insertMathText, type MathTreeCaret } from "./tree-edit";
import { describe, expect, it } from "vitest";

describe("trailingMathCommandRun", () => {
  it("reports an empty query right after the trigger backslash", () => {
    const { document, caret } = typedMathDocument("\\");
    const run = trailingMathCommandRun(document, caret);
    expect(run).toBeDefined();
    expect(run?.query).toBe("");
    expect(run?.range.focus).toEqual(caret);
    expect(run?.range.anchor).toEqual({ ...caret, afterCharId: null });
  });

  it("reports the letters typed after the backslash", () => {
    const { document, caret } = typedMathDocument("\\fr");
    expect(trailingMathCommandRun(document, caret)?.query).toBe("fr");
  });

  it("keeps the backslash identity stable while the query grows", () => {
    const first = typedMathDocument("\\");
    const opening = trailingMathCommandRun(first.document, first.caret);
    const grown = typeInto(first.document, first.caret, "fr");
    const current = trailingMathCommandRun(grown.document, grown.caret);
    expect(opening?.backslashCharId).toBeDefined();
    expect(current?.backslashCharId).toBe(opening?.backslashCharId);
  });

  it("returns nothing when no command run precedes the caret", () => {
    const { document, caret } = typedMathDocument("xy");
    expect(trailingMathCommandRun(document, caret)).toBeUndefined();
  });

  it("returns nothing for a row-gap caret", () => {
    const document = emptyMathDocument();
    const rowId = bodyRowId(document);
    expect(
      trailingMathCommandRun(document, {
        kind: "row",
        rowId,
        afterNodeId: null,
      }),
    ).toBeUndefined();
  });
});

function emptyMathDocument(): StructuredDocument {
  return mathDocumentToStructured(
    {
      version: 1,
      root: {
        type: "root",
        id: "root",
        body: { type: "row", id: "body", children: [] },
      },
    },
    {
      identityAllocator: createDeterministicIdentityAllocator("source-char"),
    },
  );
}

function bodyRowId(document: StructuredDocument): string {
  const row = getStructuredChildren(document, document.rootId, "body")[0];
  if (!row) throw new Error("expected a body row");
  return row.id;
}

// Shared across inserts: minted identities must keep strictly increasing
// counters within one document, so a per-call allocator would be rejected.
const typedIdentities = createDeterministicIdentityAllocator("typed", 500);

function typeInto(
  document: StructuredDocument,
  caret: MathTreeCaret,
  text: string,
): { document: StructuredDocument; caret: MathTreeCaret } {
  const result = insertMathText(document, caret, text, typedIdentities);
  if (!result.handled) {
    throw new Error(`expected the insert to be handled: ${result.reason}`);
  }
  return {
    document: applyStructuredEdits(document, result.edits),
    caret: result.caret,
  };
}

/** A math document with `text` typed at the body row, caret left at its end. */
function typedMathDocument(text: string): {
  document: StructuredDocument;
  caret: MathTreeCaret;
} {
  const document = emptyMathDocument();
  return typeInto(
    document,
    { kind: "row", rowId: bodyRowId(document), afterNodeId: null },
    text,
  );
}
