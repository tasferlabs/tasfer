/**
 * Typing `\` then space in a structured math block commits LaTeX's control
 * space (`\ `) as one atomic node. Leaving the literal `\` and ` ` characters
 * in a raw-text leaf would expose a caret position inside the command, let
 * later edits split it apart, and break the invariant that no committed leaf
 * ever contains a backslash.
 */
import { insertText } from "../actions/actions";
import { mathExtension } from "../math-extension";
import { createMarkRegistry } from "../rendering/marks";
import { createNodeRegistry } from "../rendering/nodes";
import { baseSchema } from "../schema";
import { moveCursorToPosition } from "../selection";
import { loadPage } from "../serlization/loadPage";
import type { EditorState } from "../state-types";
import { createInitialState } from "../state-utils";
import { getVisibleTextFromRuns } from "../sync/char-runs";
import { createCRDTbinding } from "../sync/sync";
import {
  getMathStructuredDocument,
  getStructuredMathSource,
} from "./structured";
import { describe, expect, it } from "vitest";

const treeMathSchema = baseSchema.use(mathExtension());

function treeState(markdown: string): EditorState {
  return createInitialState(loadPage(markdown, treeMathSchema.data), {
    schema: treeMathSchema.data,
    nodes: createNodeRegistry(treeMathSchema.nodes),
    marks: createMarkRegistry(treeMathSchema.marks),
    crdtBinding: createCRDTbinding("default-page", "control-space-test"),
  });
}

function typeText(state: EditorState, text: string): EditorState {
  if (!state.document.cursor && !state.document.contentSelection) {
    state = moveCursorToPosition(state, 0, 0);
  }
  for (const char of text) {
    state = insertText(state, char).state;
  }
  return state;
}

function visibleNodes(state: EditorState) {
  const document = getMathStructuredDocument(state.document.page.blocks[0]);
  return Object.values(document?.nodes ?? {}).filter((node) => !node.deleted);
}

describe("control space entry in a structured math block", () => {
  it("commits backslash+space as one atomic control-space node", () => {
    const state = typeText(treeState("$$\n\n$$"), "\\ ");
    expect(getStructuredMathSource(state.document.page.blocks[0])).toBe("\\ ");
    const nodes = visibleNodes(state);
    expect(
      nodes.some(
        (node) =>
          node.type === "raw-latex" &&
          getVisibleTextFromRuns([...(node.textFields.latex ?? [])]) === "\\ ",
      ),
    ).toBe(true);
    // The committed leaf keeps no literal backslash or space characters.
    expect(
      nodes.some(
        (node) =>
          node.type === "raw-text" &&
          /[\\ ]/.test(
            getVisibleTextFromRuns([...(node.textFields.text ?? [])]),
          ),
      ),
    ).toBe(false);
  });

  it("keeps typing after the control space in a fresh leaf", () => {
    const state = typeText(treeState("$$\n\n$$"), "\\ x");
    expect(getStructuredMathSource(state.document.page.blocks[0])).toBe("\\ x");
  });
});
