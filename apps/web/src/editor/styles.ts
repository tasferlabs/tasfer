import { getCurrentFontFamily, FONT_STACKS } from "./fonts";
import type { EditorStyles, TextStyle } from "./types";

export const defaultStyles: EditorStyles = {
  canvas: {
    backgroundColor: "#ffffff",
    paddingTop: 40,
    paddingBottom: 80,
    paddingLeft: 40,
    paddingRight: 40,
    lineHeight: 1.6,
  },
  blocks: {
    heading1: {
      fontSize: 32,
      fontWeight: "500",
      color: "#1a1a1a",
      lineHeight: 1.4,
      paddingBottom: 4,
    },
    heading2: {
      fontSize: 24,
      fontWeight: "500",
      color: "#1a1a1a",
      lineHeight: 1.4,
      paddingBottom: 6,
    },
    heading3: {
      fontSize: 20,
      fontWeight: "500",
      color: "#1a1a1a",
      lineHeight: 1.4,
      paddingBottom: 6,
    },
    paragraph: {
      fontSize: 16,
      fontWeight: "normal",
      color: "#333333",
      lineHeight: 1.6,
      paddingBottom: 4,
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
  placeholder: {
    heading1: {
      text: "Heading 1",
    },
    heading2: {
      text: "Heading 2",
    },
    heading3: {
      text: "Heading 3",
    },
    paragraph: {
      text: "Type '/' for commands.",
      mobileText: "Type something awesome...",
    },
    color: "#999999",
    opacity: 0.6,
  },
};

export const getTextStyle = (
  styles: EditorStyles,
  blockType: "heading1" | "heading2" | "heading3" | "paragraph"
) => {
  return styles.blocks[blockType];
};

export const applyTextStyle = (
  ctx: CanvasRenderingContext2D,
  style: TextStyle
) => {
  const fontStack = FONT_STACKS[getCurrentFontFamily()];
  ctx.font = `${style.fontWeight} ${style.fontSize}px ${fontStack}`;
  ctx.fillStyle = style.color;
  ctx.textBaseline = "alphabetic";
};
