import { createFeatureMarkInRange } from "../actions/structured-marks";
import { resolveMarkRuns } from "../inline-math-spans";
import { mathExtension } from "../math-extension";
import { baseSchema } from "../schema";
import type { Block } from "../serlization/loadPage";
import { loadPage } from "../serlization/loadPage";
import { iterateAllChars, iterateVisibleChars } from "../sync/char-runs";
import { applyOps, rebuildState } from "../sync/reducer";
import { blocksToOps, generateRestoreOperations } from "../sync/snapshot-diff";
import { createCRDTbinding } from "../sync/sync";
import { getStructuredMathMarkSource } from "./inline-structured";
import {
  getMathStructuredDocument,
  getStructuredMathSource,
  mathContentIdForBlock,
  parseLegacyMathDocumentInit,
  structuredToMathDocument,
  validateStructuredMathDocument,
} from "./structured";
import { printMathDocument } from "@cypherkit/tex/data";
import { describe, expect, it } from "vitest";

const schema = baseSchema.use(mathExtension({ displayEditing: "tree" }));
const LATEX = String.raw`\frac{a}{b}+\sqrt{x}`;

function treeBlock() {
  const page = loadPage(`$$\n${LATEX}\n$$`, schema.data);
  const block = page.blocks[0];
  const contentId = mathContentIdForBlock(block.id);
  const identities = createCRDTbinding(page.id, "tree-snapshot-source");
  const init = parseLegacyMathDocumentInit(LATEX, {
    contentId,
    identityAllocator: identities,
  });
  return {
    ...block,
    // A migrated display equation intentionally has no visible compatibility
    // source. Losing/re-addressing the attachment incorrectly therefore cannot
    // be hidden by a flat-text fallback in these tests.
    charRuns: [],
    structuredContent: { [contentId]: init.document },
  };
}

function opsContext(pageId: string, peerId: string) {
  const binding = createCRDTbinding(pageId, peerId);
  return {
    pageId,
    peerId,
    nextId: binding.nextId,
    getClock: binding.getClock,
    schema: schema.data,
  };
}

function inlineTreeBlock(): Block {
  const page = loadPage("xyxy", schema.data);
  const binding = createCRDTbinding(page.id, "inline-snapshot-source");
  const created = createFeatureMarkInRange(
    page,
    page.blocks[0].id,
    0,
    2,
    { type: "math" },
    binding,
    schema.data,
  );
  const block = created.newPage.blocks[0];
  if (!("charRuns" in block) || !("formats" in block)) {
    throw new Error("expected a textual inline host");
  }
  const chars = [...iterateVisibleChars(block.charRuns)];
  const span = block.formats[0];
  if (!span || chars.length !== 4) throw new Error("expected one math span");
  return {
    ...block,
    formats: [
      span,
      {
        ...span,
        startCharId: chars[2].id,
        endCharId: chars[3].id,
        clock: { ...span.clock, counter: span.clock.counter + 1 },
      },
    ],
  };
}

function structuredIdentities(
  document: NonNullable<Block["structuredContent"]>[string],
): Set<string> {
  const ids = new Set(Object.keys(document.nodes));
  for (const node of Object.values(document.nodes)) {
    for (const runs of Object.values(node.textFields)) {
      for (const char of iterateAllChars([...runs])) ids.add(char.id);
    }
  }
  return ids;
}

describe("structured display math snapshot cloning", () => {
  it("rekeys a tree attachment on import and survives canonical replay", () => {
    const source = treeBlock();
    const ops = blocksToOps(
      [source],
      opsContext("math-import-target", "math-import"),
    );
    const rebuilt = rebuildState("math-import-target", ops, schema.data);
    const replayed = rebuildState(
      "math-import-target",
      [...ops].reverse(),
      schema.data,
    );

    expect(replayed).toEqual(rebuilt);
    const restored = rebuilt.blocks[0];
    expect(restored.id).not.toBe(source.id);
    const contentId = mathContentIdForBlock(restored.id);
    expect(Object.keys(restored.structuredContent ?? {})).toEqual([contentId]);
    expect(getStructuredMathSource(restored)).toBe(LATEX);
    expect(
      validateStructuredMathDocument(getMathStructuredDocument(restored)!),
    ).toBeDefined();
  });

  it("keeps the equation authoritative through snapshot restore", () => {
    const current = loadPage("replace me", schema.data);
    const source = treeBlock();
    const ops = generateRestoreOperations({
      ...opsContext(current.id, "math-restore"),
      currentBlocks: current.blocks,
      newBlocks: [source],
    });
    const restored = applyOps(current, ops, schema.data);
    const visible = restored.blocks.filter((block) => !block.deleted);

    expect(visible).toHaveLength(1);
    expect(visible[0].id).not.toBe(source.id);
    expect(getStructuredMathSource(visible[0])).toBe(LATEX);
    expect(getMathStructuredDocument(visible[0])).toBeDefined();
  });

  it("rekeys one supplemental tree once and rewrites every covering mark", () => {
    const source = inlineTreeBlock();
    const sourceRuns = resolveMarkRuns(source);
    const sourceContentId = sourceRuns[0]?.attrs.contentId as string;
    const sourceDocument = source.structuredContent?.[sourceContentId];
    expect(sourceRuns).toHaveLength(2);
    expect(sourceRuns[1]?.attrs.contentId).toBe(sourceContentId);
    expect(sourceDocument).toBeDefined();

    const ops = blocksToOps(
      [source],
      opsContext("inline-import-target", "inline-import"),
    );
    const rebuilt = rebuildState("inline-import-target", ops, schema.data);
    const replayed = rebuildState(
      "inline-import-target",
      [...ops].reverse(),
      schema.data,
    );
    expect(replayed).toEqual(rebuilt);

    const restored = rebuilt.blocks[0];
    const runs = resolveMarkRuns(restored);
    const contentIds = runs.map((run) => run.attrs.contentId as string);
    expect(runs).toHaveLength(2);
    expect(new Set(contentIds).size).toBe(1);
    expect(contentIds[0]).not.toBe(sourceContentId);
    expect(Object.keys(restored.structuredContent ?? {})).toEqual([
      contentIds[0],
    ]);
    const document = restored.structuredContent?.[contentIds[0]];
    expect(document).toBeDefined();
    expect(
      getStructuredMathMarkSource(
        { type: "math", attrs: runs[0].attrs },
        restored.structuredContent,
      ),
    ).toBe("xy");

    const sourceIds = structuredIdentities(sourceDocument!);
    const clonedIds = structuredIdentities(document!);
    expect([...clonedIds].some((id) => sourceIds.has(id))).toBe(false);
  });

  it("keeps a supplemental mark authoritative through snapshot restore", () => {
    const current = loadPage("replace me", schema.data);
    const source = inlineTreeBlock();
    const ops = generateRestoreOperations({
      ...opsContext(current.id, "inline-restore"),
      currentBlocks: current.blocks,
      newBlocks: [source],
    });
    const restored = applyOps(current, ops, schema.data);
    const block = restored.blocks.find((candidate) => !candidate.deleted)!;
    const run = resolveMarkRuns(block)[0];
    const contentId = run.attrs.contentId as string;
    const document = block.structuredContent?.[contentId];
    const math = document ? structuredToMathDocument(document) : undefined;

    expect(contentId).toBeTruthy();
    expect(document?.rootId).toBe(contentId);
    expect(math ? printMathDocument(math) : undefined).toBe("xy");
  });
});
