import type { MarkSpan } from "../serlization/loadPage";
import { createDeterministicIdentityAllocator } from "../sync/id";
import {
  applyStructuredEdit,
  applyStructuredMutation,
  structuredContentId,
} from "../sync/structured-content";
import {
  createStructuredMathMarkAttachment,
  type InlineMathHostBlock,
  planInlineMathMigration,
  resolveStructuredInlineMathRuns,
} from "./inline-structured";
import { parseLegacyMathDocumentInit } from "./structured";
import { describe, expect, it } from "vitest";

function span(
  start: string,
  end: string,
  attrs?: Record<string, unknown>,
): MarkSpan {
  return {
    startCharId: start,
    endCharId: end,
    format: { type: "math", ...(attrs ? { attrs } : {}) },
    clock: { peerId: "parser", counter: 0 },
  };
}

function importedBlock(): InlineMathHostBlock {
  return {
    id: "block:9",
    charRuns: [{ peerId: "parser", startCounter: 0, text: "x+y" }],
    formats: [span("parser:0", "parser:0"), span("parser:2", "parser:2")],
  };
}

describe("structured inline math attachments", () => {
  it("allocates new marks and their tree from one generic identity source", () => {
    const created = createStructuredMathMarkAttachment(
      "\\frac{a}{b}",
      createDeterministicIdentityAllocator("author"),
    );

    expect(created.contentId).toBe("author:0");
    expect(created.format).toEqual({
      type: "math",
      attrs: { contentId: "author:0" },
    });
    expect(created.init.document.rootId).toBe("author:0");
    expect(created.init.document.authority).toBeUndefined();
    expect(
      Object.keys(created.init.document.nodes).some((id) =>
        id.startsWith("author:"),
      ),
    ).toBe(true);
  });

  it("does not alias imported marks that share parser:0 clocks", () => {
    const block = importedBlock();
    const runs = resolveStructuredInlineMathRuns(block);
    const first = planInlineMathMigration(block, runs[0]);
    const second = planInlineMathMigration(block, runs[1]);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.contentId).not.toBe(second.contentId);
    expect(first.contentId).toBe(
      structuredContentId(block.id, "mark/math/parser:0/parser:0"),
    );
    expect(second.contentId).toBe(
      structuredContentId(block.id, "mark/math/parser:0/parser:2"),
    );
  });

  it("builds byte-identical lazy migration trees on different peers", () => {
    const leftBlock = importedBlock();
    const rightBlock = structuredClone(leftBlock);
    const left = planInlineMathMigration(
      leftBlock,
      resolveStructuredInlineMathRuns(leftBlock)[0],
    );
    const right = planInlineMathMigration(
      rightBlock,
      resolveStructuredInlineMathRuns(rightBlock)[0],
    );

    expect(left.ok).toBe(true);
    expect(right.ok).toBe(true);
    if (!left.ok || !right.ok) return;
    expect(left.contentId).toBe(right.contentId);
    expect(left.init?.document).toEqual(right.init?.document);
    expect(left.init?.document.authority).toBeUndefined();
    expect(left.format.attrs?.contentId).toBe(left.contentId);
  });

  it("degrades a divergent-source migration race to one dropped edit", () => {
    // Peer A migrates the pristine import; peer B migrates after an editor
    // without the tree rule inserted "c" into the same run. Their initializers
    // race on one derived address.
    const span9 = span("parser:0", "parser:2");
    const blockA: InlineMathHostBlock = {
      id: "block:9",
      charRuns: [{ peerId: "parser", startCounter: 0, text: "a+b" }],
      formats: [span9],
    };
    const blockB: InlineMathHostBlock = {
      ...blockA,
      charRuns: [
        { peerId: "parser", startCounter: 0, text: "a+" },
        { peerId: "old", startCounter: 0, text: "c" },
        { peerId: "parser", startCounter: 2, text: "b" },
      ],
    };
    const planA = planInlineMathMigration(
      blockA,
      resolveStructuredInlineMathRuns(blockA)[0],
    );
    const planB = planInlineMathMigration(
      blockB,
      resolveStructuredInlineMathRuns(blockB)[0],
    );
    expect(planA.ok && planB.ok).toBe(true);
    if (!planA.ok || !planB.ok) return;
    expect(planA.contentId).toBe(planB.contentId);

    // Canonical replay: A's init wins, B's init is a no-op.
    const contentId = planA.contentId;
    const winner = applyStructuredMutation(undefined, contentId, planA.init!);
    expect(winner).toBeDefined();
    const merged = applyStructuredMutation(winner, contentId, planB.init!);
    expect(merged).toBe(winner);

    // B's piggybacked edit targets its own parse of "a+cb"; on the winning
    // tree that parent is absent, so the node lands as an invisible orphan.
    const loserRowId = Object.values(planB.document.nodes).find(
      (node) => node.placement.parentId === contentId,
    )!.id;
    expect(planA.document.nodes[loserRowId]).toBeUndefined();
    const edited = applyStructuredEdit(merged!, {
      kind: "node_insert",
      node: {
        id: "live:9",
        type: "symbol",
        placement: { parentId: loserRowId, slot: "children", orderKey: "zz" },
        attrs: { symbolClass: "mathord", commandPresent: false },
        textFields: {
          value: [{ peerId: "live", startCounter: 10, text: "q" }],
        },
      },
    });
    expect(edited.nodes["live:9"]).toBeDefined();

    const converged: InlineMathHostBlock = {
      ...blockA,
      formats: [
        span("parser:0", "parser:2", { contentId }),
      ],
      structuredContent: { [contentId]: edited },
    };
    const run = resolveStructuredInlineMathRuns(converged)[0];
    expect(run.attachmentConflict).toBe(false);
    expect(run.latex).toBe("a+b");
  });

  it("uses the tree as source while retaining stale compatibility characters", () => {
    const created = createStructuredMathMarkAttachment(
      "\\frac{a}{b}",
      createDeterministicIdentityAllocator("tree"),
    );
    const block: InlineMathHostBlock = {
      id: "block:1",
      charRuns: [{ peerId: "legacy", startCounter: 0, text: "stale" }],
      formats: [
        span("legacy:0", "legacy:4", {
          contentId: created.contentId,
        }),
      ],
      structuredContent: {
        [created.contentId]: created.init.document,
      },
    };

    const run = resolveStructuredInlineMathRuns(block)[0];
    expect(run.compatibilityLatex).toBe("stale");
    expect(run.latex).toBe("\\frac{a}{b}");
    const plan = planInlineMathMigration(block, run);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.init).toBeUndefined();
    expect(plan.needsMarkUpdate).toBe(false);
  });

  it("rejects a referenced attachment that claims block authority", () => {
    const contentId = "author:4";
    const authoritative = parseLegacyMathDocumentInit("x", { contentId });
    const block: InlineMathHostBlock = {
      id: "block:1",
      charRuns: [{ peerId: "legacy", startCounter: 0, text: "x" }],
      formats: [span("legacy:0", "legacy:0", { contentId })],
      structuredContent: { [contentId]: authoritative.document },
    };

    const plan = planInlineMathMigration(
      block,
      resolveStructuredInlineMathRuns(block)[0],
    );
    expect(plan).toEqual({ ok: false, reason: "conflicting-attachment" });
  });
});
