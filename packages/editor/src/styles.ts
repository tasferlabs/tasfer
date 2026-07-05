import { IMAGE_DEFAULT_HEIGHT } from "./constants";
import { currentFontFamily, getFontStack } from "./fonts";
// From the leaf `node-shared`, not `state-utils`: `state-utils` imports the node
// registry, and the node views import `styles`, so importing `isTouchDevice`
// from `state-utils` here would close a circular init (`styles → state-utils →
// nodes → TextNode → styles`) that leaves `ListNode extends TextNode` undefined.
import { isTouchDevice, mergeBlockStyle } from "./node-shared";
import type { NodeRegistry } from "./rendering/nodes/Node";
import type { Block } from "./serlization/loadPage";
import type {
  DeepPartial,
  EditorState,
  EditorStrings,
  EditorStyles,
  EditorTheme,
  FontStyles,
  NodeStringsMap,
  TextStyle,
  ThemeTokens,
} from "./state-types";

/**
 * English defaults for the cross-node canvas strings (block placeholders). The
 * editor ships no i18n library — a localized host overrides these per instance
 * via the `strings` mount option (see {@link EditorStrings}). Strings owned by a
 * single block type live on the node (its `strings` catalog) and resolve
 * through {@link resolveNodeStrings}, not here.
 */
const DEFAULT_STRINGS: EditorStrings = {
  placeholderHeading1: "Heading 1",
  placeholderHeading2: "Heading 2",
  placeholderHeading3: "Heading 3",
  placeholderParagraph: "Type '/' for actions.",
  placeholderParagraphTouch: "Type something awesome...",
  placeholderListItem: "List item",
  placeholderTodoItem: "To-do item",
  placeholderMath: "Type an equation, or type '\\' for commands…",
};

/**
 * Neutral, opinion-free default font registry. The editor ships no bundled
 * fonts — a consuming app registers its own faces via `theme.fonts` (mount
 * option or `setTheme`) and is responsible for loading them. This system-font
 * default just guarantees text renders before any custom fonts are configured.
 */
export const DEFAULT_FONT_STYLES: FontStyles = {
  families: {
    default:
      'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    // Monospace stack for code blocks. Resolves to a system monospace face, so
    // it measures and renders correctly without the host loading a web font.
    monospace:
      'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
  },
  defaultFamily: "default",
};

/** Font-family key code blocks render with. Present in {@link DEFAULT_FONT_STYLES}. */
export const CODE_FONT_FAMILY = "monospace";

/**
 * Neutral, opinion-free default palette. The editor ships these so it renders
 * sensibly with zero configuration; a host re-themes by passing `tokens` (see
 * {@link ThemeTokens}). These were formerly read from `--editor-*` /
 * `--primary` / `--muted` … CSS variables off `document.documentElement`; the
 * engine no longer touches the DOM — a host that drives appearance from CSS
 * variables converts them to tokens on its own side and passes them in.
 */
export const DEFAULT_TOKENS: ThemeTokens = {
  text: "#1f2328",
  heading: "#0d1117",
  placeholder: "#9ca3af",
  background: "#ffffff",
  foreground: "#1f2328",
  border: "#e5e7eb",
  muted: "#f3f4f6",
  mutedForeground: "#6b7280",
  primary: "#3b82f6",
  primaryForeground: "#ffffff",
  destructive: "#ef4444",
  destructiveForeground: "#ffffff",
  cursor: "#3b82f6",
  selection: "#3b82f6",
  selectionUnfocused: "#9ca3af",
  remoteCursorLabelText: "#ffffff",
  codeBackground: "#f3f4f6",
  codeText: "#ef4444",
  link: "#3b82f6",
  linkHover: "#2563eb",
  coverImageOverlay: "rgba(0,0,0,0.05)",
  scrollbarTrack: "rgba(0,0,0,0.05)",
  scrollbarThumb: "rgba(128,128,128,0.5)",
  scrollbarThumbHover: "rgba(128,128,128,0.7)",
  scrollbarThumbActive: "rgba(128,128,128,0.9)",
  unknownBlockBackground: "rgba(127,127,127,0.06)",
  unknownBlockBorder: "rgba(127,127,127,0.4)",
  unknownBlockText: "rgba(127,127,127,0.8)",
  mathErrorBackground: "rgba(128,128,128,0.15)",
  codeKeyword: "#9333ea",
  codeString: "#16a34a",
  codeComment: "#6b7280",
  codeNumber: "#c2410c",
  codeFunction: "#2563eb",
};

// Default horizontal page padding. Mobile gets tighter gutters; both are
// overridable via `theme.styles.canvas.paddingLeft/Right`. The mobile/desktop
// choice is dynamic (depends on the live viewport width), so it is applied in
// `getEditorStyles` rather than baked into the resolved theme.
const DESKTOP_HORIZONTAL_PADDING = 40;
const MOBILE_HORIZONTAL_PADDING = 16;

// Default font-stack for the unknown-block label (matches the previous
// hardcoded monospace stack). Part of the resolved theme so a host can override.
const DEFAULT_UNKNOWN_BLOCK_FONT =
  "12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

/** Is `v` a plain object we should recurse into for a deep merge? */
function isMergeableObject(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    // Treat class instances / exotic objects as leaves.
    (Object.getPrototypeOf(v) === Object.prototype ||
      Object.getPrototypeOf(v) === null)
  );
}

/**
 * Deep-merge `override` onto `base`, recursing into plain objects and replacing
 * everything else (primitives, arrays) wholesale. Returns a new object; never
 * mutates the inputs.
 */
function deepMerge<T>(base: T, override: DeepPartial<T> | undefined): T {
  if (override === undefined) return base;
  if (!isMergeableObject(base) || !isMergeableObject(override)) {
    // Override is a leaf (or replaces a non-object) — take it as-is.
    return override as unknown as T;
  }
  const out: Record<string, unknown> = { ...base };
  for (const key of Object.keys(override)) {
    const o = (override as Record<string, unknown>)[key];
    if (o === undefined) continue;
    out[key] = deepMerge((base as Record<string, unknown>)[key], o as never);
  }
  return out as unknown as T;
}

/**
 * Merge two themes (e.g. for `setTheme`): later wins, deep-merging `styles` and
 * shallow-merging `tokens` / `fonts.families` / `strings`. `fontFamily` from the
 * patch wins when present (including an explicit `null`).
 */
export function mergeTheme(base: EditorTheme, patch: EditorTheme): EditorTheme {
  return {
    tokens: { ...base.tokens, ...patch.tokens },
    styles: deepMerge(
      (base.styles ?? {}) as DeepPartial<EditorStyles>,
      patch.styles as DeepPartial<EditorStyles> | undefined,
    ),
    fonts:
      base.fonts || patch.fonts
        ? {
            families: { ...base.fonts?.families, ...patch.fonts?.families },
            defaultFamily:
              patch.fonts?.defaultFamily ?? base.fonts?.defaultFamily,
          }
        : undefined,
    fontFamily: "fontFamily" in patch ? patch.fontFamily : base.fontFamily,
    strings: { ...base.strings, ...patch.strings },
    nodeStrings: mergeNodeStrings(base.nodeStrings, patch.nodeStrings),
  };
}

/** Per-type merge of {@link EditorTheme.nodeStrings} (patch keys win within a
 *  type; sibling keys/types are preserved). Returns `undefined` when neither
 *  side has overrides, so the field stays absent on a bare theme. */
function mergeNodeStrings(
  base: EditorTheme["nodeStrings"],
  patch: EditorTheme["nodeStrings"],
): EditorTheme["nodeStrings"] {
  if (!base && !patch) return undefined;
  const out: Record<string, Record<string, string>> = {};
  for (const type of Object.keys(base ?? {})) out[type] = { ...base![type] };
  for (const type of Object.keys(patch ?? {})) {
    out[type] = { ...out[type], ...patch![type] };
  }
  return out;
}

/**
 * Resolve the per-instance node string table: for each registered node that
 * ships a `strings` catalog, its English defaults overlaid with
 * `theme.nodeStrings[type]`. Stored on `EditorState.resolvedNodeStrings` and
 * read by nodes via their `str(state, key)` helper. Per-instance (takes the
 * editor's own registry + theme), so two editors localize independently — no
 * module global, no mutation of the shared node singletons.
 */
export function resolveNodeStrings(
  nodes: NodeRegistry,
  theme: EditorTheme = {},
): NodeStringsMap {
  const out = new Map<string, Readonly<Record<string, string>>>();
  for (const node of nodes.nodeList()) {
    if (!node.strings) continue;
    const overrides = theme.nodeStrings?.[node.type] ?? {};
    out.set(node.type, { ...node.strings, ...overrides });
  }
  return out;
}

/**
 * Resolve a host {@link EditorTheme} into the full {@link EditorStyles} the
 * renderer/layout/hit-test paths read. Layers, in order: neutral token defaults
 * → `theme.tokens` → structural defaults built from those tokens →
 * `theme.styles` deep-partial overrides. No DOM access, no globals — pure.
 *
 * The two genuinely view-dependent values (mobile horizontal padding and the
 * window-focus selection color) are NOT decided here; `getEditorStyles` applies
 * them per render. This function fills the resolved fields with their
 * focused / desktop variants.
 */
export function resolveTheme(theme: EditorTheme = {}): EditorStyles {
  const t: ThemeTokens = { ...DEFAULT_TOKENS, ...theme.tokens };
  const strings: EditorStrings = { ...DEFAULT_STRINGS, ...theme.strings };
  // Font registry: this instance's `theme.fonts` layered over the neutral
  // system default. Per-instance — no module global.
  const fonts: FontStyles = {
    families: { ...DEFAULT_FONT_STYLES.families, ...theme.fonts?.families },
    defaultFamily:
      theme.fonts?.defaultFamily ?? DEFAULT_FONT_STYLES.defaultFamily,
  };

  const base: EditorStyles = {
    canvas: {
      paddingTop: 4,
      paddingBottom: 80,
      // Horizontal padding is overlaid per-render (mobile vs desktop); this is
      // the desktop default used when nothing is overridden.
      paddingLeft: DESKTOP_HORIZONTAL_PADDING,
      paddingRight: DESKTOP_HORIZONTAL_PADDING,
      lineHeight: 1.6,
    },
    fonts,
    fontFamily: theme.fontFamily ?? null,
    blocks: {
      heading1: {
        fontSize: 32,
        fontWeight: "500",
        color: t.heading,
        lineHeight: 1.4,
        paddingBottom: 10,
      },
      heading2: {
        fontSize: 24,
        fontWeight: "500",
        color: t.heading,
        lineHeight: 1.4,
        paddingBottom: 10,
      },
      heading3: {
        fontSize: 20,
        fontWeight: "500",
        color: t.heading,
        lineHeight: 1.4,
        paddingBottom: 10,
      },
      paragraph: {
        fontSize: 16,
        fontWeight: "normal",
        color: t.text,
        lineHeight: 1.6,
        paddingBottom: 12,
      },
      bulletList: {
        fontSize: 16,
        fontWeight: "normal",
        color: t.text,
        lineHeight: 1.6,
        paddingBottom: 6,
      },
      numberedList: {
        fontSize: 16,
        fontWeight: "normal",
        color: t.text,
        lineHeight: 1.6,
        paddingBottom: 6,
      },
      todoList: {
        fontSize: 16,
        fontWeight: "normal",
        color: t.text,
        lineHeight: 1.6,
        paddingBottom: 6,
      },
      code: {
        fontSize: 14,
        fontWeight: "normal",
        // Neutral base color for un-highlighted/plain code (punctuation,
        // operators, identifiers). Token kinds override it via `syntax`.
        color: t.foreground,
        lineHeight: 1.5,
        // Bottom inset INSIDE the background box (mirrors paddingTop). The
        // block's trailing flow gap is added on top of this by the node.
        paddingBottom: 12,
        backgroundColor: t.codeBackground,
        borderRadius: 6,
        paddingTop: 12,
        paddingX: 14,
        syntax: {
          keyword: t.codeKeyword,
          string: t.codeString,
          comment: t.codeComment,
          number: t.codeNumber,
          function: t.codeFunction,
        },
      },
      quote: {
        fontSize: 18,
        fontWeight: "normal",
        color: t.text,
        lineHeight: 1.65,
        paddingBottom: 18,
        backgroundColor: t.muted,
        backgroundOpacity: 0.58,
        accentColor: t.primary,
        accentWidth: 4,
        accentGap: 18,
        borderRadius: 10,
        paddingX: 16,
        paddingY: 18,
        joinedPaddingY: 7,
        // The quote's editorial 18px body is too large for its long ghost hint
        // on narrow screens, so the placeholder renders at 0.8× (was baked into
        // QuoteNode; now a theme leaf).
        placeholder: { fontScale: 0.8 },
      },
      line: {
        height: 32, // Total block height
        lineHeight: 1, // Thickness of the line
        color: t.border,
        paddingTop: 16,
        paddingBottom: 16,
      },
      image: {
        placeholder: {
          backgroundColor: t.muted,
          textColor: t.mutedForeground,
          borderColor: t.border,
        },
        loading: {
          backgroundColor: t.muted,
          textColor: t.mutedForeground,
        },
        uploading: {
          backgroundColor: t.muted,
          textColor: t.mutedForeground,
        },
        error: {
          backgroundColor: t.destructive,
          textColor: t.destructiveForeground,
        },
        hover: {
          overlayColor: t.coverImageOverlay,
          buttonBackgroundColor: t.background,
          buttonTextColor: t.foreground,
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
        hoverBackgroundColor: t.muted,
        hoverBorderRadius: 6,
        // Stronger than the base 0.2 text selection: the highlight is composited
        // over the equation's own filled card surface, not the plain document
        // background, so it needs more presence to read as clearly as a text
        // selection does.
        selectionOpacity: 0.4,
        errorBackgroundColor: t.mathErrorBackground,
        placeholder: {
          backgroundColor: t.muted,
          textColor: t.mutedForeground,
          // Absolute ghost-text size/weight (was baked into MathNode).
          fontSize: 14,
          fontWeight: "400",
        },
      },
    },
    cursor: {
      width: 2,
      color: t.cursor,
      blinkInterval: 530,
      landingDuration: 190,
      landingRadius: 6,
      handleRadius: 5,
      handleStemHeight: 3,
    },
    remoteCursor: {
      // Same 2px as the local caret by default; overridable to make peer carets
      // thicker/thinner independently.
      caretWidth: 2,
      labelTextColor: t.remoteCursorLabelText,
      labelFontSize: 10,
      labelPadding: 2,
      labelBorderRadius: 2,
      labelGap: 2,
      labelIconSize: 12,
      labelIconGap: 3,
      // Defaults reproduce the historical pill geometry; the inset* fields are 0
      // so positions match the pre-theming behavior until a host overrides them
      // (e.g. to clear a mobile safe area).
      outOfViewIndicator: {
        insetInlineStart: 0,
        insetTop: 0,
        insetBottom: 0,
        pillHeight: 24,
        pillPadding: 8,
        fontSize: 12,
        chevronSize: 6,
        gap: 8,
        edgeMargin: 4,
        initialFontWeight: "600",
      },
    },
    selection: {
      // Focused variant; `getEditorStyles` swaps in `unfocusedBackgroundColor`
      // when the window is blurred (desktop).
      backgroundColor: t.selection,
      unfocusedBackgroundColor: t.selectionUnfocused,
      opacity: 0.2,
      remoteOpacity: 0.2,
      cornerRadius: 0,
      handles: {
        size: 12, // Diameter of the handle circle
        color: t.selection,
        touchTargetSize: 44, // Larger touch target for easier interaction
        stemHeight: 8, // Height of the vertical stem
        stemWidth: 2, // Width of the stem
      },
    },
    placeholder: {
      heading1: { text: strings.placeholderHeading1 },
      heading2: { text: strings.placeholderHeading2 },
      heading3: { text: strings.placeholderHeading3 },
      paragraph: {
        keyboardCompatibleText: strings.placeholderParagraph,
        touchCompatiableText: strings.placeholderParagraphTouch,
      },
      listItem: { text: strings.placeholderListItem },
      todoItem: { text: strings.placeholderTodoItem },
      math: { text: strings.placeholderMath },
      color: t.placeholder,
      showUnfocused: false,
    },
    textFormats: {
      code: {
        backgroundColor: t.codeBackground,
        color: t.codeText,
        padding: 2,
        borderRadius: 3,
      },
      link: {
        color: t.link,
        underlineThickness: 1,
        hoverColor: t.linkHover,
      },
      inlineMath: {
        backgroundColor: t.codeBackground,
        hoverBackgroundColor: t.muted,
        color: t.codeText,
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
          backgroundColor: t.mutedForeground,
          hoverBackgroundColor: t.primary,
          opacity: 1, // Hidden by default
          hoverOpacity: 1, // Visible on hover
          inset: 16, // Distance from the edge (0 = at the edge, positive = inside)
        },
        // Horizontal bar (bottom) - for vertical resize
        horizontal: {
          length: 200, // Width of the horizontal drag bar
          thickness: 6, // Thickness of the horizontal drag bar
          borderRadius: 3, // Rounded corners (0 = sharp)
          backgroundColor: t.mutedForeground,
          hoverBackgroundColor: t.primary,
          opacity: 1, // Hidden by default
          hoverOpacity: 1, // Visible on hover
          inset: 16, // Distance from the edge (0 = at the edge, positive = inside)
        },
      },
      outline: {
        color: t.primary,
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
        color: t.text,
        size: 16,
      },
      numbered: {
        color: t.text,
        minWidth: 24, // Space reserved for number display
      },
      todo: {
        checkboxSize: 16,
        checkboxBorderColor: t.border,
        checkboxCheckedColor: t.primary,
        checkboxBorderRadius: 3,
        checkmarkColor: t.primaryForeground,
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
    scrollbar: {
      // Colors come from tokens…
      trackColor: t.scrollbarTrack,
      thumbColor: t.scrollbarThumb,
      thumbHoverColor: t.scrollbarThumbHover,
      thumbActiveColor: t.scrollbarThumbActive,
      // …geometry/timing from neutral defaults (formerly hardcoded in
      // scrollbar.ts). All overridable via `theme.styles.scrollbar`. `width` is
      // the desktop default; touch devices narrow it in `getScrollbarStyles`
      // unless the host sets it explicitly.
      width: 12,
      minThumbHeight: 40,
      padding: 4,
      borderRadius: 6,
      fadeDelay: 1000,
      fadeDuration: 300,
      touchTargetWidth: 32,
    },
    unknownBlock: {
      backgroundColor: t.unknownBlockBackground,
      borderColor: t.unknownBlockBorder,
      textColor: t.unknownBlockText,
      fontFamily: DEFAULT_UNKNOWN_BLOCK_FONT,
    },
  };

  return theme.styles ? deepMerge<EditorStyles>(base, theme.styles) : base;
}

/**
 * The fully-resolved styles for an instance, plus the two view-dependent
 * overlays the resolved theme can't bake in:
 *   1. horizontal page padding — tighter on mobile, unless explicitly set;
 *   2. selection color — dimmed when the browser window is blurred (desktop).
 *
 * Every render/layout/hit-test path passes `state`, reading the pre-resolved
 * `state.resolvedStyles` (no `getComputedStyle`, no globals). Omitting `state`
 * yields the neutral defaults — used only by stateless hit-test/geometry
 * helpers and the `defaultStyles` snapshot.
 */
export function getEditorStyles(state?: EditorState): EditorStyles {
  const resolved = state?.resolvedStyles ?? defaultStyles;

  // Window focus defaults to true when unknown so selection renders focused.
  const isFocused = state?.view.isFocused ?? true;
  const useFocusedSelection = isFocused || isTouchDevice();

  // Horizontal padding: explicit override (legacy `padding` option or
  // `theme.styles.canvas.padding*`, both folded into `theme.styles.canvas`)
  // wins on every viewport; otherwise mobile gets tighter gutters.
  const explicitCanvas = state?.theme.styles?.canvas;
  const isMobile = typeof window !== "undefined" && window.innerWidth < 768;
  const horizontalDefault = isMobile
    ? MOBILE_HORIZONTAL_PADDING
    : DESKTOP_HORIZONTAL_PADDING;
  const paddingLeft = explicitCanvas?.paddingLeft ?? horizontalDefault;
  const paddingRight = explicitCanvas?.paddingRight ?? horizontalDefault;

  // Fast path: focused + no horizontal change needed.
  if (
    useFocusedSelection &&
    resolved.canvas.paddingLeft === paddingLeft &&
    resolved.canvas.paddingRight === paddingRight
  ) {
    return resolved;
  }

  return {
    ...resolved,
    canvas: { ...resolved.canvas, paddingLeft, paddingRight },
    selection: useFocusedSelection
      ? resolved.selection
      : {
          ...resolved.selection,
          backgroundColor: resolved.selection.unfocusedBackgroundColor,
        },
  };
}

// Neutral resolved defaults (no host theme). Used by stateless callers and as
// the base for the per-render overlay above.
export const defaultStyles: EditorStyles = resolveTheme();

/**
 * Resolve the base text style for a textual block, delegating to the node's own
 * {@link Node.textStyle} facet so the core never enumerates built-in block
 * types. The block→theme-key mapping (e.g. `bullet_list` → `bulletList`) and any
 * borrowing (math borrows paragraph) live on each node. Unknown/unregistered
 * types fall back to the paragraph style.
 */
export function getTextStyle(
  styles: EditorStyles,
  nodes: NodeRegistry,
  block: Block,
): TextStyle {
  const base =
    nodes.get(block.type)?.textStyle(styles, block.type) ??
    styles.blocks.paragraph;
  return mergeBlockStyle(base, block.style);
}

export function applyTextStyle(
  ctx: CanvasRenderingContext2D,
  style: TextStyle,
  styles: EditorStyles,
) {
  const fontStack = getFontStack(currentFontFamily(styles), styles.fonts);
  ctx.font = `${style.fontWeight} ${style.fontSize}px ${fontStack}`;
  ctx.fillStyle = style.color;
  ctx.textBaseline = "alphabetic";
}
