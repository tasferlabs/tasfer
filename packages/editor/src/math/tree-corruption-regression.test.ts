import { insertText } from "../actions/actions";
import { DELETE_BACKWARD, DELETE_FORWARD } from "../actions/edit-actions";
import { mathExtension } from "../math-extension";
import { MATH_COMMANDS } from "../nodes/math-commands";
import { INSERT_MATH_COMMAND } from "../nodes/MathNode";
import { createMarkRegistry } from "../rendering/marks";
import { createNodeRegistry } from "../rendering/nodes";
import { baseSchema } from "../schema";
import { moveCursorToPosition, updateSelection } from "../selection";
import { loadPage } from "../serlization/loadPage";
import type { EditorState } from "../state-types";
import { createInitialState } from "../state-utils";
import { getStructuredText } from "../sync/structured-content";
import { createCRDTbinding } from "../sync/sync";
import {
  getMathStructuredDocument,
  getStructuredMathSource,
  validateStructuredMathDocument,
} from "./structured";
import { isValidLatex } from "@cypherkit/tex";
import { describe, expect, it } from "vitest";

const schema = baseSchema.use(mathExtension({ displayEditing: "tree" }));

function legacyEquation(latex: string): EditorState {
  const binding = createCRDTbinding("tree-corruption", "local");
  return createInitialState(loadPage(`$$\n${latex}\n$$`, schema.data), {
    schema: schema.data,
    nodes: createNodeRegistry(schema.nodes),
    marks: createMarkRegistry(schema.marks),
    crdtBinding: binding,
  });
}

function source(state: EditorState): string {
  const block = state.document.page.blocks[0];
  const structured = getStructuredMathSource(block);
  if (structured !== undefined) return structured;
  return "charRuns" in block
    ? block.charRuns.map((run) => run.text).join("")
    : "";
}

describe("tree math never edits LaTeX syntax as flat characters", () => {
  it("migrates before Backspace inside a legacy command token", () => {
    let state = legacyEquation(String.raw`\frac{a}{b}`);
    // A flat source caret in the middle of `frac` used to delete one command
    // letter and leave `\fac{a}{b}` behind.
    state = moveCursorToPosition(state, 0, 4);

    const deleted = state.actionBus.dispatchState(DELETE_BACKWARD, state);
    const block = deleted.state.document.page.blocks[0];

    expect(getMathStructuredDocument(block)).toBeDefined();
    expect(isValidLatex(source(deleted.state))).toBe(true);
    expect(source(deleted.state)).not.toContain(String.raw`\fac`);
  });

  it("never applies a partial legacy selection to command characters", () => {
    let state = legacyEquation(String.raw`\sqrt{x}+1`);
    state = moveCursorToPosition(state, 0, 4);
    state = updateSelection(state, {
      anchor: { blockIndex: 0, textIndex: 1 },
      focus: { blockIndex: 0, textIndex: 4 },
    });

    const deleted = state.actionBus.dispatchState(DELETE_BACKWARD, state);

    expect(
      getMathStructuredDocument(deleted.state.document.page.blocks[0]),
    ).toBeDefined();
    expect(isValidLatex(source(deleted.state))).toBe(true);
  });

  it("commits command-menu constructs as semantic nodes, not raw source", () => {
    let state = legacyEquation("");
    state = moveCursorToPosition(state, 0, 0);
    state = insertText(state, "x").state;

    const inserted = state.actionBus.dispatchState(INSERT_MATH_COMMAND, state, {
      text: String.raw`\sqrt{}`,
      caretOffset: 6,
    });
    const document = getMathStructuredDocument(
      inserted.state.document.page.blocks[0],
    );
    if (!document) throw new Error("expected a structured equation");

    expect(
      Object.values(document.nodes).some((node) => node.type === "radical"),
    ).toBe(true);
    for (const node of Object.values(document.nodes)) {
      if (node.type !== "raw-text") continue;
      expect(getStructuredText(document, node.id, "text")).not.toContain(
        String.raw`\sqrt`,
      );
    }
    expect(isValidLatex(source(inserted.state))).toBe(true);
  });

  it("keeps every command-catalog construct structurally valid across deletion", () => {
    for (const command of MATH_COMMANDS) {
      let state = legacyEquation("");
      state = moveCursorToPosition(state, 0, 0);

      const inserted = state.actionBus.dispatchState(
        INSERT_MATH_COMMAND,
        state,
        {
          text: command.latex,
          caretOffset: command.latex.length,
        },
      );
      const insertedDocument = getMathStructuredDocument(
        inserted.state.document.page.blocks[0],
      );

      expect(insertedDocument, command.id).toBeDefined();
      expect(
        insertedDocument && validateStructuredMathDocument(insertedDocument),
        command.id,
      ).toBeDefined();
      expect(isValidLatex(source(inserted.state)), command.id).toBe(true);

      const backward = inserted.state.actionBus.dispatchState(
        DELETE_BACKWARD,
        inserted.state,
      );
      const backwardDocument = getMathStructuredDocument(
        backward.state.document.page.blocks[0],
      );
      expect(
        backwardDocument && validateStructuredMathDocument(backwardDocument),
        `${command.id}:backward`,
      ).toBeDefined();
      expect(
        isValidLatex(source(backward.state)),
        `${command.id}:backward`,
      ).toBe(true);

      const forward = inserted.state.actionBus.dispatchState(
        DELETE_FORWARD,
        inserted.state,
      );
      const forwardDocument = getMathStructuredDocument(
        forward.state.document.page.blocks[0],
      );
      expect(
        forwardDocument && validateStructuredMathDocument(forwardDocument),
        `${command.id}:forward`,
      ).toBeDefined();
      expect(isValidLatex(source(forward.state)), `${command.id}:forward`).toBe(
        true,
      );
    }
  });
});
