import type { EditorStyles } from "./types";

export const defaultStyles: EditorStyles = {
  canvas: {
    backgroundColor: "#ffffff",
    padding: 40,
    lineHeight: 1.6,
  },
  blocks: {
    heading1: {
      fontSize: 32,
      fontFamily: "system-ui, -apple-system, sans-serif",
      fontWeight: "bold",
      color: "#1a1a1a",
      lineHeight: 1.2,
      marginBottom: 6,
    },
    heading2: {
      fontSize: 24,
      fontFamily: "system-ui, -apple-system, sans-serif",
      fontWeight: "bold",
      color: "#1a1a1a",
      lineHeight: 1.3,
      marginBottom: 6,
    },
    heading3: {
      fontSize: 20,
      fontFamily: "system-ui, -apple-system, sans-serif",
      fontWeight: "bold",
      color: "#1a1a1a",
      lineHeight: 1.4,
      marginBottom: 6,
    },
    paragraph: {
      fontSize: 16,
      fontFamily: "system-ui, -apple-system, sans-serif",
      fontWeight: "normal",
      color: "#333333",
      lineHeight: 1.6,
      marginBottom: 12,
    },
  },
  cursor: {
    width: 2,
    color: "#007acc",
    blinkInterval: 530,
  },
  selection: {
    backgroundColor: "#007acc",
    opacity: 0.2,
  },
};

export const getTextStyle = (
  styles: EditorStyles,
  blockType: "heading1" | "heading2" | "heading3" | "paragraph"
) => {
  return styles.blocks[blockType];
};

export const applyTextStyle = (ctx: CanvasRenderingContext2D, style: any) => {
  ctx.font = `${style.fontWeight} ${style.fontSize}px ${style.fontFamily}`;
  ctx.fillStyle = style.color;
  ctx.textBaseline = "top";
};
