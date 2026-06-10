import { IMAGE_DEFAULT_HEIGHT } from "./constants";
import { getCurrentFontFamily, getFontStack } from "./fonts";
import type {
  EditorState,
  EditorStrings,
  EditorStyles,
  FontStyles,
  TextStyle,
} from "./state-types";
import { isTouchDevice } from "./state-utils";

/**
 * English defaults for every canvas-painted string. The editor ships no i18n
 * library — a localized host overrides these per instance via the `strings`
 * mount option (see {@link EditorStrings}).
 */
const DEFAULT_STRINGS: EditorStrings = {
  imageClickToUpload: "Click to upload image",
  imageLoading: "Loading image...",
  imageUploading: "Uploading image...",
  imageUploadFailed: "Failed to upload image",
  imageClickToRetry: "Click to retry",
  imageChangeImage: "Change Image",
  mathClickToEdit: "Click to add equation",
  placeholderHeading1: "Heading 1",
  placeholderHeading2: "Heading 2",
  placeholderHeading3: "Heading 3",
  placeholderParagraph: "Type '/' for commands.",
  placeholderParagraphTouch: "Type something awesome...",
  placeholderListItem: "List item",
  placeholderTodoItem: "To-do item",
};

/**
 * Neutral, opinion-free default font registry. The editor ships no bundled
 * fonts — a consuming app registers its own faces via `setFontStyles()` (or
 * mount options) and is responsible for loading them. This system-font default
 * just guarantees text renders before any custom fonts are configured.
 */
const DEFAULT_FONT_STYLES: FontStyles = {
  families: {
    default:
      'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  },
  defaultFamily: "default",
};

/**
 * Host-supplied font registry set via setFontStyles(). When null the editor
 * uses the neutral system-font default (DEFAULT_FONT_STYLES).
 *
 * NOTE: still a module global pending Phase 2 of the styles de-globalization
 * (the font registry threads deep into the measurement path). Padding, block,
 * placeholder, and window-focus state now live on `EditorState`.
 */
let fontStylesOverride: Partial<FontStyles> | null = null;

/**
 * Register the host application's font families (key → CSS font-stack) and the
 * default family. The host owns loading the corresponding font faces. Pass null
 * to reset to the neutral system-font default.
 *
 * Update this (e.g. to prepend a newly-loaded script font) and then call
 * `notifyFontsChanged()` so the editor flushes its metrics cache and re-renders.
 */
export function setFontStyles(fonts: Partial<FontStyles> | null): void {
  fontStylesOverride = fonts;
}

/** Return the current font registry override (for save/restore across editor instances). */
export function getFontStyles() {
  return fontStylesOverride;
}

/**
 * Resolved font registry (host override layered over the system-font default).
 *
 * This is the accessor for the text-measurement hot path (`getFontStack` runs
 * once per character during wrapping) — it must stay free of the
 * `getComputedStyle` calls that building a full `EditorStyles` incurs.
 */
export function getResolvedFontStyles(): FontStyles {
  return {
    families: fontStylesOverride?.families ?? DEFAULT_FONT_STYLES.families,
    defaultFamily:
      fontStylesOverride?.defaultFamily ?? DEFAULT_FONT_STYLES.defaultFamily,
  };
}

/**
 * Get CSS custom property value from the document root
 */
function getCSSVariable(name: string, fallback?: string): string {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();

  return value || fallback || "";
}

//NOTE -  We make as customizable as possible, but as well make sure that we offload customization to the consumers.
/**
 * Get editor styles from CSS variables, layered with this instance's overrides.
 *
 * Per-instance overrides (padding, block styles, placeholders, window focus)
 * are read from `state` when provided. Omitting `state` yields the unstyled
 * defaults — used only by fallback default-params and the `defaultStyles`
 * snapshot; every real render/layout/hit-test path passes `state`.
 */
export function getEditorStyles(state?: EditorState): EditorStyles {
  const paddingOverride = state?.styleConfig.padding ?? null;
  const blockStyleOverrides = state?.styleConfig.blockStyleOverrides ?? null;
  const placeholderOverrides = state?.styleConfig.placeholderOverrides ?? null;
  const strings: EditorStrings = {
    ...DEFAULT_STRINGS,
    ...state?.styleConfig.strings,
  };
  // Window focus defaults to true when unknown (no state) so selection renders
  // in its focused color rather than the dimmed unfocused variant.
  const isWindowFocused = state?.view.isWindowFocused ?? true;

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
    fonts: getResolvedFontStyles(),
    blocks: {
      heading1: {
        fontSize: 32,
        fontWeight: "500",
        color: getCSSVariable("--editor-heading"),
        lineHeight: 1.4,
        paddingBottom: 10,
        ...blockStyleOverrides?.heading1,
      },
      heading2: {
        fontSize: 24,
        fontWeight: "500",
        color: getCSSVariable("--editor-heading"),
        lineHeight: 1.4,
        paddingBottom: 10,
        ...blockStyleOverrides?.heading2,
      },
      heading3: {
        fontSize: 20,
        fontWeight: "500",
        color: getCSSVariable("--editor-heading"),
        lineHeight: 1.4,
        paddingBottom: 10,
        ...blockStyleOverrides?.heading3,
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
          text: strings.imageClickToUpload,
        },
        loading: {
          backgroundColor: getCSSVariable("--muted"),
          textColor: getCSSVariable("--muted-foreground"),
          text: strings.imageLoading,
        },
        uploading: {
          backgroundColor: getCSSVariable("--muted"),
          textColor: getCSSVariable("--muted-foreground"),
          text: strings.imageUploading,
        },
        error: {
          backgroundColor: getCSSVariable("--destructive"),
          textColor: getCSSVariable("--destructive-foreground"),
          text: strings.imageUploadFailed,
          retryText: strings.imageClickToRetry,
        },
        hover: {
          overlayColor: getCSSVariable("--editor-cover-image-overlay"),
          buttonBackgroundColor: getCSSVariable("--background"),
          buttonTextColor: getCSSVariable("--foreground"),
          buttonText: strings.imageChangeImage,
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
      math: {
        paddingTop: 12,
        paddingBottom: 12,
        minHeight: 48,
        hoverBackgroundColor: getCSSVariable("--muted"),
        hoverBorderRadius: 6,
        placeholder: {
          backgroundColor: getCSSVariable("--muted"),
          textColor: getCSSVariable("--muted-foreground"),
          text: strings.mathClickToEdit,
        },
      },
    },
    cursor: {
      width: 2,
      color: getCSSVariable("--editor-cursor"),
      blinkInterval: 530,
    },
    remoteCursor: {
      labelTextColor: getCSSVariable(
        "--editor-remote-cursor-label-text",
        "#FFFFFF",
      ),
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
        text:
          placeholderOverrides?.heading1?.text ?? strings.placeholderHeading1,
      },
      heading2: {
        text:
          placeholderOverrides?.heading2?.text ?? strings.placeholderHeading2,
      },
      heading3: {
        text:
          placeholderOverrides?.heading3?.text ?? strings.placeholderHeading3,
      },
      paragraph: {
        keyboardCompatibleText:
          placeholderOverrides?.paragraph?.keyboardCompatibleText ??
          strings.placeholderParagraph,
        touchCompatiableText:
          placeholderOverrides?.paragraph?.touchCompatiableText ??
          strings.placeholderParagraphTouch,
      },
      listItem: {
        text:
          placeholderOverrides?.listItem?.text ?? strings.placeholderListItem,
      },
      todoItem: {
        text:
          placeholderOverrides?.todoItem?.text ?? strings.placeholderTodoItem,
      },
      color: getCSSVariable("--editor-placeholder"),
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
      inlineMath: {
        backgroundColor: getCSSVariable("--editor-code-bg"),
        hoverBackgroundColor: getCSSVariable("--muted"),
        color: getCSSVariable("--editor-code-text"),
        padding: 2,
        borderRadius: 3,
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

export function getTextStyle(
  styles: EditorStyles,
  blockType:
    | "heading1"
    | "heading2"
    | "heading3"
    | "paragraph"
    | "bullet_list"
    | "numbered_list"
    | "todo_list",
) {
  if (blockType === "bullet_list") {
    return styles.blocks.bulletList;
  } else if (blockType === "numbered_list") {
    return styles.blocks.numberedList;
  } else if (blockType === "todo_list") {
    return styles.blocks.todoList;
  }
  return styles.blocks[blockType];
}

export function applyTextStyle(
  ctx: CanvasRenderingContext2D,
  style: TextStyle,
) {
  const fontStack = getFontStack(getCurrentFontFamily());
  ctx.font = `${style.fontWeight} ${style.fontSize}px ${fontStack}`;
  ctx.fillStyle = style.color;
  ctx.textBaseline = "alphabetic";
}
