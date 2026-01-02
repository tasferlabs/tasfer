import { getCurrentFontFamily, FONT_STACKS } from "./fonts";
import type { EditorStyles, TextStyle } from "./types";

/**
 * Get CSS custom property value from the document root
 */
function getCSSVariable(name: string): string {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();

  return value;
}

/**
 * Get editor styles from CSS variables
 * Falls back to default values if CSS variables are not available
 */
export function getEditorStyles(): EditorStyles {
  return {
    canvas: {
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
        color: getCSSVariable("--editor-heading"),
        lineHeight: 1.4,
        paddingBottom: 4,
      },
      heading2: {
        fontSize: 24,
        fontWeight: "500",
        color: getCSSVariable("--editor-heading"),
        lineHeight: 1.4,
        paddingBottom: 6,
      },
      heading3: {
        fontSize: 20,
        fontWeight: "500",
        color: getCSSVariable("--editor-heading"),
        lineHeight: 1.4,
        paddingBottom: 6,
      },
      paragraph: {
        fontSize: 16,
        fontWeight: "normal",
        color: getCSSVariable("--editor-text"),
        lineHeight: 1.6,
        paddingBottom: 4,
      },
    },
    cursor: {
      width: 2,
      color: getCSSVariable("--editor-cursor"),
      blinkInterval: 530,
    },
    selection: {
      backgroundColor: getCSSVariable("--editor-selection"),
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
      color: getCSSVariable("--editor-placeholder"),
      opacity: 0.6,
    },
    textFormats: {
      code: {
        backgroundColor: getCSSVariable("--editor-code-bg"),
        color: getCSSVariable("--editor-code-text"),
        padding: 2,
        borderRadius: 3,
      },
      link: {
        color: getCSSVariable("--editor-link"),
        underlineThickness: 1,
        hoverColor: getCSSVariable("--editor-link-hover"),
      },
    },
  };
}

// Export default styles for backwards compatibility
export const defaultStyles: EditorStyles = getEditorStyles();

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
