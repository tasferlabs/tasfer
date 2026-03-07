import { getCurrentFontFamily, FONT_STACKS } from "./fonts";
import type { EditorStyles, TextStyle } from "./types";
import { IMAGE_DEFAULT_HEIGHT } from "./constants";
import { isTouchDevice } from "./state";

/**
 * Track window focus state globally for editor styling
 */
let isWindowFocused = true;

/**
 * Optional padding overrides set via setEditorPadding()
 */
let paddingOverride: Partial<{
  paddingTop: number;
  paddingBottom: number;
  paddingLeft: number;
  paddingRight: number;
}> | null = null;

/**
 * Override the default canvas padding for the editor.
 * Pass null to reset to defaults.
 */
export function setEditorPadding(
  padding: Partial<{
    paddingTop: number;
    paddingBottom: number;
    paddingLeft: number;
    paddingRight: number;
  }> | null,
): void {
  paddingOverride = padding;
}

/**
 * Set the window focus state
 * @internal This is called from mount.ts when window focus changes
 */
export function setWindowFocused(focused: boolean): void {
  isWindowFocused = focused;
}

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
  const isMobile = typeof window !== "undefined" && window.innerWidth < 768;
  const horizontalPadding = isMobile ? 16 : 40;

  return {
    canvas: {
      paddingTop: paddingOverride?.paddingTop ?? 4,
      paddingBottom: paddingOverride?.paddingBottom ?? 80,
      paddingLeft: paddingOverride?.paddingLeft ?? horizontalPadding,
      paddingRight: paddingOverride?.paddingRight ?? horizontalPadding,
      lineHeight: 1.6,
    },
    blocks: {
      heading1: {
        fontSize: 32,
        fontWeight: "500",
        color: getCSSVariable("--editor-heading"),
        lineHeight: 1.4,
        paddingBottom: 10,
      },
      heading2: {
        fontSize: 24,
        fontWeight: "500",
        color: getCSSVariable("--editor-heading"),
        lineHeight: 1.4,
        paddingBottom: 10,
      },
      heading3: {
        fontSize: 20,
        fontWeight: "500",
        color: getCSSVariable("--editor-heading"),
        lineHeight: 1.4,
        paddingBottom: 10,
      },
      paragraph: {
        fontSize: 16,
        fontWeight: "normal",
        color: getCSSVariable("--editor-text"),
        lineHeight: 1.6,
        paddingBottom: 12,
      },
      bulletList: {
        fontSize: 16,
        fontWeight: "normal",
        color: getCSSVariable("--editor-text"),
        lineHeight: 1.6,
        paddingBottom: 6,
      },
      numberedList: {
        fontSize: 16,
        fontWeight: "normal",
        color: getCSSVariable("--editor-text"),
        lineHeight: 1.6,
        paddingBottom: 6,
      },
      todoList: {
        fontSize: 16,
        fontWeight: "normal",
        color: getCSSVariable("--editor-text"),
        lineHeight: 1.6,
        paddingBottom: 6,
      },
      line: {
        height: 32, // Total block height
        lineHeight: 1, // Thickness of the line
        color: getCSSVariable("--border"),
        paddingTop: 16,
        paddingBottom: 16,
      },
      image: {
        placeholder: {
          backgroundColor: getCSSVariable("--muted"),
          textColor: getCSSVariable("--muted-foreground"),
          borderColor: getCSSVariable("--border"),
          text: "Click to upload image",
        },
        loading: {
          backgroundColor: getCSSVariable("--muted"),
          textColor: getCSSVariable("--muted-foreground"),
          text: "Loading image...",
        },
        uploading: {
          backgroundColor: getCSSVariable("--muted"),
          textColor: getCSSVariable("--muted-foreground"),
          text: "Uploading image...",
        },
        error: {
          backgroundColor: getCSSVariable("--destructive"),
          textColor: getCSSVariable("--destructive-foreground"),
          text: "Failed to upload image",
          retryText: "Click to retry",
        },
        hover: {
          overlayColor: getCSSVariable("--editor-cover-image-overlay"),
          buttonBackgroundColor: getCSSVariable("--background"),
          buttonTextColor: getCSSVariable("--foreground"),
          buttonText: "Change Image",
        },
        dimensions: {
          height: IMAGE_DEFAULT_HEIGHT,
          placeholderHeight: 150,
          paddingBottom: 16,
          buttonWidth: 120,
          buttonHeight: 40,
          borderRadius: 6,
        },
      },
    },
    cursor: {
      width: 2,
      color: getCSSVariable("--editor-cursor"),
      blinkInterval: 530,
    },
    selection: {
      backgroundColor:
        isWindowFocused || isTouchDevice()
          ? getCSSVariable("--editor-selection")
          : getCSSVariable("--editor-selection-unfocused"),
      opacity: 0.2,
      handles: {
        size: 12, // Diameter of the handle circle
        color: getCSSVariable("--editor-selection"),
        touchTargetSize: 44, // Larger touch target for easier interaction
        stemHeight: 8, // Height of the vertical stem
        stemWidth: 2, // Width of the stem
      },
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
        keyboardCompatibleText: "Type '/' for commands.",
        touchCompatiableText: "Type something awesome...",
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
    imageResize: {
      dragHandles: {
        // Vertical bars (left and right sides) - both for horizontal resize (redundant but better UX)
        vertical: {
          length: 100, // Height of the vertical drag bar
          thickness: 6, // Thickness of the vertical drag bar
          borderRadius: 3, // Rounded corners (0 = sharp)
          backgroundColor: getCSSVariable("--muted-foreground"),
          hoverBackgroundColor: getCSSVariable("--primary"),
          opacity: 1, // Hidden by default
          hoverOpacity: 1, // Visible on hover
          inset: 16, // Distance from the edge (0 = at the edge, positive = inside)
        },
        // Horizontal bar (bottom) - for vertical resize
        horizontal: {
          length: 200, // Width of the horizontal drag bar
          thickness: 6, // Thickness of the horizontal drag bar
          borderRadius: 3, // Rounded corners (0 = sharp)
          backgroundColor: getCSSVariable("--muted-foreground"),
          hoverBackgroundColor: getCSSVariable("--primary"),
          opacity: 1, // Hidden by default
          hoverOpacity: 1, // Visible on hover
          inset: 16, // Distance from the edge (0 = at the edge, positive = inside)
        },
      },
      outline: {
        color: getCSSVariable("--primary"),
        width: 2,
        opacity: 0, // Hidden by default
        hoverOpacity: 0, // Subtle outline on hover
        dashPattern: [4, 4], // Dashed outline pattern
      },
      constraints: {
        minWidth: 300, // Minimum width for resized images
        minHeight: IMAGE_DEFAULT_HEIGHT, // Minimum height for resized images
      },
    },
    list: {
      bullet: {
        character: "•",
        color: getCSSVariable("--editor-text"),
        size: 16,
      },
      numbered: {
        color: getCSSVariable("--editor-text"),
        minWidth: 24, // Space reserved for number display
      },
      todo: {
        checkboxSize: 16,
        checkboxBorderColor: getCSSVariable("--border"),
        checkboxCheckedColor: getCSSVariable("--primary"),
        checkboxBorderRadius: 3,
        checkmarkColor: getCSSVariable("--primary-foreground"),
      },
      indent: {
        size: 24, // Pixels per indent level
        maxLevel: 6, // Maximum nesting depth
      },
      marker: {
        offsetX: 0, // Distance from the left edge (before indent)
        textGap: 2, // Gap between marker and text
      },
    },
  };
}

// Export default styles for backwards compatibility
export const defaultStyles: EditorStyles = getEditorStyles();

export const getTextStyle = (
  styles: EditorStyles,
  blockType:
    | "heading1"
    | "heading2"
    | "heading3"
    | "paragraph"
    | "bullet_list"
    | "numbered_list"
    | "todo_list"
) => {
  if (blockType === "bullet_list") {
    return styles.blocks.bulletList;
  } else if (blockType === "numbered_list") {
    return styles.blocks.numberedList;
  } else if (blockType === "todo_list") {
    return styles.blocks.todoList;
  }
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
