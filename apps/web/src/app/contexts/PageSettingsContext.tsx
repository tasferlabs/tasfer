import React, { createContext, useContext, useState, useCallback } from "react";
import { invariant } from "@shared/invariant";
import type { FontFamily } from "@cypherkit/editor";
import useLocalStorage from "../hooks/useLocalStorage";
import type { CursorUser } from "@cypherkit/provider-core/cursors";
import type { Block } from "@cypherkit/editor";

export type FontStyle = "default" | "serif";

export type EditorWidth = "wide" | "narrow";

export type PagePermission = "view" | "edit" | "owner";

interface PageSettingsContextType {
  fontStyle: FontStyle;
  setFontStyle: (style: FontStyle) => void;
  editorWidth: EditorWidth;
  setEditorWidth: (width: EditorWidth) => void;
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

