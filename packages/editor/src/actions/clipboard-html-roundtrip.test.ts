/**
 * Pins the clipboard `text/html` round-trip after `blocksToHTML` was switched
 * from a hand-written per-type switch to the node-owned export fragment plus a
 * Cypher-origin marker carrying the canonical Markdown.
 *
 * The guarantee: a Cypher→Cypher copy/paste is lossless. The copy payload's
 * HTML is prefixed with `<!--cypher-clipboard:...-->`; `parseHTMLToBlocks`
 * decodes that Markdown (bypassing defuddle) so image sizing, block math, and
 * list indent — all dropped by the old rendered-HTML→defuddle path — survive.
 */

import type { Block, Page } from "../serlization/loadPage";
import { createInitialState } from "../state-utils";
import { getVisibleTextFromRuns } from "../sync/char-runs";
import { createCRDTbinding } from "../sync/sync";
import { buildClipboardPayload, parseHTMLToBlocks } from "./clipboard";
import { describe, expect, it } from "vitest";

function run(text: string) {
  return [{ peerId: "peer", startCounter: 0, text }];
}

function pageWith(...blocks: Page["blocks"]): Page {
  return { id: "page-1", title: "t", blocks };
}

/** Select every block start→end so the whole document is on the clipboard. */
function selectAll(page: Page) {
  const state = createInitialState(page);
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
      afterId: null,
      type: "heading1",
      charRuns: run("Title"),
      formats: [],
    } as unknown as Block,
    {
      id: "img1",
      afterId: "h1",
      type: "image",
      url: "https://example.com/a.png",
      alt: "a pic",
      width: 200,
      height: 100,
      objectFit: "contain",
    } as unknown as Block,
    {
      id: "m1",
      afterId: "img1",
      type: "math",
      charRuns: run("x^2 + y^2"),
      formats: [],
      displayMode: true,
    } as unknown as Block,
    {
      id: "li1",
      afterId: "m1",
      type: "bullet_list",
      charRuns: run("First"),
      formats: [],
      indent: 0,
    } as unknown as Block,
    {
      id: "li2",
      afterId: "li1",
      type: "bullet_list",
      charRuns: run("Nested"),
      formats: [],
      indent: 1,
    } as unknown as Block,
  );

  it("prefixes the html payload with the Cypher-origin marker", () => {
    const payload = buildClipboardPayload(selectAll(source));
    expect(payload).not.toBeNull();
    expect(payload!.html).toMatch(/^<!--cypher-clipboard:[A-Za-z0-9+/=]+-->/);
    // The rendered fragment (for external apps) follows the marker.
    expect(payload!.html).toContain("<h1>");
  });

  it("round-trips image sizing, block math, and list indent losslessly", () => {
    const payload = buildClipboardPayload(selectAll(source));
    const binding = createCRDTbinding("page-2", "peer-b");
    const blocks = parseHTMLToBlocks(payload!.html, binding);

    const image = blocks.find((b) => b.type === "image") as
      | (Block & { url: string; width: unknown; objectFit: unknown })
      | undefined;
    expect(image).toBeDefined();
    expect(image!.url).toBe("https://example.com/a.png");
    expect(image!.width).toBe(200);
    expect(image!.objectFit).toBe("contain");

    // Math is textual now — its char-run text is the LaTeX.
    const math = blocks.find((b) => b.type === "math") as
      | (Block & { charRuns: CharRun[]; displayMode: boolean })
      | undefined;
    expect(math).toBeDefined();
    expect(getVisibleTextFromRuns(math!.charRuns)).toContain("x^2 + y^2");
    expect(math!.displayMode).toBe(true);

    const lists = blocks.filter((b) => b.type === "bullet_list") as Array<
      Block & { indent: number }
    >;
    expect(lists).toHaveLength(2);
    expect(lists.map((l) => l.indent)).toEqual([0, 1]);
  });

  it("preserves Unicode through the base64 marker", () => {
    const page = pageWith({
      id: "p1",
      afterId: null,
      type: "paragraph",
      charRuns: run("emoji 🚀 and üñîçødé"),
      formats: [],
    } as unknown as Block);
    const payload = buildClipboardPayload(selectAll(page));
    const blocks = parseHTMLToBlocks(
      payload!.html,
      createCRDTbinding("page-3", "peer-c"),
    );
    const text = blocks
      .filter((b): b is Block & { charRuns: never } => "charRuns" in b)
      .map((b) => getVisibleTextFromRuns(b.charRuns))
      .join("");
    expect(text).toContain("🚀");
    expect(text).toContain("üñîçødé");
  });
});
