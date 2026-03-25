/**
 * Native Bridge — CypherBridge
 *
 * Both iOS and Android inject `window.CypherBridge` with the same shape.
 * All methods return Promises so consumers never need platform branching.
 *
 * Editor callbacks (undo, redo, toggleBold, etc.) live on a separate
 * `window.CypherEditorCallbacks` object that the web app assigns and
 * native code calls via evaluateJavaScript.
 */

// =============================================================================
// Bridge types
// =============================================================================

export interface CypherBridge {
  clipboard: {
    copy(text: string): Promise<void>;
    cut(text: string): Promise<void>;
    paste(): Promise<string>;
  };

  haptic: {
    trigger(style: "light" | "medium" | "heavy"): Promise<void>;
  };

  editor: {
    setFocused(focused: boolean): Promise<void>;
    updateUndoRedoState(canUndo: boolean, canRedo: boolean): Promise<void>;
    updateToolbarIcon(
      iconType: "link" | "image" | "format" | "none",
    ): Promise<void>;
    updateFormattingState(
      isBold: boolean,
      isItalic: boolean,
      isCode: boolean,
      isStrikethrough: boolean,
    ): Promise<void>;
    setColorScheme(scheme: "light" | "dark"): Promise<void>;
  };

  navigation: {
    openUrl(url: string): Promise<void>;
    openPhotoLibrary(): Promise<void>;
    openCamera(): Promise<void>;
  };

  files: {
    shareFile(
      base64Data: string,
      fileName: string,
      mimeType: string,
    ): Promise<boolean>;
  };

  storage: {
    write(path: string, base64Data: string): Promise<boolean>;
    read(path: string): Promise<string | null>;
    delete(path: string): Promise<boolean>;
    list(path: string): Promise<string[]>;
    exists(path: string): Promise<boolean>;
    getInfo(): Promise<{ free: number; total: number }>;
  };
}

export interface CypherEditorCallbacks {
  undo?: () => void;
  redo?: () => void;
  setBlockType?: (type: string) => void;
  focus?: () => void;
  onFormatButtonClick?: () => boolean;
  toggleBold?: () => void;
  toggleItalic?: () => void;
  toggleCode?: () => void;
  toggleStrikethrough?: () => void;
}

// =============================================================================
// Global augmentation
// =============================================================================

declare global {
  interface Window {
    CypherBridge?: CypherBridge;
    CypherEditorCallbacks?: CypherEditorCallbacks;
  }
}

// =============================================================================
// Helpers
// =============================================================================

/** Returns the CypherBridge if running inside a native shell, or null on web. */
export function getBridge(): CypherBridge | null {
  return typeof window !== "undefined" ? (window.CypherBridge ?? null) : null;
}

/** True when running inside a native iOS/Android shell. */
export function isNative(): boolean {
  return !!getBridge();
}
