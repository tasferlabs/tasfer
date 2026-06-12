/**
 * Four complete looks for the SAME editor — the payload of this example.
 *
 * Each preset is a full {@link EditorTheme}: the headless styling surface the
 * engine reads. It has three layers, and a "full restyle" uses all of them:
 *
 *   • tokens   — the semantic colour palette. Set a handful (text, heading,
 *                background, primary, selection, link, code…) and every colour
 *                leaf in the resolved style tree re-derives from them. This is
 *                the cheap, high-leverage layer.
 *   • styles   — a DEEP-PARTIAL override of the fully-resolved EditorStyles, for
 *                pixel-level control the palette can't express: font sizes,
 *                line-heights, page padding, the list bullet glyph, code-chip
 *                radius, caret width, and the scrollbar geometry (width, corner
 *                radius, padding — its colours come from the `scrollbar*` tokens).
 *   • fontFamily — which family from the host's font registry (fonts.ts) to
 *                  measure and paint with. Typography is half the personality.
 *   • strings  — the canvas placeholder copy, themed for flavour.
 *
 * ── The one sharp edge: setTheme() MERGES, it does not replace ──────────────
 * `editor.setTheme(patch)` deep-merges `patch` onto the theme already in effect
 * (see styles.ts → mergeTheme). So if theme A sets `list.bullet.character` and
 * theme B omits it, switching A→B would LEAVE A's bullet in place. To switch
 * cleanly between presets, every preset here specifies the SAME set of leaves —
 * so applying any one of them fully overwrites whichever came before. Keep that
 * invariant if you add a theme: vary the values, not the shape.
 *
 * The editor canvas itself clears to *transparent* (the renderer never paints a
 * page background), so the reading surface behind the text is the HOST's job —
 * that's what `chrome` carries: the colours main.ts pushes onto the page around
 * the canvas so the whole UI restyles, not just the glyphs.
 */
import type { EditorTheme } from "@cypherkit/editor";

export interface Theme {
  /** Stable id (persisted in localStorage, used for the button ids). */
  readonly id: string;
  /** Human label for the switcher + status bar. */
  readonly label: string;
  /** A one-line description of the vibe, shown in the status bar. */
  readonly blurb: string;
  /**
   * Host-side chrome colours. The editor canvas is transparent, so these drive
   * the page *around* and *behind* it (body, the editor "card", toolbar, the
   * `--accent` used by the active-button highlight). main.ts writes them to CSS
   * variables; they are NOT part of the editor theme.
   */
  readonly chrome: {
    readonly background: string;
    readonly surface: string;
    readonly text: string;
    readonly muted: string;
    readonly accent: string;
  };
  /** The editor-side theme handed to `setTheme` (tokens + styles + font + copy). */
  readonly editor: EditorTheme;
}

export const THEMES: readonly Theme[] = [
  // ── Aurora — clean, airy, indigo. A modern docs default. ──────────────────
  {
    id: "aurora",
    label: "Aurora",
    blurb: "Humanist sans · indigo accent · roomy spacing",
    chrome: {
      background: "#eef1f6",
      surface: "#ffffff",
      text: "#2b3040",
      muted: "#6b7280",
      accent: "#5b5bd6",
    },
    editor: {
      fontFamily: "sans",
      strings: { placeholderParagraph: "Start writing…" },
      tokens: {
        text: "#2b3040",
        heading: "#14161f",
        placeholder: "#aab0bd",
        background: "#ffffff",
        foreground: "#2b3040",
        border: "#e6e8ee",
        muted: "#f0f1f6",
        mutedForeground: "#6b7280",
        primary: "#5b5bd6",
        primaryForeground: "#ffffff",
        cursor: "#5b5bd6",
        selection: "#5b5bd6",
        link: "#4f46e5",
        linkHover: "#4338ca",
        codeBackground: "#f0f1f6",
        codeText: "#d6336c",
        scrollbarThumb: "rgba(91,91,214,0.35)",
        scrollbarThumbHover: "rgba(91,91,214,0.55)",
        scrollbarThumbActive: "rgba(91,91,214,0.75)",
      },
      styles: {
        canvas: {
          paddingTop: 48,
          paddingBottom: 140,
          paddingLeft: 28,
          paddingRight: 28,
          lineHeight: 1.7,
        },
        blocks: {
          heading1: { fontSize: 34, fontWeight: "600", lineHeight: 1.3, paddingBottom: 12 },
          heading2: { fontSize: 26, fontWeight: "600", paddingBottom: 10 },
          heading3: { fontSize: 20, fontWeight: "600", paddingBottom: 8 },
          paragraph: { fontSize: 17, lineHeight: 1.75, paddingBottom: 14 },
          bulletList: { fontSize: 17, lineHeight: 1.7, paddingBottom: 6 },
          numberedList: { fontSize: 17, lineHeight: 1.7, paddingBottom: 6 },
          todoList: { fontSize: 17, lineHeight: 1.7, paddingBottom: 6 },
        },
        list: { bullet: { character: "•", size: 17 }, todo: { checkboxBorderRadius: 4 } },
        textFormats: { code: { padding: 3, borderRadius: 5 } },
        cursor: { width: 2 },
        // Geometry is themeable too — a soft, rounded, slightly inset scrollbar.
        scrollbar: { width: 12, borderRadius: 6, padding: 6 },
      },
    },
  },

  // ── Manuscript — warm paper, serif, book-like measure. A reading view. ─────
  {
    id: "manuscript",
    label: "Manuscript",
    blurb: "Old-style serif · warm paper · generous leading",
    chrome: {
      background: "#ece3cf",
      surface: "#fbf8f0",
      text: "#423a2b",
      muted: "#8a7e64",
      accent: "#8a6d3b",
    },
    editor: {
      fontFamily: "serif",
      strings: { placeholderParagraph: "Once upon a time…" },
      tokens: {
        text: "#423a2b",
        heading: "#2c2519",
        placeholder: "#b8ac93",
        background: "#fbf8f0",
        foreground: "#423a2b",
        border: "#e3dcc8",
        muted: "#efe9d8",
        mutedForeground: "#8a7e64",
        primary: "#8a6d3b",
        primaryForeground: "#fbf8f0",
        cursor: "#8a6d3b",
        selection: "#c9a24a",
        link: "#9a5b2c",
        linkHover: "#7a4520",
        codeBackground: "#efe7d2",
        codeText: "#8a5a2b",
        scrollbarThumb: "rgba(138,109,59,0.35)",
        scrollbarThumbHover: "rgba(138,109,59,0.55)",
        scrollbarThumbActive: "rgba(138,109,59,0.75)",
      },
      styles: {
        canvas: {
          paddingTop: 56,
          paddingBottom: 160,
          paddingLeft: 40,
          paddingRight: 40,
          lineHeight: 1.85,
        },
        blocks: {
          heading1: { fontSize: 36, fontWeight: "600", lineHeight: 1.3, paddingBottom: 14 },
          heading2: { fontSize: 27, fontWeight: "600", paddingBottom: 12 },
          heading3: { fontSize: 21, fontWeight: "600", paddingBottom: 9 },
          paragraph: { fontSize: 18, lineHeight: 1.9, paddingBottom: 16 },
          bulletList: { fontSize: 18, lineHeight: 1.8, paddingBottom: 8 },
          numberedList: { fontSize: 18, lineHeight: 1.8, paddingBottom: 8 },
          todoList: { fontSize: 18, lineHeight: 1.8, paddingBottom: 8 },
        },
        // Em-dash bullets are a classic print touch.
        list: { bullet: { character: "—", size: 18 }, todo: { checkboxBorderRadius: 2 } },
        textFormats: { code: { padding: 3, borderRadius: 4 } },
        cursor: { width: 2 },
        // Slim and tucked further into the margin, to match the airy page.
        scrollbar: { width: 10, borderRadius: 5, padding: 10 },
      },
    },
  },

  // ── Midnight — dark, cyan accent. The dark-mode toggle, as a full theme. ───
  {
    id: "midnight",
    label: "Midnight",
    blurb: "Dark surface · cyan accent · compact sans",
    chrome: {
      background: "#0a0e14",
      surface: "#11161d",
      text: "#c4ccd6",
      muted: "#8b95a5",
      accent: "#39c5cf",
    },
    editor: {
      fontFamily: "sans",
      strings: { placeholderParagraph: "// start typing" },
      tokens: {
        text: "#c4ccd6",
        heading: "#f0f4f8",
        placeholder: "#586173",
        background: "#11161d",
        foreground: "#c4ccd6",
        border: "#232a35",
        muted: "#1a212b",
        mutedForeground: "#8b95a5",
        primary: "#39c5cf",
        primaryForeground: "#07181a",
        cursor: "#39c5cf",
        selection: "#39c5cf",
        link: "#58c7ff",
        linkHover: "#8ad7ff",
        codeBackground: "#1c2430",
        codeText: "#ff7b9c",
        scrollbarThumb: "rgba(57,197,207,0.35)",
        scrollbarThumbHover: "rgba(57,197,207,0.55)",
        scrollbarThumbActive: "rgba(57,197,207,0.75)",
      },
      styles: {
        canvas: {
          paddingTop: 44,
          paddingBottom: 140,
          paddingLeft: 28,
          paddingRight: 28,
          lineHeight: 1.65,
        },
        blocks: {
          heading1: { fontSize: 33, fontWeight: "600", lineHeight: 1.25, paddingBottom: 12 },
          heading2: { fontSize: 25, fontWeight: "600", paddingBottom: 10 },
          heading3: { fontSize: 20, fontWeight: "600", paddingBottom: 8 },
          paragraph: { fontSize: 16.5, lineHeight: 1.7, paddingBottom: 13 },
          bulletList: { fontSize: 16.5, lineHeight: 1.65, paddingBottom: 6 },
          numberedList: { fontSize: 16.5, lineHeight: 1.65, paddingBottom: 6 },
          todoList: { fontSize: 16.5, lineHeight: 1.65, paddingBottom: 6 },
        },
        list: { bullet: { character: "▸", size: 14 }, todo: { checkboxBorderRadius: 4 } },
        textFormats: { code: { padding: 3, borderRadius: 5 } },
        cursor: { width: 2 },
        scrollbar: { width: 12, borderRadius: 6, padding: 4 },
      },
    },
  },

  // ── Terminal — phosphor green, monospace, sharp corners, block caret. ──────
  {
    id: "terminal",
    label: "Terminal",
    blurb: "Monospace · phosphor green · sharp + chunky caret",
    chrome: {
      background: "#050805",
      surface: "#080d08",
      text: "#74e89a",
      muted: "#4f9c66",
      accent: "#36ff7a",
    },
    editor: {
      fontFamily: "mono",
      strings: { placeholderParagraph: "$ type to begin" },
      tokens: {
        text: "#74e89a",
        heading: "#aeffc4",
        placeholder: "#2f6b41",
        background: "#080d08",
        foreground: "#74e89a",
        border: "#143018",
        muted: "#0d180d",
        mutedForeground: "#4f9c66",
        primary: "#36ff7a",
        primaryForeground: "#041007",
        cursor: "#36ff7a",
        selection: "#36ff7a",
        link: "#57ffd0",
        linkHover: "#9bffe6",
        codeBackground: "#0f1f12",
        codeText: "#ffd479",
        scrollbarThumb: "rgba(54,255,122,0.30)",
        scrollbarThumbHover: "rgba(54,255,122,0.50)",
        scrollbarThumbActive: "rgba(54,255,122,0.70)",
      },
      styles: {
        canvas: {
          paddingTop: 36,
          paddingBottom: 120,
          paddingLeft: 24,
          paddingRight: 24,
          lineHeight: 1.55,
        },
        blocks: {
          heading1: { fontSize: 28, fontWeight: "700", lineHeight: 1.2, paddingBottom: 10 },
          heading2: { fontSize: 22, fontWeight: "700", paddingBottom: 8 },
          heading3: { fontSize: 18, fontWeight: "700", paddingBottom: 6 },
          paragraph: { fontSize: 15, lineHeight: 1.6, paddingBottom: 12 },
          bulletList: { fontSize: 15, lineHeight: 1.55, paddingBottom: 5 },
          numberedList: { fontSize: 15, lineHeight: 1.55, paddingBottom: 5 },
          todoList: { fontSize: 15, lineHeight: 1.55, paddingBottom: 5 },
        },
        // A caret-shaped bullet, square checkboxes, square code chips, and a fat
        // block caret — the whole personality leans on `styles`, not colour.
        list: { bullet: { character: ">", size: 15 }, todo: { checkboxBorderRadius: 0 } },
        textFormats: { code: { padding: 2, borderRadius: 0 } },
        cursor: { width: 8 },
        // Chunky and SQUARE — the scrollbar gets the same sharp-edged treatment.
        scrollbar: { width: 14, borderRadius: 0, padding: 2 },
      },
    },
  },
];

/** Look up a theme by id, falling back to the first preset. */
export function themeById(id: string | null): Theme {
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}
