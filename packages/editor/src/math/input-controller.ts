/** Shared pure correctness boundary for display and inline math-tree input. */

import { iterateAllChars } from "../sync/char-runs";
import type { IdentityAllocator } from "../sync/id";
import {
  applyStructuredEdits,
  type StructuredDocument,
} from "../sync/structured-content";
import {
  backspaceMathTree,
  deleteForwardMathTree,
  deleteMathTreeRange,
  expandMathTreeRangeToAtomicCommands,
  getMathTreeMatrixContext,
  insertMathSemanticLatex,
  insertMathTextWithCompletion,
  type MathCommandCompletionResolver,
  type MathTreeCaret,
  type MathTreeEditResult,
  type MathTreeRange,
  replaceMathTreeRange,
  replaceMathTreeRangeWithSemanticLatex,
} from "./tree-edit";
import { isValidLatex } from "@cypherkit/tex";
import { parseMathDocument, printMathDocument } from "@cypherkit/tex/data";

/** Insert/replace input without exposing syntax-bearing punctuation as text. */
export function applyMathTreeInputToDocument(
  document: StructuredDocument,
  caret: MathTreeCaret,
  range: MathTreeRange | undefined,
  input: string,
  identities: IdentityAllocator,
  resolveCommand: MathCommandCompletionResolver,
): MathTreeEditResult {
  const boundary = range
    ? undefined
    : commitCommandBoundary(document, caret, input, identities, resolveCommand);
  if (boundary) return boundary;

  const semantic = committedSemanticInput(input);
  const safeRange = range
    ? expandMathTreeRangeToAtomicCommands(document, range, resolveCommand)
    : undefined;
  return safeRange
    ? semantic
      ? replaceMathTreeRangeWithSemanticLatex(
          document,
          safeRange,
          semantic.latex,
          identities,
          semantic.forceAtomic
            ? { caret: semantic.caret, forceAtomic: true }
            : { caret: semantic.caret },
        )
      : replaceMathTreeRange(document, safeRange, input, identities)
    : semantic
      ? insertMathSemanticLatex(
          document,
          caret,
          semantic.latex,
          identities,
          semantic.forceAtomic
            ? { caret: semantic.caret, forceAtomic: true }
            : { caret: semantic.caret },
        )
      : insertMathTextWithCompletion(
          document,
          caret,
          input,
          identities,
          resolveCommand,
        );
}

/** Commit a sequential escape/unknown command before its non-letter boundary. */
function commitCommandBoundary(
  document: StructuredDocument,
  caret: MathTreeCaret,
  input: string,
  identities: IdentityAllocator,
  resolveCommand: MathCommandCompletionResolver,
): MathTreeEditResult | undefined {
  if (caret.kind !== "text" || Array.from(input).length !== 1) return undefined;
  const node = document.nodes[caret.nodeId];
  if (!node || node.deleted || node.type !== "raw-text") return undefined;
  const characters = [...iterateAllChars([...(node.textFields.text ?? [])])]
    .filter((entry) => !entry.deleted)
    .map(({ id, char }) => ({ id, char }));
  const position = caret.afterCharId
    ? characters.findIndex(({ id }) => id === caret.afterCharId) + 1
    : 0;
  if (caret.afterCharId && position === 0) return undefined;
  const prefix = characters
    .slice(0, position)
    .map(({ char }) => char)
    .join("");
  const match = prefix.match(/\\([A-Za-z]*)$/);
  if (!match || match.index === undefined) return undefined;
  const command = match[1];
  const range: MathTreeRange = {
    anchor: {
      ...caret,
      afterCharId: characters[match.index - 1]?.id ?? null,
    },
    focus: caret,
  };

  if (command.length === 0 && /^[{}&^_%#$]$/.test(input)) {
    return replaceMathTreeRangeWithSemanticLatex(
      document,
      range,
      `\\${input}`,
      identities,
      { caret: "end" },
    );
  }
  if (command.length === 0 && input === " ") {
    // `\␣` is LaTeX's control space. Commit it as one atomic node: leaving the
    // literal `\` and ` ` characters in the text leaf would expose a caret
    // position inside the command and let later edits split it apart.
    return replaceMathTreeRangeWithSemanticLatex(
      document,
      range,
      "\\ ",
      identities,
      { caret: "end", forceAtomic: true },
    );
  }
  if (command.length === 0 && input === "\\") {
    // Matrix topology belongs to identity-bearing matrix-row/matrix-cell nodes,
    // never to text typed in a cell body. Complete the pending backslash as a
    // semantic glyph node inside that same cell; an atomic raw `\\` fragment
    // would project as LaTeX's row separator and make content look structural.
    if (getMathTreeMatrixContext(document, caret)) {
      return replaceMathTreeRangeWithSemanticLatex(
        document,
        range,
        String.raw`\backslash`,
        identities,
        { caret: "end" },
      );
    }
    return replaceMathTreeRangeWithSemanticLatex(
      document,
      range,
      String.raw`\\`,
      identities,
      { caret: "end", forceAtomic: true },
    );
  }
  if (
    command.length === 0 ||
    /^[A-Za-z]$/.test(input) ||
    resolveCommand(command, input)
  ) {
    return undefined;
  }

  const atomic = replaceMathTreeRangeWithSemanticLatex(
    document,
    range,
    match[0],
    identities,
    { caret: "end", forceAtomic: true },
  );
  if (!atomic.handled) return atomic;
  const afterAtomic = applyStructuredEdits(document, atomic.edits);
  const following = applyMathTreeInputToDocument(
    afterAtomic,
    atomic.caret,
    undefined,
    input,
    identities,
    resolveCommand,
  );
  if (!following.handled) return { ...following, caret };
  return {
    ...following,
    edits: [...atomic.edits, ...following.edits],
  };
}

/** Delete a range/unit while preserving atomic command boundaries. */
export function deleteMathTreeInputFromDocument(
  document: StructuredDocument,
  caret: MathTreeCaret,
  range: MathTreeRange | undefined,
  direction: "backward" | "forward",
  resolveCommand: MathCommandCompletionResolver,
): MathTreeEditResult {
  const safeRange = range
    ? expandMathTreeRangeToAtomicCommands(document, range, resolveCommand)
    : undefined;
  return safeRange
    ? deleteMathTreeRange(document, safeRange)
    : direction === "forward"
      ? deleteForwardMathTree(document, caret, resolveCommand)
      : backspaceMathTree(document, caret, resolveCommand);
}

/** Insert a command-menu choice, replacing the active/trailing command run. */
export function applyMathTreeCommandToDocument(
  document: StructuredDocument,
  caret: MathTreeCaret,
  range: MathTreeRange | undefined,
  text: string,
  identities: IdentityAllocator,
  resolveCommand: MathCommandCompletionResolver,
): MathTreeEditResult {
  const safeRange = range
    ? expandMathTreeRangeToAtomicCommands(document, range, resolveCommand)
    : trailingMathCommandRange(document, caret);
  return safeRange
    ? replaceMathTreeRangeWithSemanticLatex(
        document,
        safeRange,
        text,
        identities,
      )
    : insertMathSemanticLatex(document, caret, text, identities);
}

/** Exact `\\query` text range immediately preceding one raw-text caret. */
export function trailingMathCommandRange(
  document: StructuredDocument,
  caret: MathTreeCaret,
): MathTreeRange | undefined {
  if (caret.kind !== "text") return undefined;
  const node = document.nodes[caret.nodeId];
  if (!node || node.deleted || node.type !== "raw-text") return undefined;
  const characters = [...iterateAllChars([...(node.textFields.text ?? [])])]
    .filter((entry) => !entry.deleted)
    .map((entry) => ({ id: entry.id, char: entry.char }));
  const anchorIndex = caret.afterCharId
    ? characters.findIndex((entry) => entry.id === caret.afterCharId)
    : -1;
  if (caret.afterCharId && anchorIndex < 0) return undefined;
  const position = anchorIndex + 1;
  const match = characters
    .slice(0, position)
    .map((entry) => entry.char)
    .join("")
    .match(/\\[A-Za-z]*$/);
  if (!match || match.index === undefined) return undefined;
  return {
    anchor: {
      ...caret,
      afterCharId: characters[match.index - 1]?.id ?? null,
    },
    focus: caret,
  };
}

function committedSemanticInput(input: string): {
  readonly latex: string;
  readonly caret: "first-slot" | "end";
  readonly forceAtomic?: boolean;
} | null {
  switch (input) {
    case "^":
      return { latex: "^{}", caret: "first-slot" };
    case "_":
      return { latex: "_{}", caret: "first-slot" };
    case "{":
      return { latex: String.raw`\{`, caret: "end" };
    case "}":
      return { latex: String.raw`\}`, caret: "end" };
    case "&":
      return { latex: String.raw`\&`, caret: "end" };
  }
  if (input.length <= 1 || !/[\\{}^_&]/.test(input)) return null;
  try {
    const parsed = parseMathDocument(input);
    const hasSemanticNode = parsed.root.body.children.some(
      (node) => node.type !== "raw-text",
    );
    const printed = printMathDocument(parsed);
    return {
      latex: input,
      caret: "end",
      ...(!isValidLatex(input) || !hasSemanticNode || printed !== input
        ? { forceAtomic: true }
        : {}),
    };
  } catch {
    return { latex: input, caret: "end", forceAtomic: true };
  }
}
