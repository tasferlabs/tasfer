/**
 * Export (Markdown + HTML/PDF) must resolve an inline-math chip to the SAME
 * extent the canvas paints.
 *
 * The serializers group inline runs through `groupSegments`, which used to do a
 * strict `startCharId`/`endCharId` lookup over only the visible chars and drop a
 * whole mark span the moment either endpoint char was tombstoned (e.g.
 * backspacing a formula's first/last char during editing). The live canvas
 * resolves the same chip tolerantly (`resolveMarkRunsFromChars`), so it kept
 * painting the formula typeset while the exporter emitted the chip's LaTeX as
 * plain `$…$` source — raw LaTeX visible to the reader in the exported PDF,
 * violating the "a reader never sees raw math source" invariant. `groupSegments`
 * now shares the tolerant resolver, so export and render agree.
 */
import { serializeToHTML } from "./serlization/htmlSerializer";
import { serializeToMarkdown } from "./serlization/serializer";
import {
  deleteCharsInRange,
  insertCharsAtPosition,
  markCharsInRange,
} from "./sync/crdt-utils";
import { createCRDTbinding, createSyncEngine } from "./sync/sync";
import { describe, expect, it } from "vitest";

/** A paragraph "pre <math>latex</math> post" with the chip fully marked. */
function chipDoc(latex: string) {
  const binding = createCRDTbinding("ser-res", "peer-1");
  const engine = createSyncEngine(binding);
  const blockOp = engine.createBlockInsert(null, "paragraph", {});
  engine.emit([blockOp]);
  const blockId = blockOp.blockId;
  let page = engine.getState();
  const pre = "pre ";
  const post = " post";
  page = insertCharsAtPosition(
    page,
    blockId,
    0,
    pre + latex + post,
    binding,
  ).newPage;
  page = markCharsInRange(
    page,
    blockId,
    pre.length,
    pre.length + latex.length,
    { type: "math" },
    true,
    binding,
  ).newPage;
  return { page, blockId, binding, pre };
}

describe("inline-math export/render resolution agree", () => {
  it("a chip whose TRAILING anchor char is tombstoned still serializes as math", () => {
    const { page, blockId, binding, pre } = chipDoc("x^2");
    // Delete the formula's last char ('2') — the mark span's end anchor.
    const end = pre.length + 3;
    const { newPage } = deleteCharsInRange(
      page,
      blockId,
      end - 1,
      end,
      binding,
    );

    const md = serializeToMarkdown(newPage.blocks);
    const html = serializeToHTML(newPage.blocks, { title: "t" });

    // Markdown keeps the surviving formula in `$…$`, never as bare text.
    expect(md).toContain("$x^$");
    // HTML renders it as an SVG, not raw LaTeX exposed to the reader.
    expect(html).toContain("<svg");
    expect(html).not.toContain("<code>$");
  });

  it("a chip whose LEADING anchor char is tombstoned still serializes as math", () => {
    const { page, blockId, binding, pre } = chipDoc("ab");
    // Delete the formula's first char ('a') — the mark span's start anchor.
    const { newPage } = deleteCharsInRange(
      page,
      blockId,
      pre.length,
      pre.length + 1,
      binding,
    );

    const md = serializeToMarkdown(newPage.blocks);
    const html = serializeToHTML(newPage.blocks, { title: "t" });

    expect(md).toContain("$b$");
    expect(html).toContain("<svg");
    expect(html).not.toContain("<code>$");
  });
});
