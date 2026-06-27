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

import { isTouchDevice } from "@cypherkit/editor/internal";
import type { EditorTheme, ThemeTokens } from "@cypherkit/editor";

/**
 * Image resize drag-handle inset for touch devices, in CSS px (default is 16).
 *
 * At the default inset the left/right handles' touch hit region lands in two
 * danger zones near the viewport edges: the custom scrollbar's 32px touch
 * target (`scrollbar.touchTargetWidth`) on the right, and the Android system
 * back-gesture zone (left/right, up to ~40px at high sensitivity). Pushing the
 * handles further in from the image edge clears both. The engine's hit-test
 * honors this per-instance inset (`getDragHandleAtPoint`), so the grabbable
 * region moves with the painted bar. Desktop keeps the tighter default — a
 * mouse has no edge-gesture or fat-finger scrollbar-target conflict.
 */
const TOUCH_IMAGE_HANDLE_INSET = 40;

/**
 * Touch handles are short, rounded grips rather than the desktop full-length
 * bars (vertical 100px / bottom 200px). At the inset required to clear the edge
 * danger zones, a long bar floats across the middle of the image like a divider;
 * a compact centered grip reads as an intentional resize affordance instead.
 * The engine's hit-test honors these same per-instance styles, so the grab area
 * tracks the painted grip (still comfortably tappable with the 12px touch
 * tolerance the engine adds on each side).
 */
const TOUCH_IMAGE_HANDLE_LENGTH = 48;
const TOUCH_IMAGE_HANDLE_BOTTOM_LENGTH = 64;
/** Slightly translucent so the grips rest lightly over photo content. */
const TOUCH_IMAGE_HANDLE_OPACITY = 0.85;

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

function readTodoCheckboxBorderColor(tokens: Partial<ThemeTokens>): string {
  if (
    typeof document !== "undefined" &&
    document.documentElement.classList.contains("dark")
  ) {
    return "oklch(1 0 0 / 34%)";
  }
  return tokens.border ?? "oklch(0.92 0.004 286.32)";
}

/** Build an `EditorTheme` from the current CSS variables (for `mountEditor`). */
export function cssVarsToTheme(): EditorTheme {
  const tokens = readEditorTokens();
  return {
    tokens,
    styles: {
      list: {
        todo: {
          checkboxBorderColor: readTodoCheckboxBorderColor(tokens),
        },
      },
      // On touch, keep the image resize handles clear of the scrollbar touch
      // target and the platform edge-gesture zone (see TOUCH_IMAGE_HANDLE_INSET),
      // and render them as compact grips rather than full-length bars.
      ...(isTouchDevice()
        ? {
            imageResize: {
              dragHandles: {
                vertical: {
                  inset: TOUCH_IMAGE_HANDLE_INSET,
                  length: TOUCH_IMAGE_HANDLE_LENGTH,
                  opacity: TOUCH_IMAGE_HANDLE_OPACITY,
                },
                horizontal: {
                  length: TOUCH_IMAGE_HANDLE_BOTTOM_LENGTH,
                  opacity: TOUCH_IMAGE_HANDLE_OPACITY,
                },
              },
            },
          }
        : {}),
    },
  };
}
