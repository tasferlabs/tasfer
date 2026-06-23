import React, { createContext, useContext, useState, useCallback } from "react";
import { invariant } from "@shared/invariant";
import type { FontFamily } from "@cypherkit/editor";
import useLocalStorage from "../hooks/useLocalStorage";
import type { CursorUser } from "@cypherkit/provider-core/cursors";
import type { Block } from "@cypherkit/editor";

export type FontStyle = "default" | "serif";

export type PagePermission = "view" | "edit" | "owner";

interface PageSettingsContextType {
  fontStyle: FontStyle;
  setFontStyle: (style: FontStyle) => void;
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

export const PageSettingsProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [fontStyle, setFontStyleState] = useLocalStorage<FontStyle>("pageSettings.fontStyle", "default");
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

