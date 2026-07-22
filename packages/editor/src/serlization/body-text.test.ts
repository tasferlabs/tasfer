/**
 * extractBodyText — the page's full-text body projection that backs the local
 * command-center content search index (pages.body_text). It joins every
 * non-empty textual block's visible text with newlines, strips marks, and
 * omits non-textual blocks.
 */

import { extractBodyText } from "../sync/char-runs";
import { loadPage } from "./loadPage";
import { describe, expect, it } from "vitest";

function body(md: string): string {
  return extractBodyText(loadPage(md).blocks);
}

describe("extractBodyText", () => {
  it("joins the visible text of every textual block", () => {
    expect(body("# Title\n\nFirst paragraph.\n\nSecond paragraph.")).toBe(
      "Title\nFirst paragraph.\nSecond paragraph.",
    );
  });

  it("strips inline marks, keeping the plain words searchable", () => {
    expect(body("A **bold** and *italic* and `code` word.")).toBe(
      "A bold and italic and code word.",
    );
  });

  it("skips empty blocks", () => {
    expect(body("# Heading\n\n\n\nBody.")).toBe("Heading\nBody.");
  });

  it("returns empty string for an empty document", () => {
    expect(body("")).toBe("");
    expect(body("\n\n")).toBe("");
  });

  it("returns empty string for undefined blocks", () => {
    expect(extractBodyText(undefined)).toBe("");
  });
});
