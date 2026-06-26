import type { EditorTheme } from "@cypherkit/editor";

/**
 * Foolscap's look as a single `EditorTheme` value — warm paper, an old-style
 * serif body, a terracotta caret. Because the canvas is transparent (the engine
 * clears each frame and lets CSS own the backdrop), the paper/gradient lives in
 * the stylesheet; the tokens here only color the *content* the engine paints.
 */
export const foolscapTheme: EditorTheme = {
  fontFamily: "spectral",
  fonts: {
    families: {
      spectral: '"Spectral", Georgia, "Times New Roman", serif',
      jakarta: '"Plus Jakarta Sans", system-ui, sans-serif',
      monospace: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
    },
    defaultFamily: "spectral",
  },
  tokens: {
    text: "#201d18",
    heading: "#181610",
    background: "#f3efe6",
    placeholder: "#b8b09e",
    cursor: "#c0522f",
    selection: "rgba(192,82,47,0.20)",
    selectionUnfocused: "rgba(192,82,47,0.10)",
    link: "#9a5b2c",
    linkHover: "#7d4a22",
    codeBackground: "#ece7da",
    codeText: "#8a5a2b",
  },
  styles: {
    blocks: {
      paragraph: { fontSize: 20, lineHeight: 1.85, color: "#201d18" },
      heading1: { fontSize: 38, fontWeight: "600", color: "#181610", lineHeight: 1.2 },
      heading2: { fontSize: 28, fontWeight: "600", color: "#181610" },
      heading3: { fontSize: 22, fontWeight: "600", color: "#181610" },
    },
    // The editor lives inside an already-narrow centered column, so it needs
    // only a little breathing room of its own.
    canvas: { paddingTop: 8, paddingBottom: 160, paddingLeft: 8, paddingRight: 8 },
  },
};
