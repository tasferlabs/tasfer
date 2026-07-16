/**
 * Prose input (Arabic, CJK, emoji, …) into a math tree.
 *
 * The math fonts cannot typeset these code points as glyphs: committed as bare
 * raw-text they project as zero-width latent glyphs and every keystroke looks
 * silently dropped (the legacy flat path wrapped them in `\text{…}` via
 * `mathTransformTypedInput`, which the tree input boundary bypasses). These
 * suites pin the tree-native rule: prose commits as a `\text{…}` run,
 * consecutive keystrokes extend ONE run (cursive Arabic only shapes joined
 * forms within a single run), and delete peels the run per character.
 */
import { iterateAllChars } from "../sync/char-runs";
import { createDeterministicIdentityAllocator } from "../sync/id";
import {
  applyStructuredEdits,
  getStructuredChildren,
  type StructuredDocument,
} from "../sync/structured-content";
import { applyMathTreeInputToDocument } from "./input-controller";
import {
  mathDocumentToStructured,
  structuredToMathDocument,
} from "./structured";
import {
  backspaceMathTree,
  deleteForwardMathTree,
  deleteMathTreeRange,
  isMathProseText,
  type MathTreeCaret,
  type MathTreeEditResult,
  moveMathTreeCaret,
} from "./tree-edit";
import { printMathDocument } from "@tasfer/tex/data";
import { describe, expect, it } from "vitest";

describe("isMathProseText", () => {
  it("accepts CJK, Arabic, and emoji", () => {
    expect(isMathProseText("中")).toBe(true);
    expect(isMathProseText("中文")).toBe(true);
    expect(isMathProseText("ب")).toBe(true);
    expect(isMathProseText("😀")).toBe(true);
  });

  it("rejects renderable math input, mixed input, and whitespace", () => {
    expect(isMathProseText("x")).toBe(false);
    expect(isMathProseText("1")).toBe(false);
    expect(isMathProseText("a中")).toBe(false);
    expect(isMathProseText("中 文")).toBe(false);
    expect(isMathProseText("")).toBe(false);
  });
});

describe("typing prose into a math tree", () => {
  it("commits a CJK keystroke as a \\text run instead of a latent glyph", () => {
    const session = startSession();
    session.type("中");
    expect(session.source()).toBe("\\text{中}");
  });

  it("extends one \\text run across consecutive keystrokes", () => {
    const session = startSession();
    session.type("中");
    session.type("文");
    expect(session.source()).toBe("\\text{中文}");
    expect(session.textNodeCount()).toBe(1);
  });

  it("keeps Arabic letters in one run so they can shape joined", () => {
    const session = startSession();
    session.type("ب");
    session.type("ا");
    expect(session.source()).toBe("\\text{با}");
    expect(session.textNodeCount()).toBe(1);
  });

  it("commits a multi-character IME commit as one run", () => {
    const session = startSession();
    session.type("中文字");
    expect(session.source()).toBe("\\text{中文字}");
    expect(session.textNodeCount()).toBe(1);
  });

  it("returns renderable input to the plain math path after a run", () => {
    const session = startSession();
    session.type("中");
    session.type("x");
    expect(session.source()).toBe("\\text{中}x");
  });

  it("replaces a selection with the prose run", () => {
    const session = startSession();
    session.type("xy");
    const all = session.selectAll();
    const result = applyMathTreeInputToDocument(
      session.document,
      session.caret,
      all,
      "中",
      session.identities,
      () => undefined,
    );
    session.commit(result);
    expect(session.source()).toBe("\\text{中}");
  });
});

describe("deleting inside a prose run", () => {
  it("backspace peels the run one character at a time", () => {
    const session = startSession();
    session.type("中文");
    session.commit(backspaceMathTree(session.document, session.caret));
    expect(session.source()).toBe("\\text{中}");
    session.commit(backspaceMathTree(session.document, session.caret));
    expect(session.source()).toBe("");
  });

  it("continues the same run when typing after a backspace peel", () => {
    const session = startSession();
    session.type("中文");
    session.commit(backspaceMathTree(session.document, session.caret));
    session.type("字");
    expect(session.source()).toBe("\\text{中字}");
    expect(session.textNodeCount()).toBe(1);
  });

  it("forward delete peels the run from its start", () => {
    const session = startSession();
    session.type("中文");
    const before: MathTreeCaret = {
      kind: "row",
      rowId: session.rowId,
      afterNodeId: null,
    };
    session.commit(deleteForwardMathTree(session.document, before), before);
    expect(session.source()).toBe("\\text{文}");
    session.commit(
      deleteForwardMathTree(session.document, session.caret),
      session.caret,
    );
    expect(session.source()).toBe("");
  });
});

describe("caret movement through a prose run", () => {
  it("arrow-left walks the run per character instead of hopping it whole", () => {
    const session = startSession();
    session.type("中文");
    const chars = proseChars(session);
    const node = proseNode(session);

    // Gap after the run → after 中 → run start; the next press is the
    // formula's outer edge, which the host exit bridges own.
    session.commit(
      moveMathTreeCaret(session.document, session.caret, "arrow-left"),
    );
    expect(session.caret).toEqual({
      kind: "text",
      rowId: session.rowId,
      nodeId: node.id,
      field: "text",
      afterCharId: chars[0].id,
    });
    session.commit(
      moveMathTreeCaret(session.document, session.caret, "arrow-left"),
    );
    expect(session.caret).toMatchObject({ kind: "text", afterCharId: null });
    expect(
      moveMathTreeCaret(session.document, session.caret, "arrow-left").handled,
    ).toBe(false);
  });

  it("arrow-right enters the run at its first character", () => {
    const session = startSession();
    session.type("中文");
    const chars = proseChars(session);
    const node = proseNode(session);

    session.caret = { kind: "row", rowId: session.rowId, afterNodeId: null };
    session.commit(
      moveMathTreeCaret(session.document, session.caret, "arrow-right"),
    );
    expect(session.caret).toEqual({
      kind: "text",
      rowId: session.rowId,
      nodeId: node.id,
      field: "text",
      afterCharId: chars[0].id,
    });
    session.commit(
      moveMathTreeCaret(session.document, session.caret, "arrow-right"),
    );
    expect(session.caret).toMatchObject({
      kind: "text",
      afterCharId: chars[1].id,
    });
    expect(
      moveMathTreeCaret(session.document, session.caret, "arrow-right").handled,
    ).toBe(false);
  });
});

describe("editing at a caret inside a prose run", () => {
  it("splices typed prose at the caret position", () => {
    const session = startSession();
    session.type("中文");
    const chars = proseChars(session);
    session.caret = textCaretAfter(session, chars[0].id);
    session.type("字");
    expect(session.source()).toBe("\\text{中字文}");
    expect(session.textNodeCount()).toBe(1);
  });

  it("keeps renderable characters typed mid-run as literal prose", () => {
    const session = startSession();
    session.type("中文");
    const chars = proseChars(session);
    session.caret = textCaretAfter(session, chars[0].id);
    session.type("x");
    expect(session.source()).toBe("\\text{中x文}");
    expect(session.textNodeCount()).toBe(1);
  });

  it("backspace inside the run deletes the character before the caret", () => {
    const session = startSession();
    session.type("中文字");
    const chars = proseChars(session);
    session.caret = textCaretAfter(session, chars[1].id);
    session.commit(backspaceMathTree(session.document, session.caret));
    expect(session.source()).toBe("\\text{中字}");
    expect(session.caret).toMatchObject({
      kind: "text",
      afterCharId: chars[0].id,
    });
  });

  it("deletes a partial in-run selection character by character", () => {
    const session = startSession();
    session.type("中文字");
    const chars = proseChars(session);
    session.commit(
      deleteMathTreeRange(session.document, {
        anchor: textCaretAfter(session, chars[0].id),
        focus: textCaretAfter(session, chars[2].id),
      }),
    );
    expect(session.source()).toBe("\\text{中}");
  });

  it("replaces a partial in-run selection with typed prose", () => {
    const session = startSession();
    session.type("中文字");
    const chars = proseChars(session);
    const result = applyMathTreeInputToDocument(
      session.document,
      session.caret,
      {
        anchor: textCaretAfter(session, null),
        focus: textCaretAfter(session, chars[1].id),
      },
      "本",
      session.identities,
      () => undefined,
    );
    session.commit(result);
    expect(session.source()).toBe("\\text{本字}");
  });
});

interface ProseSession {
  document: StructuredDocument;
  caret: MathTreeCaret;
  readonly rowId: string;
  readonly identities: ReturnType<typeof createDeterministicIdentityAllocator>;
  type(input: string): void;
  commit(result: MathTreeEditResult, fallbackCaret?: MathTreeCaret): void;
  source(): string;
  textNodeCount(): number;
  selectAll(): { anchor: MathTreeCaret; focus: MathTreeCaret };
}

function proseNode(session: ProseSession) {
  const node = getStructuredChildren(
    session.document,
    session.rowId,
    "children",
  ).find((child) => child.type === "text");
  if (!node) throw new Error("expected one prose text node");
  return node;
}

function proseChars(session: ProseSession) {
  return [...iterateAllChars([...(proseNode(session).textFields.text ?? [])])]
    .filter((entry) => !entry.deleted)
    .map(({ id, char }) => ({ id, char }));
}

function textCaretAfter(
  session: ProseSession,
  afterCharId: string | null,
): MathTreeCaret {
  return {
    kind: "text",
    rowId: session.rowId,
    nodeId: proseNode(session).id,
    field: "text",
    afterCharId,
  };
}

function startSession(): ProseSession {
  const document = mathDocumentToStructured(
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
  const rowId = getStructuredChildren(document, document.rootId, "body")[0].id;
  const identities = createDeterministicIdentityAllocator("typed", 500);

  const session: ProseSession = {
    document,
    caret: { kind: "row", rowId, afterNodeId: null },
    rowId,
    identities,
    type(input) {
      const result = applyMathTreeInputToDocument(
        session.document,
        session.caret,
        undefined,
        input,
        identities,
        () => undefined,
      );
      session.commit(result);
    },
    commit(result, fallbackCaret) {
      if (!result.handled) {
        throw new Error(`edit not handled: ${result.reason}`);
      }
      session.document = applyStructuredEdits(session.document, result.edits);
      session.caret = result.caret ?? fallbackCaret ?? session.caret;
    },
    source() {
      const math = structuredToMathDocument(session.document);
      if (!math) throw new Error("expected a valid math document");
      return printMathDocument(math);
    },
    textNodeCount() {
      return getStructuredChildren(
        session.document,
        session.rowId,
        "children",
      ).filter((node) => node.type === "text").length;
    },
    selectAll() {
      return {
        anchor: { kind: "row", rowId: session.rowId, afterNodeId: null },
        focus: session.caret,
      };
    },
  };
  return session;
}
