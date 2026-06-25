/**
 * Native Bridge — CypherBridge
 *
 * Both iOS and Android inject `window.CypherBridge` with the same shape.
 * All methods return Promises so consumers never need platform branching.
 *
 * Editor callbacks (undo, redo, toggleStrong, etc.) live on a separate
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
    setColorScheme(scheme: "light" | "dark"): Promise<void>;
    /** Atomically clear native WebView focus and hide the Android IME. */
    dismissKeyboard?(): Promise<void>;
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
    /**
     * Render HTML to a PDF using the native WebView. Returns base64-encoded
     * PDF bytes, or null if the platform doesn't support it.
     * Optional — older shells may not implement it.
     */
    htmlToPdf?(html: string): Promise<string | null>;
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
  toggleStrong?: () => void;
  toggleEmphasis?: () => void;
  toggleCode?: () => void;
  toggleStrike?: () => void;
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

/**
 * Fire device haptic feedback from host UI (sidebar, calendar, context menus).
 * Uses the native shell's haptic when present, else the web Vibration API.
 */
export function triggerHaptic(
  style: "light" | "medium" | "heavy" = "heavy",
): void {
  try {
    const bridge = getBridge();
    if (bridge) {
      void bridge.haptic.trigger(style);
      return;
    }
    if (typeof navigator !== "undefined" && "vibrate" in navigator) {
      const duration = style === "light" ? 10 : style === "medium" ? 20 : 50;
      navigator.vibrate(duration);
    }
  } catch (e) {
    console.debug("Haptic feedback not supported:", e);
  }
}
