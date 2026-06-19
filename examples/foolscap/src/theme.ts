import type { EditorTheme } from "@cypherkit/editor";

/**
 * Foolscap's look as a single `EditorTheme` value — warm paper, an old-style
 * serif body, an amber caret. Because the canvas is transparent (the engine
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
    text: "#2c2722",
    heading: "#23201b",
    background: "#f4ecdc",
    placeholder: "#bcae90",
    cursor: "#b07d3c",
    selection: "rgba(176,125,60,0.20)",
    selectionUnfocused: "rgba(176,125,60,0.10)",
    link: "#9a5b2c",
    linkHover: "#7d4a22",
    codeBackground: "#efe5d0",
    codeText: "#8a5a2b",
  },
  styles: {
    blocks: {
      paragraph: { fontSize: 20, lineHeight: 1.85, color: "#2c2722" },
      heading1: { fontSize: 38, fontWeight: "600", color: "#23201b", lineHeight: 1.2 },
      heading2: { fontSize: 28, fontWeight: "600", color: "#23201b" },
      heading3: { fontSize: 22, fontWeight: "600", color: "#23201b" },
    },
    // The editor lives inside an already-narrow centered column, so it needs
    // only a little breathing room of its own.
    canvas: { paddingTop: 8, paddingBottom: 160, paddingLeft: 8, paddingRight: 8 },
  },
};
