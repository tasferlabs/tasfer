import type { EditorTheme } from "@cypherkit/editor";

/**
 * Cypher Studio's "Midnight" look as a single `EditorTheme` value — a dark
 * surface, a cyan accent, a sans body with JetBrains Mono code. The canvas is
 * transparent (the engine clears each frame), so the dark backdrop is set in
 * CSS on the host element; these tokens color the content the engine paints.
 */
export const studioTheme: EditorTheme = {
  fontFamily: "sans",
  fonts: {
    families: {
      sans: '"Plus Jakarta Sans", system-ui, -apple-system, sans-serif',
      monospace: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
    },
    defaultFamily: "sans",
  },
  tokens: {
    text: "#c4ccd6",
    heading: "#f0f4f8",
    background: "#0a0e14",
    placeholder: "#586173",
    cursor: "#39c5cf",
    selection: "rgba(57,197,207,0.26)",
    selectionUnfocused: "rgba(57,197,207,0.12)",
    link: "#58c7ff",
    linkHover: "#8ad6ff",
    codeBackground: "#1c2430",
    codeText: "#ff7b9c",
    primary: "#39c5cf",
    primaryForeground: "#04181a",
    border: "#1a2230",
    muted: "#11161d",
    mutedForeground: "#8b95a5",
    scrollbarThumb: "rgba(120,140,160,0.35)",
    scrollbarThumbHover: "rgba(120,140,160,0.5)",
  },
  styles: {
    blocks: {
      paragraph: { fontSize: 17, lineHeight: 1.75, color: "#c4ccd6" },
      heading1: { fontSize: 33, fontWeight: "700", color: "#f0f4f8" },
      heading2: { fontSize: 24, fontWeight: "700", color: "#f0f4f8" },
      heading3: { fontSize: 20, fontWeight: "700", color: "#f0f4f8" },
      code: { backgroundColor: "#0e141c" },
    },
    canvas: { paddingTop: 8, paddingBottom: 80, paddingLeft: 56, paddingRight: 56 },
  },
};
