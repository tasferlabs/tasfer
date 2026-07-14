/** Shared pure correctness boundary for display and inline math-tree input. */

import { iterateAllChars } from "../sync/char-runs";
import type { IdentityAllocator } from "../sync/id";
import {
  applyStructuredEdits,
  type StructuredDocument,
} from "../sync/structured-content";
import {
  backspaceMathTree,
  completeMathCommand,
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

  // A lone typed space never becomes tree content: math mode collapses
  // whitespace, so persisting it would only create dead source and a phantom
  // caret stop. It still acts as a gesture — completing a pending `\command`,
  // or deleting the selection it was typed over — and `\`+space stays the
  // atomic control space via the boundary above. Multi-character commits keep
  // spaces only when commands make them meaningful (see `text` below).
  if (input === " ") {
    if (range) {
      return deleteMathTreeRange(
        document,
        expandMathTreeRangeToAtomicCommands(document, range, resolveCommand),
      );
    }
    const completed = completeMathCommand(
      document,
      caret,
      identities,
      (command) => resolveCommand(command, " "),
    );
    return completed.handled ? completed : { handled: true, edits: [], caret };
  }

  const semantic = committedSemanticInput(input);
  // A multi-character commit (paste, IME) that carries no math syntax cannot
  // carry meaningful spaces either: with no command in the text, math mode
  // collapses every one, so persisting them would recreate the dead source the
  // single-space rule above prevents. Command-bearing commits take the
  // semantic path, which preserves required separators (`\sin x`).
  const text =
    semantic || Array.from(input).length <= 1
      ? input
      : input.replace(/\s+/gu, "");
  const safeRange = range
    ? expandMathTreeRangeToAtomicCommands(document, range, resolveCommand)
    : undefined;
  if (!semantic && text.length === 0) {
    // A whitespace-only commit degenerates to the space gesture: delete the
    // selection it was committed over, otherwise change nothing.
    return safeRange
      ? deleteMathTreeRange(document, safeRange)
      : { handled: true, edits: [], caret };
  }
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
      : replaceMathTreeRange(document, safeRange, text, identities)
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
          text,
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

/** The uncommitted `\`+letters command-entry run ending at a raw-text caret. */
export interface TrailingMathCommandRun {
  /** Letters typed after the `\` so far — empty right after the trigger. */
  readonly query: string;
  /** Stable identity of the run's opening `\` character. */
  readonly backslashCharId: string;
  /** Exact `\query` text range, for replacing the run on completion. */
  readonly range: MathTreeRange;
}

/**
 * Read the exact `\query` command-entry run ending at one raw-text caret.
 * Host chrome (the `\` autocomplete menu) must read the query from the field
 * content this way: the canonical source projection is not a faithful echo of
 * what was typed (a pending lone `\` projects as `\backslash`), so slicing
 * projected source around a bridged offset misreads the run.
 */
export function trailingMathCommandRun(
  document: StructuredDocument,
  caret: MathTreeCaret,
): TrailingMathCommandRun | undefined {
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
    .match(/\\([A-Za-z]*)$/);
  if (!match || match.index === undefined) return undefined;
  return {
    query: match[1],
    backslashCharId: characters[match.index].id,
    range: {
      anchor: {
        ...caret,
        afterCharId: characters[match.index - 1]?.id ?? null,
      },
      focus: caret,
    },
  };
}

/** Exact `\\query` text range immediately preceding one raw-text caret. */
export function trailingMathCommandRange(
  document: StructuredDocument,
  caret: MathTreeCaret,
): MathTreeRange | undefined {
  return trailingMathCommandRun(document, caret)?.range;
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
