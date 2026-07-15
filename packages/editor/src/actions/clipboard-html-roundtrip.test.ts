/**
 * Pins the clipboard `text/html` round-trip after `blocksToHTML` was switched
 * from a hand-written per-type switch to the node-owned export fragment plus a
 * Tasfer-origin marker carrying the canonical Markdown.
 *
 * The guarantee: a Tasfer→Tasfer copy/paste is lossless. The copy payload's
 * HTML is prefixed with `<!--cypher-clipboard:...-->`; `parseHTMLToBlocks`
 * decodes that Markdown (bypassing defuddle) so image sizing, block math, and
 * list indent — all dropped by the old rendered-HTML→defuddle path — survive.
 */

import { mathTestSchema, mathTestStateOptions } from "../__testutils__/math";
import {
  getStructuredMathSource,
  mathContentIdForBlock,
  parseMathDocumentInit,
} from "../math/structured";
import {
  type Block,
  type CharRun,
  loadPage,
  type Page,
} from "../serlization/loadPage";
import { createInitialState } from "../state-utils";
import { getVisibleTextFromRuns } from "../sync/char-runs";
import { createCRDTbinding } from "../sync/sync";
import { buildClipboardPayload, parseHTMLToBlocks } from "./clipboard";
import { describe, expect, it } from "vitest";

function run(text: string) {
  return [{ peerId: "peer", startCounter: 0, text }];
}

/**
 * A display equation in the current model: empty flat text, all content in
 * the block-authority attachment keyed by the block id.
 */
function mathBlock(id: string, orderKey: string, latex: string): Block {
  const contentId = mathContentIdForBlock(id);
  return {
    id,
    orderKey,
    type: "math",
    charRuns: [],
    formats: [],
    displayMode: true,
    structuredContent: {
      [contentId]: parseMathDocumentInit(latex, { contentId }).document,
    },
  } as unknown as Block;
}

function pageWith(...blocks: Page["blocks"]): Page {
  return { id: "page-1", title: "t", blocks };
}

/** Select every block start→end so the whole document is on the clipboard. */
function selectAll(page: Page) {
  const state = createInitialState(page, mathTestStateOptions());
  const lastIndex = page.blocks.length - 1;
  const last = page.blocks[lastIndex];
  const lastLen =
    "charRuns" in last ? getVisibleTextFromRuns(last.charRuns).length : 0;
  return {
    ...state,
    document: {
      ...state.document,
      selection: {
        anchor: { blockIndex: 0, textIndex: 0 },
        focus: { blockIndex: lastIndex, textIndex: lastLen },
        isForward: true,
        isCollapsed: false,
      },
    },
  };
}

describe("clipboard text/html round-trip", () => {
  const source = pageWith(
    {
      id: "h1",
      orderKey: "a0",
      type: "heading1",
      charRuns: run("Title"),
      formats: [],
    } as unknown as Block,
    {
      id: "img1",
      orderKey: "a1",
      type: "image",
      url: "https://example.com/a.png",
      alt: "a pic",
      width: 200,
      height: 100,
      objectFit: "contain",
    } as unknown as Block,
    // Fixture source is already canonical so assertions read as identities.
    mathBlock("m1", "a2", "{x}^{2}+{y}^{2}"),
    {
      id: "li1",
      orderKey: "a3",
      type: "bullet_list",
      charRuns: run("First"),
      formats: [],
      indent: 0,
    } as unknown as Block,
    {
      id: "li2",
      orderKey: "a4",
      type: "bullet_list",
      charRuns: run("Nested"),
      formats: [],
      indent: 1,
    } as unknown as Block,
  );

  it("prefixes the html payload with the Tasfer-origin marker", () => {
    const payload = buildClipboardPayload(selectAll(source));
    expect(payload).not.toBeNull();
    expect(payload!.html).toMatch(/^<!--cypher-clipboard:[A-Za-z0-9+/=]+-->/);
    // The rendered fragment (for external apps) follows the marker.
    expect(payload!.html).toContain("<h1>");
  });

  it("keeps task-list markdown out of the plain-text payload", () => {
    const page = pageWith({
      id: "todo1",
      orderKey: "a0",
      type: "todo_list",
      charRuns: run("Follow up"),
      formats: [],
      checked: false,
      indent: 0,
    } as unknown as Block);
    const payload = buildClipboardPayload(selectAll(page));

    expect(payload).not.toBeNull();
    expect(payload!.markdown).toBe("- [ ] Follow up");
    // Plain text (text/plain) goes to external apps as bare text — no marker,
    // not literal `[ ]` brackets.
    expect(payload!.plainText).toBe("Follow up");
  });

  it("emits block math as `$$…$$` LaTeX in the plain-text payload", () => {
    const page = pageWith(mathBlock("m1", "a0", "{x}^{2}+{y}^{2}"));
    const payload = buildClipboardPayload(selectAll(page));

    expect(payload).not.toBeNull();
    // External plain-text targets (terminals, code editors) must receive the
    // tree's LaTeX source, not the block's (empty) flat text.
    expect(payload!.plainText).toBe("$${x}^{2}+{y}^{2}$$");
  });

  it("keeps inline math `$…$` delimiters in the plain-text payload", () => {
    // A chip's flat projection is one anchor char; the plain-text mirror must
    // resolve the attachment's source, never leak the placeholder char.
    const page = loadPage("see ${a}^{2}$ end", mathTestSchema.data);
    const payload = buildClipboardPayload(selectAll(page));

    expect(payload).not.toBeNull();
    expect(payload!.plainText).toBe("see ${a}^{2}$ end");
  });

  it("round-trips image sizing, block math, and list indent losslessly", () => {
    const payload = buildClipboardPayload(selectAll(source));
    const binding = createCRDTbinding("page-2", "peer-b");
    const blocks = parseHTMLToBlocks(
      payload!.html,
      binding,
      mathTestSchema.data,
    );

    const image = blocks.find((b) => b.type === "image") as
      | (Block & { url: string; width: unknown; objectFit: unknown })
      | undefined;
    expect(image).toBeDefined();
    expect(image!.url).toBe("https://example.com/a.png");
    expect(image!.width).toBe(200);
    expect(image!.objectFit).toBe("contain");

    // Math content travels in the marker's markdown and re-imports as a
    // fresh block-authority attachment; the flat text stays empty.
    const math = blocks.find((b) => (b.type as string) === "math") as
      | (Block & { charRuns: CharRun[]; displayMode: boolean })
      | undefined;
    expect(math).toBeDefined();
    expect(getVisibleTextFromRuns(math!.charRuns)).toBe("");
    expect(getStructuredMathSource(math!)).toBe("{x}^{2}+{y}^{2}");
    expect(math!.displayMode).toBe(true);

    const lists = blocks.filter((b) => b.type === "bullet_list") as Array<
      Block & { indent: number }
    >;
    expect(lists).toHaveLength(2);
    expect(lists.map((l) => l.indent)).toEqual([0, 1]);
  });

  it("decodes the marker even when the browser wraps the fragment", () => {
    // Browsers wrap clipboard HTML in a document shell on round-trip
    // (`<html><body><!--StartFragment-->…<!--EndFragment-->`), so by paste time
    // the Tasfer marker is no longer at the start of the payload. The lossless
    // path must still kick in — otherwise a copied checklist falls back to
    // defuddle and degrades to a plain bullet list.
    const page = pageWith({
      id: "todo1",
      orderKey: "a0",
      type: "todo_list",
      charRuns: run("Follow up"),
      formats: [],
      checked: true,
      indent: 0,
    } as unknown as Block);
    const payload = buildClipboardPayload(selectAll(page))!;
    const wrapped = `<html>\n<body>\n<!--StartFragment-->${payload.html}<!--EndFragment-->\n</body>\n</html>`;
    const blocks = parseHTMLToBlocks(
      wrapped,
      createCRDTbinding("page-w", "peer-w"),
      mathTestSchema.data,
    );

    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("todo_list");
    expect((blocks[0] as Block & { checked: boolean }).checked).toBe(true);
    expect(
      getVisibleTextFromRuns(
        (blocks[0] as Block & { charRuns: CharRun[] }).charRuns,
      ),
    ).toBe("Follow up");
  });

  it("preserves Unicode through the base64 marker", () => {
    const page = pageWith({
      id: "p1",
      orderKey: "a0",
      type: "paragraph",
      charRuns: run("emoji 🚀 and üñîçødé"),
      formats: [],
    } as unknown as Block);
    const payload = buildClipboardPayload(selectAll(page));
    const blocks = parseHTMLToBlocks(
      payload!.html,
      createCRDTbinding("page-3", "peer-c"),
      mathTestSchema.data,
    );
    const text = blocks
      .filter((b): b is Block & { charRuns: never } => "charRuns" in b)
      .map((b) => getVisibleTextFromRuns(b.charRuns))
      .join("");
    expect(text).toContain("🚀");
    expect(text).toContain("üñîçødé");
  });
});
