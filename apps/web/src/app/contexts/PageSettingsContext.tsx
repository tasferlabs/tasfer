import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
} from "react";
import { invariant } from "@shared/invariant";
import { resolveTheme, type EditorTheme, type FontFamily } from "@cypherkit/editor";
import useLocalStorage from "../hooks/useLocalStorage";
import type { CursorUser } from "@cypherkit/provider-core/cursors";
import type { Block } from "@cypherkit/editor";

export type FontStyle = "default" | "serif";

export type EditorWidth = "wide" | "narrow";

/**
 * Display-density scale — a global UI scale factor. It resizes the whole app by
 * rescaling the root `rem` (see {@link applyDensityToRoot}), and rescales the
 * headless editor canvas (which sizes in px, not rem) by the same factor (see
 * {@link editorThemeForDensity}). The seven stops mirror the settings slider:
 * 0.7× (dense) … 1.0× (default) … 1.3× (spacious). Stored as the raw multiplier
 * so the readout ("1.0×"), the root rem, and the canvas scale share one value.
 */
export const DENSITY_STOPS = [0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.3] as const;
export const DEFAULT_DENSITY = 1;

// The browser default root font size (px) that `rem` resolves against. Density
// scales this so every rem-based dimension in the app grows/shrinks in step.
const BASE_ROOT_FONT_SIZE = 16;

/**
 * Drive the app-wide layout scale by setting the root `font-size` (the px value
 * `rem` is relative to). This is a document-level appearance toggle — like the
 * `.dark` class the theme puts on `<html>` — not per-editor state, so it lives
 * on `document.documentElement`. At 1× we clear the override so the browser /
 * user default wins.
 */
export const applyDensityToRoot = (density: number): void => {
  const root = document.documentElement;
  if (density === DEFAULT_DENSITY) {
    root.style.removeProperty("font-size");
  } else {
    root.style.fontSize = `${BASE_ROOT_FONT_SIZE * density}px`;
  }
};

// Flow-text blocks the canvas scale resizes. The horizontal rule (`line`) and
// non-text blocks (image, math) are excluded — they carry no `fontSize`.
const DENSITY_SCALED_BLOCKS = [
  "heading1",
  "heading2",
  "heading3",
  "paragraph",
  "bulletList",
  "numberedList",
  "todoList",
  "quote",
  "code",
] as const;

// The engine's default block styles, resolved once. The density scale multiplies
// these engine numbers rather than duplicating them here, so the two can't drift.
const BASE_BLOCK_STYLES = resolveTheme().blocks;

/**
 * A theme patch that scales the editor canvas by `density` to match the rem
 * scale applied to the rest of the app. The canvas is headless and sizes in px,
 * so rem changes don't reach it — instead each flow-text block's `fontSize` and
 * inter-block gap are multiplied (unitless `lineHeight` rides on `fontSize`, so
 * it needs no separate scaling). Applied per editor instance via
 * `editor.setTheme(...)`, the same headless path used for font family and width;
 * `setTheme` deep-merges, so this rides alongside those patches and reflows the
 * canvas without a re-mount.
 */
export const editorThemeForDensity = (density: number): EditorTheme => {
  const blocks: Record<string, { fontSize: number; paddingBottom: number }> =
    {};
  for (const key of DENSITY_SCALED_BLOCKS) {
    const base = BASE_BLOCK_STYLES[key];
    blocks[key] = {
      fontSize: base.fontSize * density,
      paddingBottom: base.paddingBottom * density,
    };
  }
  // `blocks` is a DeepPartial<BlockStyles>; the Record shape widens the keys, so
  // assert back to the theme's partial style tree.
  return { styles: { blocks } } as EditorTheme;
};

export type PagePermission = "view" | "edit" | "owner";

interface PageSettingsContextType {
  fontStyle: FontStyle;
  setFontStyle: (style: FontStyle) => void;
  editorWidth: EditorWidth;
  setEditorWidth: (width: EditorWidth) => void;
  density: number;
  setDensity: (density: number) => void;
  isSaving: boolean;
  setIsSaving: (isSaving: boolean) => void;
  showWordCount: boolean;
  setShowWordCount: (show: boolean) => void;
  wordCount: number;
  setWordCount: (count: number) => void;
  activeUsers: CursorUser[];
  setActiveUsers: (users: CursorUser[]) => void;
  // Snapshot restore
  pageId: string | null;
  setPageId: (pageId: string | null) => void;
  currentBlocks: Block[];
  setCurrentBlocks: (blocks: Block[]) => void;
  onRestoreSnapshot: ((blocks: Block[]) => void) | null;
  setOnRestoreSnapshot: (callback: ((blocks: Block[]) => void) | null) => void;
  // Permission
  permission: PagePermission;
  setPermission: (permission: PagePermission) => void;
  // Find in document
  onOpenFind: (() => void) | null;
  setOnOpenFind: (callback: (() => void) | null) => void;
}

const PageSettingsContext = createContext<PageSettingsContextType | undefined>(
  undefined
);

export const fontStyleToFamily = (style: FontStyle): FontFamily => {
  return style === "serif" ? "libre-baskerville" : "poppins";
};

// Target reading-column width (px) for the "narrow" editor-width setting. The
// canvas is headless, so width is expressed as horizontal padding rather than a
// CSS max-width (see horizontalPaddingForWidth).
export const NARROW_CONTENT_WIDTH = 720;
// Mirrors the engine's default horizontal gutters (packages/editor styles.ts).
const WIDE_HORIZONTAL_PADDING = 40;
const MOBILE_HORIZONTAL_PADDING = 16;

/**
 * Symmetric horizontal canvas padding (px) for the selected editor width. The
 * width control is desktop-only, so on narrow (mobile) screens we mirror the
 * engine's small default gutter and ignore the setting. On wide screens "wide"
 * keeps the default gutter while "narrow" centers a fixed reading column,
 * clamped so it never shrinks below the default gutter on smaller containers.
 */
export const horizontalPaddingForWidth = (
  editorWidth: EditorWidth,
  containerWidth: number,
  isWideScreen: boolean,
): number => {
  if (!isWideScreen) return MOBILE_HORIZONTAL_PADDING;
  if (editorWidth === "wide") return WIDE_HORIZONTAL_PADDING;
  return Math.max(
    WIDE_HORIZONTAL_PADDING,
    (containerWidth - NARROW_CONTENT_WIDTH) / 2,
  );
};

export const PageSettingsProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [fontStyle, setFontStyleState] = useLocalStorage<FontStyle>("pageSettings.fontStyle", "default");
  const [editorWidth, setEditorWidthState] = useLocalStorage<EditorWidth>("pageSettings.editorWidth", "narrow");
  const [density, setDensityState] = useLocalStorage<number>("pageSettings.density", DEFAULT_DENSITY);
  const [isSaving, setIsSaving] = useState(false);
  const [showWordCount, setShowWordCountState] = useLocalStorage<boolean>("pageSettings.showWordCount", false);
  const [wordCount, setWordCount] = useState(0);
  const [activeUsers, setActiveUsers] = useState<CursorUser[]>([]);
  // Snapshot restore state
  const [pageId, setPageId] = useState<string | null>(null);
  const [currentBlocks, setCurrentBlocks] = useState<Block[]>([]);
  const [onRestoreSnapshot, setOnRestoreSnapshotState] = useState<((blocks: Block[]) => void) | null>(null);
  const [permission, setPermission] = useState<PagePermission>("owner");
  const [onOpenFind, setOnOpenFindState] = useState<(() => void) | null>(null);

  // The selected family is applied per editor instance: MountedEditor reads
  // `fontStyle` and pushes it via `editor.setTheme({ fontFamily })` (no global).
  const setFontStyle = useCallback((style: FontStyle) => {
    setFontStyleState(style);
  }, [setFontStyleState]);

  // Applied per editor instance: MountedEditor reads `editorWidth` and pushes
  // canvas padding via `editor.setTheme({ styles: { canvas } })` (no global).
  const setEditorWidth = useCallback((width: EditorWidth) => {
    setEditorWidthState(width);
  }, [setEditorWidthState]);

  // Two sinks read `density`: the root rem (applied here, app-wide) and each
  // MountedEditor (which rescales its headless canvas via setTheme).
  const setDensity = useCallback((value: number) => {
    setDensityState(value);
  }, [setDensityState]);

  // Rescale the whole layout by driving the root rem. Runs on mount (restoring a
  // persisted density) and on every change. Document-level, so it's applied here
  // once rather than per editor.
  useEffect(() => {
    applyDensityToRoot(density ?? DEFAULT_DENSITY);
  }, [density]);

  const setShowWordCount = useCallback((show: boolean) => {
    setShowWordCountState(show);
  }, [setShowWordCountState]);

  // Wrap setOnRestoreSnapshot to handle function state properly
  const setOnRestoreSnapshot = useCallback((callback: ((blocks: Block[]) => void) | null) => {
    setOnRestoreSnapshotState(() => callback);
  }, []);

  const setOnOpenFind = useCallback((callback: (() => void) | null) => {
    setOnOpenFindState(() => callback);
  }, []);

  return (
    <PageSettingsContext.Provider
      value={{
        fontStyle: fontStyle ?? "default",
        setFontStyle,
        editorWidth: editorWidth ?? "narrow",
        setEditorWidth,
        density: density ?? DEFAULT_DENSITY,
        setDensity,
        isSaving,
        setIsSaving,
        showWordCount: showWordCount ?? false,
        setShowWordCount,
        wordCount,
        setWordCount,
        activeUsers,
        setActiveUsers,
        pageId,
        setPageId,
        currentBlocks,
        setCurrentBlocks,
        onRestoreSnapshot,
        setOnRestoreSnapshot,
        permission,
        setPermission,
        onOpenFind,
        setOnOpenFind,
      }}
    >
      {children}
    </PageSettingsContext.Provider>
  );
};

export const usePageSettings = (): PageSettingsContextType => {
  const context = useContext(PageSettingsContext);
  invariant(context, "usePageSettings must be used within a PageSettingsProvider");
  return context;
};

