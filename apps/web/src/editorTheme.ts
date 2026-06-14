/**
 * Host-side bridge: map this app's CSS custom properties to the editor's
 * semantic theme tokens.
 *
 * The `@cypherkit/editor` engine is headless — it never reads the DOM for
 * styling. Appearance is supplied per instance as an `EditorTheme` at mount and
 * updated via `editor.setTheme(...)`. This app drives colors from `--editor-*`
 * (and base `--primary` / `--muted` / …) CSS variables that flip with the
 * `.dark` class, so we read those here and translate them into `ThemeTokens`.
 *
 * Values are passed through verbatim (e.g. `oklch(...)`), exactly as the canvas
 * consumed them before — canvas `fillStyle` accepts them. Variables that aren't
 * defined are omitted, so the editor's neutral defaults apply for those.
 */

import type { EditorTheme, ThemeTokens } from "@cypherkit/editor";

// token key → CSS custom property it reads from.
const TOKEN_VARS: Partial<Record<keyof ThemeTokens, string>> = {
  text: "--editor-text",
  heading: "--editor-heading",
  placeholder: "--editor-placeholder",
  background: "--background",
  foreground: "--foreground",
  border: "--border",
  muted: "--muted",
  mutedForeground: "--muted-foreground",
  primary: "--primary",
  primaryForeground: "--primary-foreground",
  destructive: "--destructive",
  destructiveForeground: "--destructive-foreground",
  cursor: "--editor-cursor",
  selection: "--editor-selection",
  selectionUnfocused: "--editor-selection-unfocused",
  remoteCursorLabelText: "--editor-remote-cursor-label-text",
  codeBackground: "--editor-code-bg",
  codeText: "--editor-code-text",
  link: "--editor-link",
  linkHover: "--editor-link-hover",
  coverImageOverlay: "--editor-cover-image-overlay",
  scrollbarTrack: "--editor-scrollbar-track",
  scrollbarThumb: "--editor-scrollbar-thumb",
  scrollbarThumbHover: "--editor-scrollbar-thumb-hover",
  scrollbarThumbActive: "--editor-scrollbar-thumb-active",
};

/**
 * Read the current `--editor-*` CSS variables off the document root into editor
 * theme tokens. Call after the `.dark` class (or any themed CSS var) changes.
 */
export function readEditorTokens(): Partial<ThemeTokens> {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return {};
  }
  const cs = getComputedStyle(document.documentElement);
  const tokens: Partial<Record<keyof ThemeTokens, string>> = {};
  for (const key of Object.keys(TOKEN_VARS) as (keyof ThemeTokens)[]) {
    const value = cs.getPropertyValue(TOKEN_VARS[key]!).trim();
    if (value) tokens[key] = value;
  }
  return tokens;
}

/** Build an `EditorTheme` from the current CSS variables (for `mountEditor`). */
export function cssVarsToTheme(): EditorTheme {
  return { tokens: readEditorTokens() };
}
