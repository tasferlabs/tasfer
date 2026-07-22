import { resolveTheme } from "./styles";
import { describe, expect, it } from "vitest";

// Covers the theming leaves added for host customization of carets, selection,
// remote cursors, and placeholders — that they default to the historical
// values (so nothing changes until overridden) and that host overrides
// deep-merge onto the resolved tree.
describe("theme resolution — caret / selection / remote-cursor leaves", () => {
  it("defaults preserve the historical appearance", () => {
    const s = resolveTheme();
    expect(s.selection.cornerRadius).toBe(0); // sharp rects, as before
    expect(s.selection.remoteOpacity).toBe(0.2);
    expect(s.remoteCursor.caretWidth).toBe(2); // same as the local caret
    expect(s.remoteCursor.labelGap).toBe(2);
    expect(s.remoteCursor.outOfViewIndicator.edgeMargin).toBe(4);
    expect(s.remoteCursor.outOfViewIndicator.initialFontWeight).toBe("600");
  });

  it("overrides deep-merge without disturbing siblings", () => {
    const s = resolveTheme({
      styles: {
        selection: { cornerRadius: 6 },
        remoteCursor: { caretWidth: 3 },
      },
    });
    expect(s.selection.cornerRadius).toBe(6);
    expect(s.selection.opacity).toBe(0.2); // untouched sibling
    expect(s.remoteCursor.caretWidth).toBe(3);
    expect(s.remoteCursor.labelGap).toBe(2); // untouched sibling
  });
});

describe("theme resolution — placeholder appearance", () => {
  it("has no per-type appearance by default except the baked quote/math sizes", () => {
    const s = resolveTheme();
    expect(s.placeholder.showUnfocused).toBe(false);
    // Text blocks inherit their own font — no placeholder override object.
    expect(s.blocks.heading1.placeholder).toBeUndefined();
    expect(s.blocks.paragraph.placeholder).toBeUndefined();
    // The quote's smaller ghost hint and math's absolute size now live in the
    // theme (previously hardcoded in QuoteNode / MathNode).
    expect(s.blocks.quote.placeholder?.fontScale).toBe(0.8);
    expect(s.blocks.math.placeholder.fontSize).toBe(14);
    expect(s.blocks.math.placeholder.fontWeight).toBe("400");
  });

  it("accepts a per-type placeholder color/scale/weight override", () => {
    const s = resolveTheme({
      styles: {
        placeholder: { showUnfocused: true },
        blocks: {
          heading1: { placeholder: { color: "#b9b9c2", fontWeight: "600" } },
          quote: { placeholder: { fontScale: 0.6 } },
        },
      },
    });
    expect(s.placeholder.showUnfocused).toBe(true);
    expect(s.blocks.heading1.placeholder).toEqual({
      color: "#b9b9c2",
      fontWeight: "600",
    });
    // Deep-merge keeps the default scale-only quote override's other fields.
    expect(s.blocks.quote.placeholder?.fontScale).toBe(0.6);
  });
});

describe("theme resolution — token flow", () => {
  it("flows code-syntax tokens into the resolved code block styles", () => {
    // The host bridge maps these tokens from CSS vars; before the fix they were
    // unmapped and silently kept the light-mode defaults in dark mode.
    const s = resolveTheme({
      tokens: {
        codeKeyword: "#111111",
        codeString: "#222222",
        mathErrorBackground: "#333333",
      },
    });
    expect(s.blocks.code.syntax.keyword).toBe("#111111");
    expect(s.blocks.code.syntax.string).toBe("#222222");
    expect(s.blocks.math.errorBackgroundColor).toBe("#333333");
  });
});
